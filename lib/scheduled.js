/**
 * Scheduled messages for the web console ("send later").
 *
 * Jobs live in the platform database (db.data.scheduled), so they survive page closes, browser
 * restarts and - with MONGODB_URI set - Render redeploys. A ticker sends due jobs through the
 * bot's own number using the same RPC as the live console.
 *
 * Safety: the bot must be running to send. Jobs wait for it for up to GRACE_MS after their time,
 * then are marked failed. At most PER_TICK messages per bot per tick (15 s) so a pile of jobs
 * due at once cannot burst past WhatsApp's comfortable sending pace.
 */
const crypto = require('crypto');
const db = require('./store');
const bots = require('./bots');

const TICK_MS = 15_000;
const GRACE_MS = 15 * 60_000; // how long a due job waits for an offline bot
const MIN_LEAD_MS = 30_000;
const MAX_LEAD_MS = 90 * 24 * 3600_000;
const MAX_PENDING_PER_BOT = 50;
const PER_TICK = 3;
const MAX_ATTEMPTS = 3;
const KEEP_DONE_MS = 14 * 24 * 3600_000;

function jobs() {
  const d = db.data;
  if (!Array.isArray(d.scheduled)) d.scheduled = [];
  return d.scheduled;
}

const view = (j) => ({
  id: j.id, botId: j.botId, jid: j.jid, chatName: j.chatName || '', text: j.text, quotedId: j.quotedId || null,
  at: j.at, status: j.status, error: j.error || null, createdAt: j.createdAt, sentAt: j.sentAt || null,
});

function list(botId, jid) {
  return jobs()
    .filter((j) => j.botId === botId && (!jid || j.jid === jid))
    .sort((a, b) => a.at - b.at)
    .map(view);
}

function create(bot, user, body) {
  const b = body || {};
  const jid = String(b.jid || '');
  const text = String(b.text || '').trim();
  const at = Number(b.at);
  if (!/^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(jid)) throw Object.assign(new Error('Pick a chat first'), { status: 400 });
  if (!text) throw Object.assign(new Error('Message is empty'), { status: 400 });
  if (text.length > 4096) throw Object.assign(new Error('Message is too long (max 4096 characters)'), { status: 400 });
  if (!Number.isFinite(at)) throw Object.assign(new Error('Pick a date and time'), { status: 400 });
  const lead = at - Date.now();
  if (lead < MIN_LEAD_MS) throw Object.assign(new Error('Pick a time at least a minute from now'), { status: 400 });
  if (lead > MAX_LEAD_MS) throw Object.assign(new Error('You can schedule up to 90 days ahead'), { status: 400 });
  const pending = jobs().filter((j) => j.botId === bot.id && j.status === 'pending').length;
  if (pending >= MAX_PENDING_PER_BOT) throw Object.assign(new Error(`Limit reached: ${MAX_PENDING_PER_BOT} scheduled messages per bot`), { status: 400 });

  const job = {
    id: 'sch_' + crypto.randomBytes(6).toString('hex'),
    botId: bot.id, userId: user.id, jid, text,
    chatName: String(b.chatName || '').slice(0, 80),
    quotedId: b.quotedId ? String(b.quotedId).slice(0, 80) : undefined,
    at, status: 'pending', attempts: 0, createdAt: Date.now(),
  };
  jobs().push(job);
  db.save();
  return view(job);
}

function cancel(bot, id) {
  const j = jobs().find((x) => x.id === id && x.botId === bot.id);
  if (!j) throw Object.assign(new Error('Scheduled message not found'), { status: 404 });
  if (j.status !== 'pending') throw Object.assign(new Error('Already ' + j.status), { status: 409 });
  j.status = 'cancelled';
  db.save();
  return view(j);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const all = jobs();
    const sentThisTick = new Map();
    let dirty = false;

    for (const j of all.filter((x) => x.status === 'pending' && x.at <= now).sort((a, b) => a.at - b.at)) {
      const bot = db.findBotById(j.botId);
      if (!bot) { j.status = 'failed'; j.error = 'Bot was deleted'; dirty = true; continue; }
      if (!bots.status(j.botId).running) {
        if (now - j.at > GRACE_MS) { j.status = 'failed'; j.error = 'Bot was offline at the scheduled time'; dirty = true; }
        continue;
      }
      const n = sentThisTick.get(j.botId) || 0;
      if (n >= PER_TICK) continue; // next tick
      sentThisTick.set(j.botId, n + 1);
      j.attempts += 1;
      try {
        await bots.rpc(j.botId, 'send', { jid: j.jid, text: j.text, quotedId: j.quotedId }, 20000);
        j.status = 'sent'; j.sentAt = Date.now(); j.error = null;
      } catch (e) {
        j.error = String((e && e.message) || e).slice(0, 200);
        if (j.attempts >= MAX_ATTEMPTS) j.status = 'failed';
      }
      dirty = true;
    }

    // tidy old finished jobs
    const keep = all.filter((x) => x.status === 'pending' || now - (x.sentAt || x.at) < KEEP_DONE_MS);
    if (keep.length !== all.length) { db.data.scheduled = keep; dirty = true; }
    if (dirty) db.save();
  } catch (e) {
    console.error('[scheduled] tick failed:', e.message);
  } finally {
    ticking = false;
  }
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}

module.exports = { list, create, cancel, start, tick };
