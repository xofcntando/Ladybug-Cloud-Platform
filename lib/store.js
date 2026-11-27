/**
 * Tiny JSON file store — no native deps, safe on Render free tier.
 */
const fs = require('fs');
const path = require('path');

const mongoSync = require('./mongo-sync');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULTS = {
  users: [],
  bots: [],
  messages: [],
  payments: [],
  settings: {},
  meta: { createdAt: new Date().toISOString(), version: 1 },
  // Monetization: monthly counters per user ("<userId>:<YYYY-MM>" -> { messages, ai, ... }).
  usage: {},
  // Console UX: saved replies ("snippets") owned by a user, shared across their bots.
  snippets: [],
};

let data = null;
let writeTimer = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  if (data) return data;
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      data.users = data.users || [];
      data.bots = data.bots || [];
      data.messages = data.messages || [];
      data.payments = data.payments || [];
      data.settings = data.settings || {};
      data.meta = data.meta || DEFAULTS.meta;
      data.usage = data.usage || {};
      data.snippets = data.snippets || [];
    } catch (e) {
      console.error('[store] corrupt db, starting fresh:', e.message);
      data = JSON.parse(JSON.stringify(DEFAULTS));
    }
  } else {
    data = JSON.parse(JSON.stringify(DEFAULTS));
    persistNow();
  }
  return data;
}

function persistNow() {
  try {
    ensureDir();
    const tmp = DB_FILE + '.tmp';
    data.meta = data.meta || {};
    data.meta.savedAt = Date.now();
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
    mongoSync.pushDb(json);
  } catch (e) {
    console.error('[store] write failed:', e.message);
  }
}

/** Debounced save so rapid mutations don't thrash the disk. */
function save() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persistNow();
  }, 150);
}

const db = {
  get data() {
    return load();
  },
  save,
  flush: persistNow,

  // ---- users ----
  findUserByUsername(username) {
    return load().users.find(
      (u) => u.username.toLowerCase() === String(username).toLowerCase()
    );
  },
  findUserByEmail(email) {
    if (!email) return null;
    return load().users.find(
      (u) => u.email && u.email.toLowerCase() === String(email).toLowerCase()
    );
  },
  findUserById(id) {
    return load().users.find((u) => u.id === id);
  },
  addUser(user) {
    load().users.push(user);
    save();
    return user;
  },
  updateUser(id, patch) {
    const u = this.findUserById(id);
    if (!u) return null;
    Object.assign(u, patch);
    save();
    return u;
  },
  deleteUser(id) {
    const d = load();
    d.users = d.users.filter((u) => u.id !== id);
    d.bots = d.bots.filter((b) => b.userId !== id);
    d.messages = (d.messages || []).filter((m) => m.userId !== id);
    d.payments = (d.payments || []).filter((x) => x.userId !== id);
    d.snippets = (d.snippets || []).filter((s) => s.userId !== id);
    for (const key of Object.keys(d.usage || {})) {
      if (key.startsWith(id + ':')) delete d.usage[key];
    }
    save();
  },

  // ---- monthly usage counters (plan limits, usage meter) ----
  usageFor(userId, month) {
    const d = load();
    d.usage = d.usage || {};
    return d.usage[`${userId}:${month}`] || {};
  },
  bumpUsage(userId, month, key, n = 1) {
    const d = load();
    d.usage = d.usage || {};
    const k = `${userId}:${month}`;
    const row = d.usage[k] || (d.usage[k] = {});
    row[key] = (row[key] || 0) + n;
    row.updatedAt = Date.now();
    save();
    return row;
  },
  /** Drop counters older than `months` so the file cannot grow forever. */
  pruneUsage(months = 6, now = Date.now()) {
    const d = load();
    d.usage = d.usage || {};
    const cutoff = new Date(now);
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
    const floor = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
    let dropped = 0;
    for (const key of Object.keys(d.usage)) {
      const month = key.slice(key.indexOf(':') + 1);
      if (month < floor) { delete d.usage[key]; dropped++; }
    }
    if (dropped) save();
    return dropped;
  },

  // ---- saved replies (snippets) ----
  allSnippets() {
    const d = load();
    d.snippets = d.snippets || [];
    return d.snippets;
  },
  snippetsForUser(userId) {
    return this.allSnippets().filter((s) => s.userId === userId);
  },
  findSnippet(id) {
    return this.allSnippets().find((s) => s.id === id);
  },
  addSnippet(s) {
    this.allSnippets().push(s);
    save();
    return s;
  },
  updateSnippet(id, patch) {
    const s = this.findSnippet(id);
    if (!s) return null;
    Object.assign(s, patch);
    save();
    return s;
  },
  deleteSnippet(id) {
    const d = load();
    const before = (d.snippets || []).length;
    d.snippets = (d.snippets || []).filter((s) => s.id !== id);
    if (d.snippets.length !== before) { save(); return true; }
    return false;
  },

  // ---- settings (payment details, exchange rate) ----
  getSettings() {
    const d = load();
    d.settings = d.settings || {};
    return d.settings;
  },
  setSettings(patch) {
    const d = load();
    d.settings = Object.assign(d.settings || {}, patch);
    save();
    return d.settings;
  },

  // ---- payment submissions (user says "I paid", admin approves) ----
  allPayments() {
    const d = load();
    d.payments = d.payments || [];
    return d.payments;
  },
  addPayment(p) {
    this.allPayments().push(p);
    save();
    return p;
  },
  findPayment(id) {
    return this.allPayments().find((x) => x.id === id);
  },

  // ---- support messages (one thread per user) ----
  allMessages() {
    const d = load();
    d.messages = d.messages || [];
    return d.messages;
  },
  messagesForUser(userId) {
    return this.allMessages().filter((m) => m.userId === userId);
  },
  addMessage(msg) {
    const all = this.allMessages();
    all.push(msg);
    // keep each thread bounded so the database cannot grow without limit
    const mine = all.filter((m) => m.userId === msg.userId);
    if (mine.length > 200) {
      const drop = new Set(mine.slice(0, mine.length - 200).map((m) => m.id));
      load().messages = all.filter((m) => !drop.has(m.id));
    }
    save();
    return msg;
  },
  deleteThread(userId) {
    const d = load();
    d.messages = (d.messages || []).filter((m) => m.userId !== userId);
    save();
  },

  // ---- bots ----
  listBots() {
    return load().bots;
  },
  botsForUser(userId) {
    return load().bots.filter((b) => b.userId === userId);
  },
  findBotById(id) {
    return load().bots.find((b) => b.id === id);
  },
  addBot(bot) {
    load().bots.push(bot);
    save();
    return bot;
  },
  updateBot(id, patch) {
    const b = this.findBotById(id);
    if (!b) return null;
    Object.assign(b, patch);
    save();
    return b;
  },
  deleteBot(id) {
    const d = load();
    d.bots = d.bots.filter((b) => b.id !== id);
    save();
  },
};

module.exports = db;
