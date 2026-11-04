/**
 * Signed event webhooks (API Pass).
 *
 * A user can register up to 5 HTTPS endpoints. We POST a JSON event to each one
 * that subscribed to it:
 *
 *   {
 *     "id": "evt_...", "type": "bot.crashed", "created": "2026-...Z",
 *     "data": { "bot": { "id": "...", "name": "..." }, "detail": "Exited with code 1" }
 *   }
 *
 * Headers:
 *   X-Ladybug-Event      bot.crashed
 *   X-Ladybug-Delivery   unique delivery id
 *   X-Ladybug-Timestamp  unix seconds
 *   X-Ladybug-Signature  v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>" using the webhook secret>
 *
 * Reject requests whose timestamp is older than 5 minutes to stop replays.
 * Failed deliveries are retried 3 times (now, +5s, +30s). After 20 failed
 * deliveries in a row the endpoint is switched off until re-enabled.
 */
const crypto = require('crypto');
const db = require('./store');
const billing = require('./billing');
const alerts = require('./alerts');
const events = require('./events');

const EVENT_TYPES = ['bot.started', 'bot.stopped', 'bot.crashed', 'bot.online', 'bot.logged_out', 'bot.conflict', 'webhook.test'];
const BOT_EVENTS = EVENT_TYPES.filter((e) => e.startsWith('bot.'));
const TIMEOUT_MS = 8000;
const RETRY_DELAYS = [0, 5000, 30000];
const DISABLE_AFTER = 20;
const MAX_PER_MIN = 20;

const sentThisMinute = new Map(); // webhookId -> { n, reset }

function view(w) {
  return {
    id: w.id,
    url: w.url,
    events: w.events,
    active: w.active !== false,
    createdAt: w.createdAt,
    lastDeliveryAt: w.lastAt || null,
    lastStatus: w.lastStatus || null,
    consecutiveFailures: w.failures || 0,
    recent: (w.recent || []).slice(0, 10),
  };
}

function list(user) {
  return (user.webhooks || []).map(view);
}

async function create(user, { url, events: evs }) {
  const limits = billing.apiLimits(user);
  if (!limits.pro) return { code: 402, error: 'Webhooks need the API Pass.' };
  user.webhooks = user.webhooks || [];
  if (user.webhooks.length >= limits.maxWebhooks) return { code: 400, error: `You can have at most ${limits.maxWebhooks} webhooks.` };
  let parsed;
  try { parsed = await alerts.assertSafeUrl(String(url || '').trim()); } catch (e) { return { code: 400, error: e.message }; }
  let chosen = BOT_EVENTS;
  if (evs != null) {
    if (!Array.isArray(evs) || !evs.length) return { code: 400, error: 'events must be a non-empty list.' };
    const bad = evs.find((e) => !BOT_EVENTS.includes(e));
    if (bad) return { code: 400, error: `Unknown event "${bad}". Allowed: ${BOT_EVENTS.join(', ')}` };
    chosen = [...new Set(evs)];
  }
  const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');
  const rec = {
    id: crypto.randomBytes(6).toString('hex'),
    url: parsed.toString(),
    secret,
    events: chosen,
    active: true,
    createdAt: new Date().toISOString(),
    failures: 0,
    recent: [],
  };
  user.webhooks.push(rec);
  db.save();
  return { webhook: view(rec), secret };
}

function remove(user, id) {
  const before = (user.webhooks || []).length;
  user.webhooks = (user.webhooks || []).filter((w) => w.id !== id);
  if (user.webhooks.length === before) return false;
  db.save();
  return true;
}

function setActive(user, id, active) {
  const w = (user.webhooks || []).find((x) => x.id === id);
  if (!w) return null;
  w.active = !!active;
  if (active) w.failures = 0;
  db.save();
  return view(w);
}

const sign = (secret, ts, body) => 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

async function attempt(w, type, body, deliveryId) {
  const u = await alerts.assertSafeUrl(w.url);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(u, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'LadybugCloud-Webhooks/1.0',
      'X-Ladybug-Event': type,
      'X-Ladybug-Delivery': deliveryId,
      'X-Ladybug-Timestamp': String(ts),
      'X-Ladybug-Signature': sign(w.secret, ts, body),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res.status;
}

function record(w, type, ok, status, note) {
  w.recent = w.recent || [];
  w.recent.unshift({ at: new Date().toISOString(), event: type, ok, status: status || null, note: note || '' });
  if (w.recent.length > 10) w.recent.length = 10;
  w.lastAt = new Date().toISOString();
  w.lastStatus = ok ? status : note || String(status);
  if (ok) w.failures = 0;
  else {
    w.failures = (w.failures || 0) + 1;
    if (w.failures >= DISABLE_AFTER) w.active = false;
  }
  db.save();
}

/** Deliver one event to one webhook with retries. Resolves to { ok, status }. */
async function deliver(w, type, data) {
  const deliveryId = 'dlv_' + crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({
    id: 'evt_' + crypto.randomBytes(8).toString('hex'),
    type,
    created: new Date().toISOString(),
    data,
  });
  let lastStatus = null;
  let lastNote = '';
  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    if (RETRY_DELAYS[i]) await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
    try {
      lastStatus = await attempt(w, type, body, deliveryId);
      if (lastStatus >= 200 && lastStatus < 300) {
        record(w, type, true, lastStatus);
        return { ok: true, status: lastStatus };
      }
      lastNote = `HTTP ${lastStatus}`;
      if (lastStatus >= 300 && lastStatus < 500 && lastStatus !== 408 && lastStatus !== 429) break; // client error, retrying won't help
    } catch (e) {
      lastNote = String(e.message || e).slice(0, 120);
    }
  }
  record(w, type, false, lastStatus, lastNote);
  return { ok: false, status: lastStatus, error: lastNote };
}

function underRateLimit(w) {
  const now = Date.now();
  let e = sentThisMinute.get(w.id);
  if (!e || e.reset <= now) { e = { n: 0, reset: now + 60_000 }; sentThisMinute.set(w.id, e); }
  e.n++;
  return e.n <= MAX_PER_MIN;
}

async function sendTest(user, id) {
  const w = (user.webhooks || []).find((x) => x.id === id);
  if (!w) return null;
  return deliver(w, 'webhook.test', { message: 'Hello from Ladybug Cloud. Your webhook works!' });
}

// ---- wire up to the bot event bus
events.bus.on('bot', ({ botId, type, detail }) => {
  try {
    const bot = db.findBotById(botId);
    if (!bot) return;
    const owner = db.findUserById(bot.userId);
    if (!owner || !owner.webhooks || !owner.webhooks.length) return;
    if (!billing.featureActive(owner, 'api')) return;
    const full = `bot.${type}`;
    if (!BOT_EVENTS.includes(full)) return;
    for (const w of owner.webhooks) {
      if (w.active === false || !w.events.includes(full)) continue;
      if (!underRateLimit(w)) continue;
      deliver(w, full, { bot: { id: bot.id, name: bot.name }, detail: detail || null }).catch(() => {});
    }
  } catch (e) { console.error('[webhooks]', e.message); }
});

module.exports = { list, create, remove, setActive, sendTest, deliver, EVENT_TYPES, BOT_EVENTS, sign };
