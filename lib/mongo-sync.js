/**
 * Optional MongoDB backup.
 *
 * Set MONGODB_URI (e.g. a free MongoDB Atlas cluster) and Ladybug Cloud will:
 *   - mirror the whole database (users, bots, coins, subscriptions) to MongoDB
 *     a couple of seconds after every change,
 *   - mirror login sessions,
 *   - restore both automatically on boot when the local disk is empty
 *     (Render free plan wipes it on every redeploy / wake from sleep).
 *
 * Without MONGODB_URI everything is a harmless no-op and the local JSON file
 * store is used on its own.
 */
const fs = require('fs');
const path = require('path');

const URI = process.env.MONGODB_URI || process.env.MONGO_URL || '';
const DB_NAME = process.env.MONGODB_DB || 'ladybug_cloud';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESS_DIR = path.join(DATA_DIR, 'sessions');

const state = {
  enabled: !!URI,
  connected: false,
  ready: false, // true only after a successful restore check - guards against overwriting the backup with an empty db
  lastPushAt: null,
  lastRestoreAt: null,
  restored: null, // what was restored on boot
  lastError: null,
};

let client = null;
let cols = null;
let pushTimer = null;
let pendingDb = null;

async function connect() {
  const { MongoClient } = require('mongodb');
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(DB_NAME);
  cols = { main: db.collection('backup'), sessions: db.collection('sessions') };
  state.connected = true;
}

function readLocalDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function restore() {
  if (!state.enabled) return state;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !state.connected; attempt++) {
    try {
      await connect();
    } catch (e) {
      lastErr = e;
      console.error(`[mongo] connect attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!state.connected) {
    state.lastError = lastErr ? lastErr.message : 'connection failed';
    console.error('[mongo] BACKUP DISABLED for this run (could not connect). Check MONGODB_URI / Atlas network access (allow 0.0.0.0/0).');
    return state;
  }

  try {
    const remote = await cols.main.findOne({ _id: 'db' });
    const local = readLocalDb();
    const remoteAt = remote && remote.data && remote.data.meta && remote.data.meta.savedAt || 0;
    const localAt = local && local.meta && local.meta.savedAt || 0;

    if (remote && remote.data && remoteAt > localAt) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(remote.data, null, 2));
      state.restored = { users: (remote.data.users || []).length, bots: (remote.data.bots || []).length };
      console.log(`[mongo] restored ${state.restored.users} user(s), ${state.restored.bots} bot(s) from MongoDB`);
    } else if (local) {
      console.log('[mongo] local data is current; backing it up');
      pendingDb = JSON.stringify(local);
    }

    // sessions
    fs.mkdirSync(SESS_DIR, { recursive: true });
    let n = 0;
    for await (const doc of cols.sessions.find({})) {
      const file = path.join(SESS_DIR, doc._id + '.json');
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(doc.sess));
        n++;
      }
    }
    if (n) console.log(`[mongo] restored ${n} login session(s)`);

    // secrets file for stable cookie signing
    const secret = await cols.main.findOne({ _id: 'secret' });
    const secretFile = path.join(DATA_DIR, '.session-secret');
    if (secret && secret.value && !fs.existsSync(secretFile)) fs.writeFileSync(secretFile, secret.value, { mode: 0o600 });

    state.ready = true;
    state.lastRestoreAt = Date.now();
    state.lastError = null;
    if (pendingDb) schedulePush();
    // local sessions that Mongo doesn't know yet
    syncLocalSessions().catch(() => {});
    syncSecret().catch(() => {});
  } catch (e) {
    state.lastError = e.message;
    console.error('[mongo] restore failed - backup disabled for this run:', e.message);
  }
  return state;
}

async function syncLocalSessions() {
  if (!state.ready) return;
  for (const f of fs.readdirSync(SESS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const sess = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8'));
      await cols.sessions.updateOne({ _id: f.slice(0, -5) }, { $set: { sess, at: Date.now() } }, { upsert: true });
    } catch (e) { /* skip */ }
  }
}

async function syncSecret() {
  const f = path.join(DATA_DIR, '.session-secret');
  if (!state.ready || !fs.existsSync(f)) return;
  await cols.main.updateOne({ _id: 'secret' }, { $setOnInsert: { value: fs.readFileSync(f, 'utf8').trim() } }, { upsert: true });
}

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    await flush();
  }, 2000);
  if (pushTimer.unref) pushTimer.unref();
}

/** Called by the store after every write with the serialized db. */
function pushDb(json) {
  if (!state.enabled) return;
  pendingDb = json;
  if (state.ready) schedulePush();
}

async function flush() {
  if (!state.enabled || !state.ready || !pendingDb) return;
  const json = pendingDb;
  pendingDb = null;
  try {
    await cols.main.updateOne({ _id: 'db' }, { $set: { data: JSON.parse(json), updatedAt: new Date() } }, { upsert: true });
    state.lastPushAt = Date.now();
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
    if (!pendingDb) pendingDb = json; // retry on next change
    console.error('[mongo] backup push failed:', e.message);
  }
}

function pushSession(sid, sess) {
  if (!state.ready) return;
  const id = String(sid).replace(/[^A-Za-z0-9_-]/g, '_');
  cols.sessions.updateOne({ _id: id }, { $set: { sess, at: Date.now() } }, { upsert: true }).catch((e) => {
    state.lastError = e.message;
  });
}

function deleteSession(sid) {
  if (!state.ready) return;
  const id = String(sid).replace(/[^A-Za-z0-9_-]/g, '_');
  cols.sessions.deleteOne({ _id: id }).catch(() => {});
}

async function close() {
  try {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    await Promise.race([flush(), new Promise((r) => setTimeout(r, 3000))]);
    if (client) await client.close();
  } catch (e) { /* ignore */ }
}

function status() {
  return {
    enabled: state.enabled,
    connected: state.connected,
    ready: state.ready,
    lastPushAt: state.lastPushAt,
    lastRestoreAt: state.lastRestoreAt,
    restored: state.restored,
    lastError: state.lastError,
  };
}

/** Connected database handle (null until the boot-time restore succeeded). */
function getDb() {
  return client && state.connected && state.ready ? client.db(DB_NAME) : null;
}

module.exports = { getDb, syncSecret, restore, pushDb, flush, pushSession, deleteSession, close, status };
