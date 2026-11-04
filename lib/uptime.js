/**
 * Uptime history.
 *
 * Every minute we look at each bot its owner WANTS running (status 'running')
 * and record whether it really was. Samples are stored per bot in hourly
 * buckets (`bot.uptime[hourIndex] = [upMinutes, expectedMinutes]`) and kept for
 * 30 days. Crashes, starts and stops go into `bot.events` (last 40).
 *
 * Free users see the last 24 hours; the paid "Uptime history" pass unlocks 30 days.
 */
const HOUR = 60 * 60 * 1000;
const KEEP_HOURS = 30 * 24;
const MAX_EVENTS = 40;
const SAVE_EVERY_MS = 10 * 60 * 1000;

let lastSave = Date.now();
let dirty = false;

const hourIndex = (at = Date.now()) => Math.floor(at / HOUR);

/** Called once a minute with the live bot list + a runtime lookup. */
function tick(botList, isAlive, store, at = Date.now()) {
  const h = hourIndex(at);
  for (const bot of botList) {
    if (bot.status !== 'running' || !bot.sessionId) continue;
    bot.uptime = bot.uptime || {};
    const cell = bot.uptime[h] || (bot.uptime[h] = [0, 0]);
    cell[1] += 1;
    if (isAlive(bot.id)) cell[0] += 1;
    for (const k of Object.keys(bot.uptime)) if (Number(k) < h - KEEP_HOURS) delete bot.uptime[k];
    dirty = true;
  }
  if (dirty && at - lastSave >= SAVE_EVERY_MS) {
    store.save();
    dirty = false;
    lastSave = at;
  }
}

/** Remember something that happened to a bot (started / stopped / crashed). */
function recordEvent(store, botId, type, note) {
  const bot = store.findBotById(botId);
  if (!bot) return;
  bot.events = bot.events || [];
  bot.events.unshift({ t: Date.now(), type, note: note ? String(note).slice(0, 200) : '' });
  if (bot.events.length > MAX_EVENTS) bot.events.length = MAX_EVENTS;
  store.save();
}

const pct = (up, exp) => (exp > 0 ? Math.round((up / exp) * 1000) / 10 : null);

function sum(bot, fromHour, toHour) {
  let up = 0, exp = 0;
  const u = bot.uptime || {};
  for (let h = fromHour; h <= toHour; h++) {
    if (u[h]) { up += u[h][0]; exp += u[h][1]; }
  }
  return { up, exp };
}

/**
 * Build the report for one bot.
 * @param {boolean} full  true = paid (30 days + full event list)
 */
function report(bot, full, at = Date.now()) {
  const now = hourIndex(at);
  const hours = [];
  for (let i = 23; i >= 0; i--) {
    const h = now - i;
    const c = (bot.uptime || {})[h];
    hours.push({ t: h * HOUR, pct: c ? pct(c[0], c[1]) : null });
  }
  const d24 = sum(bot, now - 23, now);
  const out = {
    full: !!full,
    last24h: { pct: pct(d24.up, d24.exp), hours },
    events: (bot.events || []).slice(0, full ? MAX_EVENTS : 5),
    crashes24h: (bot.events || []).filter((e) => e.type === 'crashed' && e.t > at - 24 * HOUR).length,
  };
  if (full) {
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const s = sum(bot, now - i * 24 - 23, now - i * 24);
      days.push({ t: (now - i * 24) * HOUR, pct: pct(s.up, s.exp) });
    }
    const d7 = sum(bot, now - 7 * 24 + 1, now);
    const d30 = sum(bot, now - 30 * 24 + 1, now);
    out.days = days;
    out.pct7 = pct(d7.up, d7.exp);
    out.pct30 = pct(d30.up, d30.exp);
    out.crashes30d = (bot.events || []).filter((e) => e.type === 'crashed' && e.t > at - 30 * 24 * HOUR).length;
  }
  return out;
}

/* ---- resource history (API Pass): hourly memory / CPU averages, kept 7 days ---- */
const RES_KEEP_HOURS = 7 * 24;

/** Called once a minute. getRes(botId) -> { memMB, cpu } | null */
function recordResources(botList, getRes, at = Date.now()) {
  const h = hourIndex(at);
  for (const bot of botList) {
    const r = getRes(bot.id);
    if (!r) continue;
    bot.res = bot.res || {};
    const c = bot.res[h] || (bot.res[h] = [0, 0, 0, 0]); // [samples, sumMem, sumCpu, maxMem]
    c[0] += 1;
    c[1] += r.memMB;
    c[2] += r.cpu;
    c[3] = Math.max(c[3], r.memMB);
    for (const k of Object.keys(bot.res)) if (Number(k) < h - RES_KEEP_HOURS) delete bot.res[k];
    dirty = true;
  }
}

function resourceReport(bot, hours = 24, at = Date.now()) {
  const now = hourIndex(at);
  const n = Math.min(Math.max(1, hours), RES_KEEP_HOURS);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const h = now - i;
    const c = (bot.res || {})[h];
    out.push({
      t: new Date(h * HOUR).toISOString(),
      avgMemMB: c ? Math.round((c[1] / c[0]) * 10) / 10 : null,
      maxMemMB: c ? Math.round(c[3] * 10) / 10 : null,
      avgCpuPct: c ? Math.round((c[2] / c[0]) * 10) / 10 : null,
    });
  }
  return out;
}

module.exports = { tick, recordEvent, report, recordResources, resourceReport, HOUR };
