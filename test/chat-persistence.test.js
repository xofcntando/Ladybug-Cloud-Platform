/**
 * Message persistence across a restart.
 *
 * The console's history lives in a per-bot webchat.json that the bot writes, and MongoDB
 * keeps a gzip'd copy of it. These tests exercise the archive module against an in-memory
 * MongoDB stub (no server needed) and prove the four things that make a restart safe:
 *
 *   1. a running bot's history is mirrored to MongoDB (not just once, on every change)
 *   2. a restart with an empty disk gets its history back
 *   3. a restart with a STALE disk file gets the newer cloud copy, not the old one
 *   4. the console can read history before the bot has started (ensure())
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/* ---- in-memory MongoDB, injected before chat-archive loads it ---- */
const store = new Map(); // botId -> gzip buffer
const mongoPath = require.resolve('../lib/mongo-sync');
const state = { enabled: true, ready: true, pushes: 0 };
require.cache[mongoPath] = {
  id: mongoPath,
  filename: mongoPath,
  loaded: true,
  exports: {
    status: () => ({ enabled: state.enabled, ready: state.ready, connected: true }),
    pushChatStore: async (id, gz) => { store.set(String(id), Buffer.from(gz)); state.pushes++; return true; },
    getChatStore: async (id) => (store.has(String(id)) ? { gz: store.get(String(id)), at: Date.now() } : null),
    deleteChatStore: async (id) => { store.delete(String(id)); },
  },
};

/* ---- a throwaway BOT_DIR so the real data is never touched ---- */
const BOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-archive-'));
process.env.BOT_DIR = BOT_DIR;

const archive = require('../lib/chat-archive');
const BOT = 'bottest0001';
const file = archive.fileFor(BOT);

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  \u2713 ' + name); };
const okAsync = async (name, fn) => { await fn(); pass++; console.log('  \u2713 ' + name); };
const section = (t) => console.log('\n' + t);

const snap = (savedAt, texts) => ({
  v: 1,
  savedAt,
  chats: [{ jid: '263771234567@s.whatsapp.net', name: 'Tendai', lastTs: savedAt, lastText: texts[texts.length - 1] }],
  msgs: {
    '263771234567@s.whatsapp.net': texts.map((t, i) => ({ id: 'm' + i, ts: 1000 + i, text: t, fromMe: false, type: 'text' })),
  },
  contacts: {},
});

function writeLocal(obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}
const readLocal = () => JSON.parse(fs.readFileSync(file, 'utf8'));

