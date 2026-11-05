/**
 * Chat labels and the address book for the WhatsApp console.
 *
 * Both live in the platform database (db.data.waBook[botId]), so they follow the number
 * across browsers and - with MONGODB_URI set - across Render redeploys.
 *   labels:   [{ id, name, color }]  and  chats: { jid: [labelId] }
 *   contacts: { jid: name }          (numbers saved from the console; also pushed to the phone's address book when WhatsApp allows it)
 */
const crypto = require('crypto');
const db = require('./store');

const MAX_LABELS = 20;
const MAX_NAME = 24;
const MAX_LABELS_PER_CHAT = 6;
const MAX_CONTACTS = 2000;
const COLORS = ['#00a884', '#53bdeb', '#e9a23b', '#ef6c5b', '#a96cf0', '#f06fa8', '#8696a0', '#7acb5b'];
const JID_RE = /^[0-9A-Za-z._:-]+@(s\.whatsapp\.net|g\.us|lid)$/;

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function book(botId, create = false) {
  const d = db.data;
  if (!d.waBook || typeof d.waBook !== 'object') d.waBook = {};
  let b = d.waBook[botId];
  if (!b && create) b = d.waBook[botId] = { labels: [], chats: {}, contacts: {} };
  if (b) { b.labels = b.labels || []; b.chats = b.chats || {}; b.contacts = b.contacts || {}; }
  return b;
}

