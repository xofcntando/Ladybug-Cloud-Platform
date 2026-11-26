/**
 * Team access — share a bot with other people without sharing a password.
 *
 * A bot belongs to one user (`bot.userId`, the owner). Everyone else who can
 * use it is listed in `bot.members` as `{ userId, role, addedAt, addedBy }`.
 * Invitations live in `db.data.invites` and are redeemed with a one-time token,
 * so an invite link can be sent over chat and stops working once used.
 *
 * Roles are a simple ladder:
 *   owner  — full control: settings, session, start/stop, delete, team
 *   agent  — can read and send, label, take notes, but not change the bot
 *   viewer — read only
 *
 * Nothing here talks to WhatsApp; it is pure access control over the store.
 */
const crypto = require('crypto');
const db = require('./store');
const activity = require('./activity');

const ROLES = ['viewer', 'agent', 'owner'];
const RANK = { viewer: 1, agent: 2, owner: 3 };
const LABEL = { owner: 'Owner', agent: 'Agent', viewer: 'Viewer' };

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week to accept
const MAX_MEMBERS = 25;

const now = () => Date.now();
const token = () => crypto.randomBytes(18).toString('hex');
const cleanEmail = (v) => String(v == null ? '' : v).trim().toLowerCase().slice(0, 160);

function validRole(role) {
  return ROLES.indexOf(String(role || '')) !== -1;
}

/** Rank of a role name; 0 for "no access". */
function rank(role) {
  return RANK[role] || 0;
}

function invites() {
  const d = db.data || {};
  if (!Array.isArray(d.invites)) d.invites = [];
  return d.invites;
}

/** Every member record on a bot, owner included, as stored. */
function rawMembers(bot) {
  if (!bot) return [];
  if (!Array.isArray(bot.members)) bot.members = [];
  return bot.members;
}

/**
 * What `user` may do with `bot`: 'owner' | 'agent' | 'viewer' | null.
 * Admins are treated as owners so support can still get in.
 */
function roleFor(bot, user) {
  if (!bot || !user) return null;
  if (user.isAdmin) return 'owner';
  if (bot.userId === user.id) return 'owner';
  const m = rawMembers(bot).find((x) => x && x.userId === user.id);
  if (!m) return null;
  return validRole(m.role) ? m.role : 'viewer';
}

function can(bot, user, need) {
  return rank(roleFor(bot, user)) >= rank(need || 'viewer');
}

/** Bots this user can open, owned first then shared, newest first within each. */
function botsForUser(user) {
  if (!user) return [];
  const all = db.listBots();
  if (user.isAdmin) return all.slice();
  const owned = all.filter((b) => b.userId === user.id);
  const ownedIds = new Set(owned.map((b) => b.id));
  const shared = all.filter(
    (b) => !ownedIds.has(b.id) && rawMembers(b).some((m) => m && m.userId === user.id)
  );
  return owned.concat(shared);
}

/** The people on a bot, resolved to names. Never leaks password hashes. */
function listMembers(bot) {
  const owner = db.findUserById(bot.userId);
  const out = [];
  if (owner) {
    out.push({
      userId: owner.id,
      username: owner.username,
      email: owner.email || '',
      role: 'owner',
      addedAt: bot.createdAt || null,
      isOwner: true,
    });
  }
  for (const m of rawMembers(bot)) {
    if (!m || !m.userId || m.userId === bot.userId) continue;
    const u = db.findUserById(m.userId);
    if (!u) continue; // account was deleted — drop it from the list, keep the record harmless
    out.push({
      userId: u.id,
      username: u.username,
      email: u.email || '',
      role: validRole(m.role) ? m.role : 'viewer',
      addedAt: m.addedAt || null,
      addedBy: m.addedBy || null,
      isOwner: false,
    });
  }
  return out;
}

/** Pending (unexpired, unaccepted) invites for one bot. */
function listInvites(botId) {
  const t = now();
  return invites()
    .filter((i) => i.botId === botId && !i.acceptedAt && !i.revokedAt && i.expiresAt > t)
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      link: '/#/join?invite=' + i.token,
      invitedBy: i.invitedBy,
    }));
}

function findInviteByToken(tok) {
  const t = now();
  return invites().find(
    (i) => i.token === tok && !i.acceptedAt && !i.revokedAt && i.expiresAt > t
  ) || null;
}

function publicInvite(i) {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    link: '/#/join?invite=' + i.token,
  };
}

/**
 * Create an invitation. Returns { code, body }.
 * The same email can only hold one live invite per bot — re-inviting refreshes it.
 */
