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
const BACKUP_EVERY_MS = 60 * 1000;
const timers = new Map(); // botId -> timer
const cache = new Map(); // botId -> { mtime, snap }

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (botId) => path.join(BOT_DIR, `data_${safeId(botId)}`, 'webchat.json');
const num = (jid) => String(jid || '').split('@')[0].split(':')[0];
const isGroup = (jid) => String(jid).endsWith('@g.us');

function read(botId) {
  const f = fileFor(botId);
  try {
    const st = fs.statSync(f);
    const hit = cache.get(botId);
    if (hit && hit.mtime === st.mtimeMs) return hit.snap;
    const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache.set(botId, { mtime: st.mtimeMs, snap });
    return snap;
  } catch (e) { return null; }
}

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

/* ------------------------------------------------------------------ MongoDB mirror */
function scheduleBackup(botId) {
  if (!mongoSync.status().enabled || timers.has(botId)) return;
  const t = setTimeout(() => { timers.delete(botId); backupNow(botId).catch(() => {}); }, BACKUP_EVERY_MS);
  if (t.unref) t.unref();
  timers.set(botId, t);
}

async function backupNow(botId) {
  const f = fileFor(botId);
  if (!mongoSync.status().ready || !fs.existsSync(f)) return false;
  try {
    const gz = await new Promise((res, rej) => zlib.gzip(fs.readFileSync(f), { level: 6 }, (e, b) => (e ? rej(e) : res(b))));
    if (gz.length > 15 * 1024 * 1024) return false; // would exceed MongoDB's document limit
    return await mongoSync.pushChatStore(botId, gz);
  } catch (e) { return false; }
}

/** Cloud copy as JSON text (or null). */
async function cloudJson(botId) {
  const got = await mongoSync.getChatStore(botId);
  if (!got) return null;
  try { return zlib.gunzipSync(got.gz).toString('utf8'); } catch (e) { return null; }
}

/** On boot: bring back any history file that is missing from the local disk. */
async function restoreAll(botIds) {
  if (!mongoSync.status().ready) return 0;
  let n = 0;
  for (const id of botIds) {
    const f = fileFor(id);
    if (fs.existsSync(f)) continue;
    const json = await cloudJson(id);
    if (!json) continue;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, json);
      n++;
    } catch (e) { /* skip */ }
  }
  if (n) console.log(`[chat-archive] restored message history for ${n} bot(s) from MongoDB`);
  return n;
}

function purge(botId) {
  try { fs.unlinkSync(fileFor(botId)); } catch (e) { /* none */ }
  cache.delete(botId);
  mongoSync.deleteChatStore(botId);
}

module.exports = { read, has, chats, messages, scheduleBackup, backupNow, cloudJson, restoreAll, purge, fileFor };
