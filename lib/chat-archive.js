/**
 * Chat archive for the WhatsApp console.
 *
 * The bot process (utils/webBridge.js) writes its chats and message history to
 * $BOT_DATA_DIR/webchat.json. This module:
 *   - serves that file when the bot is stopped/offline, so the dashboard still shows the history
 *     (read-only; sending needs the bot online),
 *   - mirrors the file to MongoDB (when MONGODB_URI is set) so history survives redeploys on
 *     hosts with an ephemeral disk (Render free plan),
 *   - restores it from MongoDB on boot when the local file is missing.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoSync = require('./mongo-sync');

const BOT_DIR = process.env.BOT_DIR || path.join(__dirname, '..', 'bots', 'ladybug');
const BACKUP_EVERY_MS = 20 * 1000; // how often a running bot's history is checked for changes
const cache = new Map(); // botId -> { mtime, snap }
const mirrors = new Map(); // botId -> { timer, sig, at, busy }
const restoring = new Map(); // botId -> Promise, so two callers never pull the same backup twice

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (botId) => path.join(BOT_DIR, `data_${safeId(botId)}`, 'webchat.json');
const num = (jid) => String(jid || '').split('@')[0].split(':')[0];
const isGroup = (jid) => String(jid).endsWith('@g.us');

function read(botId) {
  const f = fileFor(botId);
  try {
    const st = fs.statSync(f);
    // mtime alone is not enough: two writes can land in the same millisecond, and a
    // same-millisecond rewrite with a different size would otherwise serve stale data.
    const key = st.mtimeMs + ':' + st.size;
    const hit = cache.get(botId);
    if (hit && hit.key === key) return hit.snap;
    const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache.set(botId, { key, snap });
    return snap;
  } catch (e) { return null; }
}

/** Write a snapshot to the bot's history file (atomic: temp file then rename). */
function writeFile(botId, json) {
  const f = fileFor(botId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, f);
  cache.delete(botId);
  return f;
}

const savedAtOf = (snap) => (snap && Number(snap.savedAt)) || 0;

function has(botId) { return !!read(botId); }

function chatView(c, contacts) {
  return {
    presence: null, avatar: null, jid: c.jid,
    name: c.name || contacts[c.jid] || (isGroup(c.jid) ? 'Group' : '+' + num(c.jid)),
    isGroup: isGroup(c.jid), unread: c.unread || 0, lastTs: c.lastTs || 0, lastText: c.lastText || '', lastFromMe: !!c.lastFromMe,
  };
}

/** Same shape as the bot's own `chats` answer. */
function chats(botId, { q = '', limit = 100 } = {}) {
  const snap = read(botId);
  if (!snap) return null;
  const needle = String(q || '').toLowerCase();
  const contacts = snap.contacts || {};
  let list = (snap.chats || []).filter((c) => c.lastTs || (snap.msgs || {})[c.jid]).map((c) => chatView(c, contacts));
  if (needle) list = list.filter((c) => c.name.toLowerCase().includes(needle) || num(c.jid).includes(needle));
  list.sort((a, b) => b.lastTs - a.lastTs);
  return {
    chats: list.slice(0, Math.min(300, Math.max(1, limit))), online: 0,
    conn: { state: 'offline', since: snap.savedAt || null, number: null, name: null }, me: null,
    offline: true, savedAt: snap.savedAt || null,
  };
}

/** Same shape as the bot's own `messages` answer. */
function messages(botId, { jid, limit = 50, before = 0 } = {}) {
  const snap = read(botId);
  if (!snap) return null;
  const contacts = snap.contacts || {};
  let list = (snap.msgs || {})[jid] || [];
  if (before) list = list.filter((m) => m.ts < before);
  const c = (snap.chats || []).find((x) => x.jid === jid);
  const lim = Math.min(200, Math.max(1, limit));
  return {
    chat: c ? chatView(c, contacts) : { jid, name: contacts[jid] || '+' + num(jid), isGroup: isGroup(jid), unread: 0 },
    messages: list.slice(-lim), hasMore: list.length > lim, offline: true, savedAt: snap.savedAt || null,
  };
}

/** Saved channels (read-only while the bot is offline). */
function channelView(c, posts) {
  const list = c.posts || [];
  const last = list[list.length - 1];
  const out = {
    jid: c.jid, name: c.name, description: c.description || '', link: c.link || null, subscribers: c.subscribers || 0, verified: !!c.verified,
    picture: c.picture || null, role: c.role || 'SUBSCRIBER', canPost: false, muted: !!c.muted, created: c.created || null,
    lastTs: last ? last.ts : 0, lastText: last ? (last.text || '[' + last.type + ']').slice(0, 100) : '', postCount: list.length,
  };
  if (posts) out.posts = list.slice(-posts);
  return out;
}
function channels(botId) {
  const snap = read(botId);
  if (!snap || !Array.isArray(snap.channels)) return null;
  const list = snap.channels.map((c) => channelView(c)).sort((a, b) => (b.lastTs || b.created || 0) - (a.lastTs || a.created || 0));
  return { channels: list, offline: true, savedAt: snap.savedAt || null };
}
function channelPosts(botId, jid, limit = 50) {
  const snap = read(botId);
  const c = snap && (snap.channels || []).find((x) => x.jid === jid);
  return c ? { channel: channelView(c, Math.min(100, Math.max(1, limit))), offline: true, savedAt: snap.savedAt || null } : null;
}