(async () => {
  section('Mirror to MongoDB');
  await okAsync('a saved history file is pushed to MongoDB', async () => {
    writeLocal(snap(1000, ['one', 'two']));
    assert.strictEqual(await archive.backupNow(BOT), true);
    assert.ok(store.has(BOT), 'nothing in the store');
    const back = JSON.parse(zlib.gunzipSync(store.get(BOT)).toString('utf8'));
    assert.strictEqual(back.msgs['263771234567@s.whatsapp.net'].length, 2);
  });

  await okAsync('the mirror is gzip\u2019d, not raw JSON', async () => {
    const raw = fs.readFileSync(file);
    const gz = store.get(BOT);
    assert.ok(gz.length < raw.length, 'gzip did not shrink the file');
    assert.strictEqual(gz[0], 0x1f);
    assert.strictEqual(gz[1], 0x8b);
  });

  await okAsync('a running bot keeps mirroring as its history grows', async () => {
    state.pushes = 0;
    writeLocal(snap(2000, ['one', 'two', 'three']));
    archive.scheduleBackup(BOT);
    // the loop ticks immediately, then every 20s; wait for the first tick to land
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(state.pushes >= 1, 'the mirror loop never fired');
    const back = JSON.parse(zlib.gunzipSync(store.get(BOT)).toString('utf8'));
    assert.strictEqual(back.savedAt, 2000);
    archive.unschedule(BOT);
  });

  section('Restart with an empty disk');
  await okAsync('history comes back from MongoDB', async () => {
    fs.rmSync(file, { force: true });
    assert.strictEqual(archive.has(BOT), false, 'file should be gone');
    assert.strictEqual(await archive.ensure(BOT), true);
    assert.strictEqual(archive.has(BOT), true);
    const got = archive.messages(BOT, { jid: '263771234567@s.whatsapp.net' });
    assert.strictEqual(got.messages.length, 3);
    assert.strictEqual(got.messages[2].text, 'three');
  });

  await okAsync('the restored file is byte-identical to the cloud copy', async () => {
    const cloud = JSON.parse(zlib.gunzipSync(store.get(BOT)).toString('utf8'));
    assert.deepStrictEqual(readLocal(), cloud);
  });

  await okAsync('the chat list is served while the bot is offline', async () => {
    const list = archive.chats(BOT, {});
    assert.ok(list, 'no chat list');
    assert.strictEqual(list.offline, true);
    assert.strictEqual(list.chats[0].name, 'Tendai');
    assert.strictEqual(list.chats[0].lastText, 'three');
  });

  section('Restart with a stale disk file');
  await okAsync('the newer cloud copy wins over an older local file', async () => {
    // disk says savedAt=500 (older), cloud says 2000 (newer)
    writeLocal(snap(500, ['stale']));
    assert.strictEqual(archive.messages(BOT, { jid: '263771234567@s.whatsapp.net' }).messages.length, 1);
    assert.strictEqual(await archive.restoreOne(BOT), true, 'did not restore');
    const got = archive.messages(BOT, { jid: '263771234567@s.whatsapp.net' });
    assert.strictEqual(got.messages.length, 3, 'stale history was kept');
  });

  await okAsync('a newer local file is left alone', async () => {
    writeLocal(snap(9000, ['newest', 'local']));
    assert.strictEqual(await archive.restoreOne(BOT), false, 'it overwrote newer local data');
    assert.strictEqual(readLocal().savedAt, 9000);
  });

  section('Boot restore');
  await okAsync('restoreAll fixes every bot, missing or stale', async () => {
    const B2 = 'bottest0002';
    const f2 = archive.fileFor(B2);
    // B2 has no local file at all
    store.set(B2, zlib.gzipSync(Buffer.from(JSON.stringify(snap(3000, ['cloud only'])))));
    // B1 has a stale file
    writeLocal(snap(1000, ['old']));
    const n = await archive.restoreAll([BOT, B2]);
    assert.strictEqual(n, 2, 'restored ' + n);
    assert.ok(fs.existsSync(f2));
    assert.strictEqual(archive.messages(B2, { jid: '263771234567@s.whatsapp.net' }).messages[0].text, 'cloud only');
    assert.strictEqual(archive.messages(BOT, { jid: '263771234567@s.whatsapp.net' }).messages.length, 3);
  });

  section('Shutdown flush');
  await okAsync('flushAll mirrors every bot before the client closes', async () => {
    writeLocal(snap(12000, ['last words']));
    const n = await archive.flushAll([BOT]);
    assert.strictEqual(n, 1);
    const back = JSON.parse(zlib.gunzipSync(store.get(BOT)).toString('utf8'));
    assert.strictEqual(back.savedAt, 12000);
    assert.strictEqual(back.msgs['263771234567@s.whatsapp.net'][0].text, 'last words');
  });

  section('No MongoDB configured');
  await okAsync('everything is a harmless no-op without a URI', async () => {
    state.enabled = false;
    state.ready = false;
    fs.rmSync(file, { force: true });
    assert.strictEqual(await archive.ensure(BOT), false);
    assert.strictEqual(await archive.backupNow(BOT), false);
    assert.strictEqual(await archive.restoreAll([BOT]), 0);
    archive.scheduleBackup(BOT); // must not throw or spin
    archive.unschedule(BOT);
    state.enabled = true;
    state.ready = true;
  });

  section('Deleting a bot');
  await okAsync('purge removes the local file and the cloud copy', async () => {
    writeLocal(snap(1, ['x']));
    archive.purge(BOT);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(store.has(BOT), false);
  });

  console.log('\n' + pass + ' passed, 0 failed');
  fs.rmSync(BOT_DIR, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