function invite(bot, actor, { email, role }) {
  const em = cleanEmail(email);
  const r = String(role || 'viewer');
  if (!em || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
    return { code: 400, body: { error: 'Enter a valid email address.' } };
  }
  if (!validRole(r) || r === 'owner') {
    return { code: 400, body: { error: 'Pick Agent or Viewer. Ownership cannot be handed out by invite.' } };
  }
  if (listMembers(bot).length >= MAX_MEMBERS) {
    return { code: 403, body: { error: `A bot can have up to ${MAX_MEMBERS} people on it.` } };
  }
  const existingUser = db.findUserByEmail(em);
  if (existingUser && existingUser.id === bot.userId) {
    return { code: 400, body: { error: 'That is the owner of this bot.' } };
  }
  if (existingUser && roleFor(bot, existingUser)) {
    return { code: 409, body: { error: `${existingUser.username} is already on this bot.` } };
  }

  // Refresh rather than pile up duplicates.
  const live = invites().find((i) => i.botId === bot.id && i.email === em && !i.acceptedAt && !i.revokedAt);
  if (live) {
    live.token = token();
    live.role = r;
    live.expiresAt = now() + INVITE_TTL_MS;
    live.createdAt = now();
    db.save();
    return { code: 200, body: { ok: true, invite: publicInvite(live), refreshed: true } };
  }

  const rec = {
    id: 'inv_' + crypto.randomBytes(6).toString('hex'),
    token: token(),
    botId: bot.id,
    email: em,
    role: r,
    invitedBy: actor ? actor.id : null,
    createdAt: now(),
    expiresAt: now() + INVITE_TTL_MS,
    acceptedAt: null,
    acceptedBy: null,
    revokedAt: null,
  };
  invites().push(rec);
  db.save();
  activity.log(bot.userId, {
    type: 'security',
    title: `Invited ${em} to ${bot.name}`,
    detail: `Role: ${LABEL[r]}. The invite expires in 7 days.`,
    botId: bot.id,
  });
  return { code: 200, body: { ok: true, invite: publicInvite(rec) } };
}

function revokeInvite(bot, inviteId) {
  const i = invites().find((x) => x.id === inviteId && x.botId === bot.id);
  if (!i || i.acceptedAt) return { code: 404, body: { error: 'Invite not found.' } };
  i.revokedAt = now();
  db.save();
  return { code: 200, body: { ok: true } };
}

/**
 * Redeem an invite for the signed-in user.
 * The invite is bound to the email it was sent to, so a forwarded link does not
 * hand access to a stranger.
 */
function accept(user, tok) {
  const i = findInviteByToken(String(tok || ''));
  if (!i) return { code: 404, body: { error: 'This invite is invalid or has expired. Ask for a new one.' } };
  const bot = db.findBotById(i.botId);
  if (!bot) return { code: 404, body: { error: 'That bot no longer exists.' } };
  const mine = cleanEmail(user.email);
  if (mine && mine !== i.email) {
    return { code: 403, body: { error: `This invite was sent to ${i.email}. Sign in with that address to accept it.` } };
  }
  if (bot.userId === user.id) return { code: 400, body: { error: 'You already own this bot.' } };

  const members = rawMembers(bot);
  const already = members.find((m) => m.userId === user.id);
  if (already) {
    already.role = i.role; // re-invited with a different role
  } else {
    if (members.length + 1 >= MAX_MEMBERS) {
      return { code: 403, body: { error: 'This bot is full.' } };
    }
    members.push({ userId: user.id, role: i.role, addedAt: now(), addedBy: i.invitedBy || null });
  }
  i.acceptedAt = now();
  i.acceptedBy = user.id;
  db.save();
  activity.log(bot.userId, {
    type: 'security',
    title: `${user.username} joined ${bot.name}`,
    detail: `Accepted the invite as ${LABEL[i.role]}.`,
    botId: bot.id,
  });
  activity.log(user.id, {
    type: 'security',
    title: `You joined ${bot.name}`,
    detail: `Access level: ${LABEL[i.role]}.`,
    botId: bot.id,
  });
  return { code: 200, body: { ok: true, botId: bot.id, role: i.role } };
}

