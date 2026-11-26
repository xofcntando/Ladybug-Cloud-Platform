/**
 * One-time email tokens for account verification and password resets, plus the
 * thin glue that turns a Team Access invite into an email.
 *
 * Tokens live in db.data.emailTokens[] as { token, userId, kind, expiresAt,
 * createdAt, usedAt, ip }. They are 32 bytes of randomness, single use, and
 * scoped to a kind ('verify' | 'reset') so a verification link can never be
 * replayed as a password reset.
 */
const crypto = require('crypto');
const db = require('./store');
const mailer = require('./mailer');

const TTL = {
  verify: 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

const ROLE_BLURB = {
  owner: 'Full control of the bot, including settings, keys and billing.',
  agent: 'You can read chats and send messages, polls, media and status updates.',
  viewer: 'You can read chats and see the dashboard, but not send anything.',
};

function tokens() {
  const d = db.data || {};
  if (!Array.isArray(d.emailTokens)) d.emailTokens = [];
  return d.emailTokens;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Drop anything older than a day past expiry so the array cannot grow forever. */
function sweep() {
  const list = tokens();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const keep = list.filter((t) => t && (t.usedAt || t.expiresAt > cutoff));
  if (keep.length !== list.length) {
    db.data.emailTokens = keep;
    db.save();
  }
  return keep;
}

/**
 * Mint a token for a user. Any previous unused token of the same kind is
 * invalidated so only the newest email in the inbox works.
 */
function issue(userId, kind, ip) {
  if (!TTL[kind]) throw new Error(`Unknown token kind "${kind}"`);
  const list = sweep();
  for (const t of list) {
    if (t.userId === userId && t.kind === kind && !t.usedAt) t.usedAt = new Date().toISOString();
  }
  const rec = {
    token: newToken(),
    userId,
    kind,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TTL[kind],
    usedAt: null,
    ip: ip ? String(ip).replace(/^::ffff:/, '') : null,
  };
  list.push(rec);
  // sweep() may hand back a filtered copy, so re-attach the list we pushed to.
  db.data.emailTokens = list;
  db.save();
  return rec;
}

/** Look a token up without consuming it (so a page can preview it). */
function peek(token, kind) {
  if (!token) return null;
  const t = tokens().find((x) => x && x.token === String(token) && (!kind || x.kind === kind));
  if (!t) return null;
  if (t.usedAt) return { ...t, invalid: 'used' };
  if (t.expiresAt < Date.now()) return { ...t, invalid: 'expired' };
  return t;
}

/**
 * Consume a token. Returns { ok, userId } or { ok:false, error }.
 * The token is burned on success only, so a typo in the password field does not
 * force the user to request a new link.
 */
function consume(token, kind) {
  const t = peek(token, kind);
  if (!t) return { ok: false, error: 'This link is not valid. Request a new one.' };
  if (t.invalid === 'used') return { ok: false, error: 'This link has already been used. Request a new one.' };
  if (t.invalid === 'expired') return { ok: false, error: 'This link has expired. Request a new one.' };
  return { ok: true, userId: t.userId, rec: t };
}

function burn(rec) {
  if (!rec) return;
  rec.usedAt = new Date().toISOString();
  db.save();
}

/** Send a verification email. Never throws. */
async function sendVerify(user, ip) {
  if (!user || !mailer.validEmail(user.email)) {
    return { ok: false, error: 'This account has no usable email address.' };
  }
  const rec = issue(user.id, 'verify', ip);
  const r = await mailer.sendTemplate('verify', user.email, { username: user.username, token: rec.token });
  return { ...r, token: rec.token, expiresAt: rec.expiresAt };
}

/** Send a password reset email. Never throws, and never reveals whether the address exists. */
async function sendReset(user, ip) {
  if (!user || !mailer.validEmail(user.email)) {
    return { ok: false, error: 'This account has no usable email address.' };
  }
  const rec = issue(user.id, 'reset', ip);
  const r = await mailer.sendTemplate('reset', user.email, { username: user.username, token: rec.token });
  return { ...r, token: rec.token, expiresAt: rec.expiresAt };
}

/** Email a Team Access invite. Never throws. */
async function sendInvite({ invite, bot, inviter }) {
  if (!invite || !mailer.validEmail(invite.email)) {
    return { ok: false, error: 'That invite has no usable email address.' };
  }
  return mailer.sendTemplate('invite', invite.email, {
    token: invite.token,
    email: invite.email,
    botName: bot ? bot.name : 'a WhatsApp bot',
    inviter: inviter ? inviter.username : 'A teammate',
    roleLabel: invite.role === 'agent' ? 'Agent' : 'Viewer',
    roleBlurb: ROLE_BLURB[invite.role] || ROLE_BLURB.viewer,
  });
}

module.exports = { TTL, ROLE_BLURB, issue, peek, consume, burn, sweep, sendVerify, sendReset, sendInvite };
