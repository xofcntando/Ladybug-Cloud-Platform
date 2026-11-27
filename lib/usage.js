/**
 * Usage metering and invoices — the "how much of my plan have I used?" half of
 * monetization.
 *
 * Counters live in db.usage under "<userId>:<YYYY-MM>", one row per user per
 * month, and are bumped with usage.record(). They are cheap (a number per kind),
 * survive restarts, and are pruned after six months so db.json stays small.
 *
 * Kinds recorded today:
 *   messages   one per WhatsApp message the bot sends (console, commands, digests)
 *   ai         one per AI reply
 *   commands   one per bot command run
 *   botStarts  one per start / restart
 *   claims     one per daily coin claim
 *
 * Nothing here blocks a bot by itself: `check()` returns a verdict and the
 * caller decides. Soft limits keep a paying customer online; the meter and the
 * warning banner do the persuading.
 */
const db = require('./store');
const billing = require('./billing');
const plans = require('./plans');

const KINDS = ['messages', 'ai', 'commands', 'botStarts', 'claims'];
const KEEP_MONTHS = 6;

const pad2 = (n) => String(n).padStart(2, '0');

/** "2026-03" for the UTC month of `date`. */
function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

/** First millisecond of a "YYYY-MM" month. */
function monthStart(month) {
  const [y, m] = String(month).split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, 1);
}

/** "2026-03" minus n months. */
function shiftMonth(month, n) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(Date.UTC(y, (m || 1) - 1 + n, 1));
  return monthKey(d);
}

let lastPrune = 0;

/** Add n to one counter. Returns the fresh row, or null for bad input. */
function record(userId, kind, n = 1, at = Date.now()) {
  if (!userId || !KINDS.includes(kind)) return null;
  const amount = Number(n);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const row = db.bumpUsage(userId, monthKey(new Date(at)), kind, amount);
  if (at - lastPrune > billing.DAY) {
    lastPrune = at;
    try { db.pruneUsage(KEEP_MONTHS, at); } catch (e) { /* never break a send over housekeeping */ }
  }
  return row;
}

function meter(used, cap) {
  const limited = Number(cap) > 0;
  const u = Math.max(0, Math.round(used || 0));
  return {
    used: u,
    cap: limited ? Math.round(cap) : null,
    pct: limited ? Math.min(100, Math.round((u / cap) * 100)) : 0,
    left: limited ? Math.max(0, Math.round(cap) - u) : null,
    over: limited ? u >= cap : false,
    warn: limited ? u >= cap * 0.8 : false,
  };
}

/** Is this user allowed another `kind` right now? Soft check, never throws. */
function check(user, kind, at = Date.now()) {
  const lim = plans.limitsFor(user, at);
  const cap = kind === 'messages' ? lim.messages : kind === 'ai' ? lim.ai : null;
  if (!cap || cap <= 0) return { ok: true, kind, used: 0, cap: null };
  const used = db.usageFor(user.id, monthKey(new Date(at)))[kind] || 0;
  const ok = used < cap;
  return {
    ok,
    kind,
    used,
    cap,
    message: ok ? '' : `${lim.name} allows ${cap.toLocaleString('en-US')} ${kind} a month. Upgrade your plan to keep going.`,
  };
}

/**
 * The full usage picture for the dashboard: this month's meters, the bots
 * used against the plan, a six-month history, and the grace window.
 */
function view(user, at = Date.now()) {
  const month = monthKey(new Date(at));
  const row = db.usageFor(user.id, month);
  const lim = plans.limitsFor(user, at);
  const bots = db.botsForUser(user.id);
  const history = [];
  for (let i = 0; i < KEEP_MONTHS; i++) {
    const m = shiftMonth(month, -i);
    const r = db.usageFor(user.id, m);
    history.push({
      month: m,
      messages: r.messages || 0,
      ai: r.ai || 0,
      commands: r.commands || 0,
      botStarts: r.botStarts || 0,
    });
  }
  return {
    month,
    monthLabel: new Date(monthStart(month)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    since: monthStart(month),
    plan: { key: lim.key, name: lim.name, usd: lim.usd, historyDays: lim.historyDays, api: lim.api },
    meters: {
      messages: meter(row.messages || 0, lim.messages),
      ai: meter(row.ai || 0, lim.ai),
    },
    counters: {
      commands: row.commands || 0,
      botStarts: row.botStarts || 0,
      claims: row.claims || 0,
    },
    bots: { used: bots.length, cap: lim.bots, running: bots.filter((b) => b.status === 'running').length },
    history,
    grace: plans.graceFor(user, at),
    upgrade: lim.key === 'studio' ? null : plans.paidPlans().filter((p) => p.usd > lim.usd).map((p) => p.key),
  };
}

/* ------------------------------------------------------------------ invoices */

/** "LB-202603-4F2A" — stable, readable, and safe to quote to support. */
function invoiceNumber(p) {
  const d = new Date(p.createdAt || Date.now());
  const tail = String(p.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || '0000';
  return `LB-${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}-${tail}`;
}

function invoiceView(p) {
  return {
    id: p.id,
    number: invoiceNumber(p),
    at: p.createdAt || null,
    date: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : '',
    item: p.item,
    itemName: p.itemName || p.item,
    qty: p.qty || 1,
    currency: p.currency || 'USD',
    amount: p.amount,
    amountUsd: p.amountUsd,
    status: p.status,
    reference: p.reference || '',
    decidedAt: p.decidedAt || null,
    reason: p.reason || '',
  };
}

/**
 * Every payment this user ever submitted, newest first, plus the totals a
 * customer expects on a billing page.
 */
function invoices(user) {
  const items = db.allPayments()
    .filter((p) => p.userId === user.id)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(invoiceView);
  const sum = (status) => Math.round(items.filter((i) => i.status === status).reduce((n, i) => n + (Number(i.amountUsd) || 0), 0) * 100) / 100;
  return {
    items,
    count: items.length,
    paidUsd: sum('approved'),
    pendingUsd: sum('pending'),
    rejectedUsd: sum('rejected'),
    currency: 'USD',
    plan: plans.summary(user),
  };
}

/** One invoice with the account block a printable receipt needs. */
function invoice(user, id) {
  const p = db.allPayments().find((x) => x.id === id && x.userId === user.id);
  if (!p) return null;
  const plan = plans.summary(user);
  return {
    invoice: invoiceView(p),
    account: { username: user.username, email: user.email || '', joined: user.createdAt || null },
    plan: { key: plan.key, name: plan.name, usd: plan.usd, until: plan.until },
    seller: { name: 'Ladybug Cloud', by: 'Ntandomods', support: 'Contact admin from the dashboard' },
  };
}

module.exports = {
  KINDS,
  KEEP_MONTHS,
  monthKey,
  monthStart,
  shiftMonth,
  record,
  meter,
  check,
  view,
  invoiceNumber,
  invoiceView,
  invoices,
  invoice,
};