/* ------------------------------------------------------------------ MongoDB mirror
 * The bot writes its history to disk every few seconds. This section makes sure a copy of
 * that file also lives in MongoDB, and that the newest of the two wins on boot.
 *
 * Why "newest wins" instead of "restore only when missing": hosts with a persistent disk
 * (a VPS, a Render disk, a local dev box) keep an old webchat.json around. If that file is
 * older than the cloud copy, restoring only-when-missing would silently serve stale history
 * after a restart. Comparing savedAt fixes that.
 */

function mirrorState(botId) {
  let m = mirrors.get(botId);
  if (!m) { m = { timer: null, sig: '', at: 0, busy: false }; mirrors.set(botId, m); }
  return m;
}

/** Cheap change detector: file size + mtime. Avoids gzipping an unchanged file. */
function fileSig(botId) {
  try {
    const st = fs.statSync(fileFor(botId));
    return st.size + ':' + st.mtimeMs;
  } catch (e) { return ''; }
}

/**
 * Keep mirroring this bot's history to MongoDB while it runs.
 * Called on bot start, on every "saved" message from the bot, and on stop.
 * Idempotent: a second call only nudges the existing loop.
 */
function scheduleBackup(botId) {
  if (!mongoSync.status().enabled) return;
  const m = mirrorState(botId);
  if (m.timer) return;
  const tick = () => {
    if (!mongoSync.status().ready) return;
    const sig = fileSig(botId);
    if (!sig || sig === m.sig) return;
    backupNow(botId).then((ok) => { if (ok) { m.sig = sig; m.at = Date.now(); } }).catch(() => {});
  };
  m.timer = setInterval(tick, BACKUP_EVERY_MS);
  if (m.timer.unref) m.timer.unref();
  tick(); // don't wait a full interval for the first copy
}

/** Stop the mirror loop for a bot (called when it is deleted). */
function unschedule(botId) {
  const m = mirrors.get(botId);
  if (m && m.timer) clearInterval(m.timer);
  mirrors.delete(botId);
}

async function backupNow(botId) {
  const f = fileFor(botId);
  if (!mongoSync.status().ready || !fs.existsSync(f)) return false;
  const m = mirrorState(botId);
  if (m.busy) return false;
  m.busy = true;
  try {
    const gz = await new Promise((res, rej) => zlib.gzip(fs.readFileSync(f), { level: 6 }, (e, b) => (e ? rej(e) : res(b))));
    if (gz.length > 15 * 1024 * 1024) return false; // would exceed MongoDB's 16 MB document limit
    const ok = await mongoSync.pushChatStore(botId, gz);
    if (ok) { m.sig = fileSig(botId); m.at = Date.now(); }
    return ok;
  } catch (e) { return false; }
  finally { m.busy = false; }
}

/** Mirror every bot right now - used on shutdown so a redeploy cannot lose the last minutes. */
async function flushAll(botIds) {
  if (!mongoSync.status().ready) return 0;
  const ids = botIds && botIds.length ? botIds : [...mirrors.keys()];
  let n = 0;
  for (const id of ids) { try { if (await backupNow(id)) n++; } catch (e) { /* best effort */ } }
  return n;
}

/** Cloud copy as JSON text (or null). */
async function cloudJson(botId) {
  const got = await mongoSync.getChatStore(botId);
  if (!got) return null;
  try { return zlib.gunzipSync(got.gz).toString('utf8'); } catch (e) { return null; }
}

/**
 * Bring one bot's history back from MongoDB when the cloud copy is newer than the disk.
 * Returns true when the local file was replaced.
 */
async function restoreOne(botId) {
  if (!mongoSync.status().ready) return false;
  const json = await cloudJson(botId);
  if (!json) return false;
  let cloud;
  try { cloud = JSON.parse(json); } catch (e) { return false; }
  const local = read(botId);
  const cloudAt = savedAtOf(cloud);
  if (local && savedAtOf(local) >= cloudAt) return false; // disk is at least as new
  try { writeFile(botId, json); return true; } catch (e) { return false; }
}

/** On boot: bring back every bot's history that is missing or older than the cloud copy. */
async function restoreAll(botIds) {
  if (!mongoSync.status().ready) return 0;
  let n = 0;
  for (const id of botIds) {
    try { if (await restoreOne(id)) n++; } catch (e) { /* skip this bot */ }
  }
  if (n) console.log(`[chat-archive] restored message history for ${n} bot(s) from MongoDB`);
  return n;
}

/**
 * Make sure the local history file exists before the console reads it.
 * A fresh disk (redeploy, new instance) has no file yet; pull the cloud copy once.
 * Concurrent callers share one request.
 */
function ensure(botId) {
  if (!mongoSync.status().ready) return Promise.resolve(false);
  if (fs.existsSync(fileFor(botId))) return Promise.resolve(false);
  if (restoring.has(botId)) return restoring.get(botId);
  const p = restoreOne(botId).catch(() => false).finally(() => restoring.delete(botId));
  restoring.set(botId, p);
  return p;
}

function purge(botId) {
  unschedule(botId);
  try { fs.unlinkSync(fileFor(botId)); } catch (e) { /* none */ }
  cache.delete(botId);
  mongoSync.deleteChatStore(botId);
}

module.exports = { read, has, chats, messages, channels, channelPosts, scheduleBackup, unschedule, backupNow, flushAll, cloudJson, restoreOne, restoreAll, ensure, purge, fileFor };
