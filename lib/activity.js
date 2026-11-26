/**
 * Activity Timeline — an account-wide audit trail.
 *
 * Everything the platform does on a user's behalf already leaves a trace somewhere: bot
 * events live on the bot, payments in the payments list, uptime in hourly buckets. None of
 * it is readable as one story. This module keeps a small, capped, per-user log so a user can
 * answer "what happened on my account this week?" without opening five pages.
 *
 * Design notes:
 *   - Stored in db.data.activity[userId], next to the rest of the account data, so it follows
 *     the user across browsers and (with MONGODB_URI) across redeploys.
 *   - Capped at MAX_PER_USER entries. This is a convenience feed, not a compliance archive.
 *   - Never stores secrets: details are truncated and callers pass human text, not tokens.
 *   - Bot lifecycle events arrive through the existing event bus, so bots.js needs no changes.
 */
const crypto = require('crypto');
const db = require('./store');
const events = require('./events');

const MAX_PER_USER = 400;
const MAX_TITLE = 140;
const MAX_DETAIL = 300;
const MAX_META_KEYS = 8;

/** The categories the UI filters by, with a stable order. */
const TYPES = [
  { id: 'bot', label: 'Bots' },
  { id: 'billing', label: 'Billing' },
  { id: 'storage', label: 'Storage' },
  { id: 'security', label: 'Security' },
  { id: 'account', label: 'Account' },
];

const TYPE_IDS = new Set(TYPES.map((t) => t.id));

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bucket(userId, create = false) {
  const d = db.data;
  if (!d.activity || typeof d.activity !== 'object' || Array.isArray(d.activity)) d.activity = {};
  let list = d.activity[userId];
  if (!Array.isArray(list)) {
    if (!create) return [];
    list = d.activity[userId] = [];
  }
  return list;
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (n >= MAX_META_KEYS) break;
    if (v == null) continue;
    const key = clean(k, 24);
    if (!key) continue;
    out[key] = typeof v === 'number' || typeof v === 'boolean' ? v : clean(v, 80);
    n++;
  }
  return n ? out : null;
}

/**
 * Append one entry.
 * @param {string} userId
 * @param {{type:string, title:string, detail?:string, meta?:object, botId?:string, at?:number}} entry
 */
function log(userId, entry) {
  if (!userId || !entry || !entry.title) return null;
  const type = TYPE_IDS.has(entry.type) ? entry.type : 'account';
  const list = bucket(userId, true);
  // Timestamps double as the pagination cursor, so they must be strictly increasing.
  // Two events in the same millisecond would otherwise make `before` skip a row.
  const newest = list.length ? list[0].t : 0;
  const item = {
    id: 'a_' + crypto.randomBytes(6).toString('hex'),
    t: Math.max(Number(entry.at) || Date.now(), newest + 1),
    type,
    title: clean(entry.title, MAX_TITLE),
    detail: clean(entry.detail, MAX_DETAIL),
    meta: safeMeta(entry.meta),
    botId: entry.botId ? clean(entry.botId, 40) : null,
    seen: false,
  };
  list.unshift(item);
  if (list.length > MAX_PER_USER) list.length = MAX_PER_USER;
  db.save();
  return item;
}

function matches(item, type, needle) {
  if (type && item.type !== type) return false;
  if (!needle) return true;
  const hay = (item.title + ' ' + item.detail + ' ' + (item.meta ? Object.values(item.meta).join(' ') : '')).toLowerCase();
  return needle.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Newest first, with an opaque cursor (`before`) for "load more". */
function list(userId, { limit = 40, before = 0, type = '', q = '' } = {}) {
  const all = bucket(userId);
  const t = TYPE_IDS.has(type) ? type : '';
  const needle = clean(q, 80);
  const n = Math.min(100, Math.max(1, Number(limit) || 40));
  const cursor = Number(before) || 0;
  const filtered = all.filter((i) => (!cursor || i.t < cursor) && matches(i, t, needle));
  const items = filtered.slice(0, n);
  return {
    items,
    hasMore: filtered.length > items.length,
    nextBefore: items.length ? items[items.length - 1].t : 0,
    total: all.length,
    matching: filtered.length,
    unseen: all.filter((i) => !i.seen).length,
    types: TYPES,
  };
}

function unseen(userId) {
  return bucket(userId).filter((i) => !i.seen).length;
}

/** Mark everything (or just the given ids) as read. Returns the new unseen count. */
function markSeen(userId, ids) {
  const all = bucket(userId);
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
  let changed = 0;
  for (const i of all) {
    if (i.seen) continue;
    if (want && !want.has(i.id)) continue;
    i.seen = true;
    changed++;
  }
  if (changed) db.save();
  return { ok: true, changed, unseen: unseen(userId) };
}

function clear(userId) {
  const d = db.data;
  if (d.activity && d.activity[userId]) {
    d.activity[userId] = [];
    db.save();
  }
  return { ok: true };
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** RFC 4180-ish export of the whole feed, newest first. */
function csv(userId, { type = '', q = '' } = {}) {
  const all = bucket(userId);
  const t = TYPE_IDS.has(type) ? type : '';
  const needle = clean(q, 80);
  const rows = [['when', 'iso', 'category', 'title', 'detail', 'bot', 'read']];
  for (const i of all.filter((x) => matches(x, t, needle))) {
    rows.push([
      new Date(i.t).toISOString(),
      new Date(i.t).toISOString(),
      i.type,
      i.title,
      i.detail,
      i.botId || '',
      i.seen ? 'yes' : 'no',
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ bot events */
const BOT_EVENT_TEXT = {
  started: ['Bot started', 'Your bot process is running.'],
  stopped: ['Bot stopped', 'The bot was stopped.'],
  crashed: ['Bot crashed', 'The process exited unexpectedly; auto-restart may pick it up.'],
  online: ['Bot connected to WhatsApp', 'The linked number is online.'],
  logged_out: ['WhatsApp session logged out', 'Re-link the number to bring the bot back online.'],
  conflict: ['Session conflict', 'Another device is using the same WhatsApp session.'],
  restarted: ['Bot restarted', 'The bot process was restarted.'],
  suspended: ['Bot suspended', 'Hosting for this bot is paused.'],
  limit: ['Bot stopped by the plan limit', 'The plan limit was reached.'],
};

/**
 * Bridge bot lifecycle events into the owner's timeline. bots.js already emits these on the
 * shared bus for webhooks, so this needs no changes there and stays a no-op when the bot or
 * its owner has been deleted.
 */
function attach() {
  events.bus.on('bot', (e) => {
    try {
      if (!e || !e.botId) return;
      const bot = db.findBotById(e.botId);
      if (!bot || !bot.userId) return;
      const known = BOT_EVENT_TEXT[e.type];
      const title = known ? known[0] : 'Bot event: ' + clean(e.type, 40);
      const detail = e.detail ? clean(e.detail, MAX_DETAIL) : (known ? known[1] : '');
      log(bot.userId, { type: 'bot', title, detail, botId: bot.id, meta: { bot: bot.name, event: e.type } });
    } catch (err) { /* the feed must never break the bot manager */ }
  });
}

let attached = false;
function ensureAttached() {
  if (attached) return;
  attached = true;
  attach();
}

module.exports = { log, list, unseen, markSeen, clear, csv, attach, ensureAttached, TYPES, MAX_PER_USER };