/** Change someone's role. Owners stay owners; use transfer() for that. */
function setRole(bot, actor, userId, role) {
  if (!validRole(role)) return { code: 400, body: { error: 'Unknown role.' } };
  if (role === 'owner') {
    return { code: 400, body: { error: 'Use "Make owner" to transfer the bot.' } };
  }
  if (userId === bot.userId) {
    return { code: 400, body: { error: 'The owner always has full access.' } };
  }
  const m = rawMembers(bot).find((x) => x.userId === userId);
  if (!m) return { code: 404, body: { error: 'That person is not on this bot.' } };
  const before = m.role;
  m.role = role;
  db.save();
  const u = db.findUserById(userId);
  activity.log(bot.userId, {
    type: 'security',
    title: `${u ? u.username : 'Someone'} is now ${LABEL[role]} on ${bot.name}`,
    detail: `Was ${LABEL[before] || 'Viewer'}. Changed by ${actor ? actor.username : 'the owner'}.`,
    botId: bot.id,
  });
  return { code: 200, body: { ok: true, members: listMembers(bot) } };
}

/** Remove someone from a bot. */
function remove(bot, actor, userId) {
  if (userId === bot.userId) {
    return { code: 400, body: { error: 'The owner cannot be removed. Delete the bot instead.' } };
  }
  const members = rawMembers(bot);
  const idx = members.findIndex((x) => x.userId === userId);
  if (idx === -1) return { code: 404, body: { error: 'That person is not on this bot.' } };
  members.splice(idx, 1);
  db.save();
  const u = db.findUserById(userId);
  activity.log(bot.userId, {
    type: 'security',
    title: `${u ? u.username : 'Someone'} was removed from ${bot.name}`,
    detail: `Removed by ${actor ? actor.username : 'the owner'}.`,
    botId: bot.id,
  });
  if (u) {
    activity.log(u.id, {
      type: 'security',
      title: `You lost access to ${bot.name}`,
      detail: 'The owner removed you from this bot.',
      botId: bot.id,
    });
  }
  return { code: 200, body: { ok: true, members: listMembers(bot) } };
}

/**
 * Hand the bot to another member. The previous owner stays on as an agent so
 * they do not lose their own data by accident.
 */
function transfer(bot, actor, userId) {
  if (userId === bot.userId) return { code: 400, body: { error: 'They already own this bot.' } };
  const m = rawMembers(bot).find((x) => x.userId === userId);
  if (!m) return { code: 400, body: { error: 'Make them a member before transferring ownership.' } };
  const next = db.findUserById(userId);
  if (!next) return { code: 404, body: { error: 'That account no longer exists.' } };
  const prev = db.findUserById(bot.userId);

  bot.userId = next.id;
  rawMembers(bot).splice(rawMembers(bot).findIndex((x) => x.userId === userId), 1);
  if (prev) rawMembers(bot).push({ userId: prev.id, role: 'agent', addedAt: now(), addedBy: actor ? actor.id : null });
  db.save();
  activity.log(next.id, {
    type: 'security',
    title: `You now own ${bot.name}`,
    detail: `${prev ? prev.username : 'The previous owner'} transferred it to you.`,
    botId: bot.id,
  });
  if (prev) {
    activity.log(prev.id, {
      type: 'security',
      title: `${bot.name} was transferred to ${next.username}`,
      detail: 'You are still on the bot as an Agent.',
      botId: bot.id,
    });
  }
  return { code: 200, body: { ok: true, members: listMembers(bot) } };
}

/** Drop every trace of a user from every bot (used when an account is deleted). */
function purgeUser(userId) {
  let n = 0;
  for (const b of db.listBots()) {
    const members = rawMembers(b);
    const before = members.length;
    b.members = members.filter((m) => m.userId !== userId);
    if (b.members.length !== before) n += before - b.members.length;
  }
  const keep = invites().filter((i) => i.acceptedBy !== userId && i.invitedBy !== userId);
  const dropped = invites().length - keep.length;
  db.data.invites = keep;
  if (n || dropped) db.save();
  return n;
}

/** Inline summary for the bot card / team button. */
function summary(bot, user) {
  const role = roleFor(bot, user);
  const members = listMembers(bot);
  return {
    role,
    label: role ? LABEL[role] : null,
    count: members.length,
    pending: listInvites(bot.id).length,
    canManage: role === 'owner',
    canSend: rank(role) >= RANK.agent,
    isShared: members.length > 1,
  };
}

module.exports = {
  ROLES,
  RANK,
  LABEL,
  MAX_MEMBERS,
  INVITE_TTL_MS,
  validRole,
  rank,
  roleFor,
  can,
  botsForUser,
  listMembers,
  listInvites,
  findInviteByToken,
  invite,
  revokeInvite,
  accept,
  setRole,
  remove,
  transfer,
  purgeUser,
  summary,
};
