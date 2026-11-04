/**
 * Linked devices - every WhatsApp number a user has ever linked, kept so it can be restored.
 *
 * A device is saved automatically when:
 *   - the in-browser / API pairing finishes ("pairing")
 *   - a bot is created or its session is changed ("bot")
 *   - a bot is deleted ("bot-deleted"), so deleting a bot never loses the linked number
 *
 * Restoring a device attaches its saved session to a (new or existing) bot. If WhatsApp has
 * since logged the device out, the device is flagged "logged_out" and must be paired again.
 */
const crypto = require('crypto');
const db = require('./store');
const sessioninfo = require('./sessioninfo');

const MAX_DEVICES = 20;

const mask = (s) => (s ? `${s.slice(0, 12)}${'•'.repeat(Math.max(0, Math.min(20, s.length - 12)))}` : '');

function view(d) {
  return {
    id: d.id,
    number: d.number,
    label: d.label || null,
    waName: d.waName || null,
    status: d.status, // active | logged_out
    source: d.source,
    sessionIdMasked: mask(d.sessionId),
    linkedAt: d.linkedAt,
    lastUsedAt: d.lastUsedAt || null,
    botId: d.botId || null,
  };
}

function list(user) {
  return (user.linkedDevices || []).slice().sort((a, b) => String(b.lastUsedAt || b.linkedAt).localeCompare(String(a.lastUsedAt || a.linkedAt))).map(view);
}

function find(user, id) {
  return (user.linkedDevices || []).find((d) => d.id === id);
}

/** Save (or refresh) a device for this user. Returns the stored device or null. */
function record(user, { sessionId, source, botId }) {
  const sid = String(sessionId || '').trim();
  const info = sid ? sessioninfo.decode(sid) : null;
  if (!info || !info.number) return null;
  user.linkedDevices = user.linkedDevices || [];
  const now = new Date().toISOString();
  let dev = user.linkedDevices.find((d) => d.number === info.number);
  if (dev) {
    dev.sessionId = sid;
    dev.waName = info.name || dev.waName || null;
    if (source === 'pairing') { dev.status = 'active'; dev.linkedAt = now; }
    dev.source = source;
    dev.botId = source === 'bot-deleted' ? null : (botId || dev.botId || null);
  } else {
    dev = {
      id: crypto.randomBytes(6).toString('hex'),
      number: info.number,
      label: null,
      waName: info.name || null,
      sessionId: sid,
      status: 'active',
      source,
      linkedAt: now,
      lastUsedAt: null,
      botId: source === 'bot-deleted' ? null : botId || null,
    };
    user.linkedDevices.push(dev);
    if (user.linkedDevices.length > MAX_DEVICES) {
      const drop = user.linkedDevices.filter((d) => d.id !== dev.id).sort((a, b) => (a.status === 'logged_out' ? -1 : 0) - (b.status === 'logged_out' ? -1 : 0) || String(a.linkedAt).localeCompare(String(b.linkedAt)))[0];
      user.linkedDevices = user.linkedDevices.filter((d) => d.id !== drop.id);
    }
  }
  db.save();
  return dev;
}

function rename(user, id, label) {
  const d = find(user, id);
  if (!d) return null;
  d.label = String(label || '').trim().slice(0, 40) || null;
  db.save();
  return d;
}

function remove(user, id) {
  const before = (user.linkedDevices || []).length;
  user.linkedDevices = (user.linkedDevices || []).filter((d) => d.id !== id);
  if (user.linkedDevices.length === before) return false;
  db.save();
  return true;
}

function touch(user, id, botId) {
  const d = find(user, id);
  if (d) { d.lastUsedAt = new Date().toISOString(); d.botId = botId || d.botId; db.save(); }
}

/** WhatsApp logged this session out: every user's copy of it is now useless. */
function markLoggedOut(sessionId) {
  if (!sessionId) return;
  let changed = false;
  for (const u of db.data.users || []) {
    for (const d of u.linkedDevices || []) {
      if (d.sessionId === sessionId && d.status !== 'logged_out') { d.status = 'logged_out'; changed = true; }
    }
  }
  if (changed) db.save();
}

module.exports = { MAX_DEVICES, list, find, record, rename, remove, touch, markLoggedOut, view };