function cleanName(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
/** Like cleanName but keeps line breaks (auto-replies are multi-line). */
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
function cleanColor(v) { return COLORS.includes(String(v)) ? String(v) : /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : COLORS[0]; }

/* ------------------------------------------------------------------ labels */
function labelsView(botId) {
  const b = book(botId);
  return { labels: b ? b.labels : [], chats: b ? b.chats : {}, colors: COLORS, max: MAX_LABELS };
}

function createLabel(botId, body) {
  const name = cleanName((body || {}).name, MAX_NAME);
  if (!name) throw bad('Give the label a name');
  const b = book(botId, true);
  if (b.labels.length >= MAX_LABELS) throw bad(`You can have up to ${MAX_LABELS} labels`);
  if (b.labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw bad('A label with that name already exists');
  const label = { id: 'lb_' + crypto.randomBytes(4).toString('hex'), name, color: cleanColor((body || {}).color || COLORS[b.labels.length % COLORS.length]) };
  b.labels.push(label);
  db.save();
  return label;
}

function updateLabel(botId, id, body) {
  const b = book(botId);
  const l = b && b.labels.find((x) => x.id === id);
  if (!l) throw bad('Label not found', 404);
  if (body && body.name !== undefined) {
    const name = cleanName(body.name, MAX_NAME);
    if (!name) throw bad('Give the label a name');
    if (b.labels.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw bad('A label with that name already exists');
    l.name = name;
  }
  if (body && body.color !== undefined) l.color = cleanColor(body.color);
  db.save();
  return l;
}

function deleteLabel(botId, id) {
  const b = book(botId);
  if (!b || !b.labels.some((x) => x.id === id)) throw bad('Label not found', 404);
  b.labels = b.labels.filter((x) => x.id !== id);
  for (const jid of Object.keys(b.chats)) {
    b.chats[jid] = b.chats[jid].filter((x) => x !== id);
    if (!b.chats[jid].length) delete b.chats[jid];
  }
  db.save();
  return { ok: true };
}

function assign(botId, body) {
  const jid = String((body || {}).jid || '');
  const id = String((body || {}).labelId || '');
  if (!JID_RE.test(jid)) throw bad('Pick a chat first');
  const b = book(botId);
  if (!b || !b.labels.some((x) => x.id === id)) throw bad('Label not found', 404);
  const cur = new Set(b.chats[jid] || []);
  if (body.on === false) cur.delete(id);
  else {
    if (!cur.has(id) && cur.size >= MAX_LABELS_PER_CHAT) throw bad(`A chat can have up to ${MAX_LABELS_PER_CHAT} labels`);
    cur.add(id);
  }
  if (cur.size) b.chats[jid] = [...cur]; else delete b.chats[jid];
  db.save();
  return { jid, labels: b.chats[jid] || [] };
}

/* ------------------------------------------------------------------ address book */
function contacts(botId) {
  const b = book(botId);
  return b ? b.contacts : {};
}

function saveContact(botId, jid, name) {
  if (!JID_RE.test(String(jid))) throw bad('Invalid contact');
  const b = book(botId, true);
  if (!(jid in b.contacts) && Object.keys(b.contacts).length >= MAX_CONTACTS) throw bad(`The address book is full (${MAX_CONTACTS} contacts)`);
  b.contacts[jid] = cleanName(name, 60);
  db.save();
}

function forgetContact(botId, jid) {
  const b = book(botId);
  if (b && b.contacts[jid] !== undefined) { delete b.contacts[jid]; db.save(); }
}

/* ------------------------------------------------------------------ automation settings */
const AUTO_BOOL_KEYS = ['online', 'viewStatus', 'saveStatus', 'readReceipts', 'rejectCalls'];
const AUTO_KEYS = AUTO_BOOL_KEYS.concat(['away', 'rules']);
const MAX_RULES = 50;
const MAX_RULE_MATCH = 80;
const MAX_RULE_REPLY = 500;

/** Only keys the user has set are returned, so unset ones never override what a bot command configured. */
function autoFor(botId) {
  const b = book(botId);
  const out = {};
  if (!b || !b.auto) return out;
  for (const k of AUTO_BOOL_KEYS) if (typeof b.auto[k] === 'boolean') out[k] = b.auto[k];
  if (b.auto.away && typeof b.auto.away === 'object') out.away = b.auto.away;
  if (Array.isArray(b.auto.rules)) out.rules = b.auto.rules;
  return out;
}

function cleanAway(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object') throw bad('Away reply must be an object');
  const text = cleanText(v.text, 300);
  if (!text) throw bad('Write the away message first');
  const cooldownMin = Math.max(0, Math.min(1440, Math.round(Number(v.cooldownMin) || 60)));
  return { enabled: v.enabled !== false, text, cooldownMin };
}

function cleanRules(v) {
  if (!Array.isArray(v)) throw bad('Rules must be a list');
  if (v.length > MAX_RULES) throw bad(`At most ${MAX_RULES} rules`);
  const seen = new Set();
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const match = cleanName(r.match, MAX_RULE_MATCH);
    const reply = cleanText(r.reply, MAX_RULE_REPLY);
    if (!match || !reply) continue;
    const key = match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: /^[a-f0-9]{6,24}$/i.test(String(r.id || '')) ? String(r.id) : crypto.randomBytes(6).toString('hex'),
      match, reply, exact: r.exact === true, enabled: r.enabled !== false,
    });
  }
  return out;
}

function setAuto(botId, patch) {
  const clean = {};
  for (const k of AUTO_BOOL_KEYS) {
    if (patch && patch[k] !== undefined) {
      if (typeof patch[k] !== 'boolean') throw bad('Settings must be on or off');
      clean[k] = patch[k];
    }
  }
  if (patch && patch.away !== undefined) clean.away = cleanAway(patch.away);
  if (patch && patch.rules !== undefined) clean.rules = cleanRules(patch.rules);
  if (!Object.keys(clean).length) throw bad('Nothing to change');
  const b = book(botId, true);
  b.auto = Object.assign(b.auto || {}, clean);
  if (clean.away === null) delete b.auto.away;
  db.save();
  return { saved: autoFor(botId), changed: clean };
}

/** Remove everything stored for a bot (called when the bot is deleted). */
function purge(botId) {
  const d = db.data;
  if (d.waBook && d.waBook[botId]) { delete d.waBook[botId]; db.save(); }
}

module.exports = { autoFor, setAuto, labelsView, createLabel, updateLabel, deleteLabel, assign, contacts, saveContact, forgetContact, purge, COLORS };
