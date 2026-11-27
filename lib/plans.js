/**
 * Plans and limits.
 *
 * Billing (lib/billing.js) answers "may this bot run right now?" — coins, trial,
 * $3 Unlimited, add-ons. This module answers the other question a paying customer
 * asks: "what exactly do I get, and how much of it have I used?"
 *
 * Four plans, all enforced by the same numbers:
 *
 *   free     7-day trial, 1 bot,  2,000 messages/mo,  200 AI replies/mo,  7-day history
 *   starter  $3/mo (the existing "Unlimited"), 1 bot, 10,000 messages/mo, 1,000 AI, 30-day history
 *   pro      $8/mo, 3 bots, 60,000 messages/mo, 6,000 AI, 90-day history, API Pass included
 *   studio   $20/mo, 10 bots, 300,000 messages/mo, 30,000 AI, 1-year history, API Pass included
 *
 * The plan is stored on the user as `planKey` + `planUntil`. Buying a plan also
 * pushes `subscriptionUntil` and `botLimit`, so every existing billing check
 * (runsFree, botLimitFor, createBotFor) keeps working without special cases.
 *
 * Everything is overridable through environment variables so a deployment can
 * re-price without a code change.
 */
const billing = require('./billing');

const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

const DAY = billing.DAY;

const PLANS = {
  free: {
    key: 'free',
    name: 'Free trial',
    usd: 0,
    days: () => billing.cfg.trialDays,
    bots: () => num(process.env.PLAN_FREE_BOTS, billing.cfg.baseBotLimit),
    messages: () => num(process.env.PLAN_FREE_MESSAGES, 2000),
    ai: () => num(process.env.PLAN_FREE_AI, 200),
    historyDays: () => num(process.env.PLAN_FREE_HISTORY_DAYS, 7),
    api: () => false,
    blurb: 'Try everything for a week. One bot, enough messages to see if it fits.',
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    usd: () => billing.cfg.priceUsd,
    days: () => billing.cfg.subscriptionDays,
    bots: () => num(process.env.PLAN_STARTER_BOTS, 1),
    messages: () => num(process.env.PLAN_STARTER_MESSAGES, 10000),
    ai: () => num(process.env.PLAN_STARTER_AI, 1000),
    historyDays: () => num(process.env.PLAN_STARTER_HISTORY_DAYS, 30),
    api: () => false,
    blurb: 'One number online all month, no coins to remember.',
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    usd: () => num(process.env.PLAN_PRO_USD, 8),
    days: () => num(process.env.PLAN_PRO_DAYS, 30),
    bots: () => num(process.env.PLAN_PRO_BOTS, 3),
    messages: () => num(process.env.PLAN_PRO_MESSAGES, 60000),
    ai: () => num(process.env.PLAN_PRO_AI, 6000),
    historyDays: () => num(process.env.PLAN_PRO_HISTORY_DAYS, 90),
    api: () => true,
    blurb: 'Three bots, the API Pass, and room for a busy group or two.',
  },
  studio: {
    key: 'studio',
    name: 'Studio',
    usd: () => num(process.env.PLAN_STUDIO_USD, 20),
    days: () => num(process.env.PLAN_STUDIO_DAYS, 30),
    bots: () => num(process.env.PLAN_STUDIO_BOTS, 10),
    messages: () => num(process.env.PLAN_STUDIO_MESSAGES, 300000),
    ai: () => num(process.env.PLAN_STUDIO_AI, 30000),
    historyDays: () => num(process.env.PLAN_STUDIO_HISTORY_DAYS, 365),
    api: () => true,
    blurb: 'For resellers and teams running a fleet of numbers.',
  },
};

const KEYS = Object.keys(PLANS);
const PAID = KEYS.filter((k) => k !== 'free');

/** Plans that can be bought through the normal payment flow. */
function paidPlans() {
  return PAID.map((k) => view(k));
}

function view(key) {
  const p = PLANS[key];
  if (!p) return null;
  return {
    key: p.key,
    name: p.name,
    usd: typeof p.usd === 'function' ? p.usd() : p.usd,
    days: p.days(),
    bots: p.bots(),
    messages: p.messages(),
    ai: p.ai(),
    historyDays: p.historyDays(),
    api: p.api(),
    blurb: p.blurb,
  };
}

function catalog() {
  return KEYS.map(view);
}

/** Is a stored paid plan still inside its window? */
function planActive(user, at = Date.now()) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!user.planKey || !PLANS[user.planKey]) return false;
  return !!(user.planUntil && user.planUntil > at);
}

/**
 * Which plan is this user on right now?
 * Admin > an unexpired paid plan > $3 Unlimited subscription > free trial.
 */
function planKeyFor(user, at = Date.now()) {
  if (!user) return 'free';
  if (user.isAdmin) return 'studio';
  if (planActive(user, at)) return user.planKey;
  if (user.subscriptionUntil && user.subscriptionUntil > at) return 'starter';
  return 'free';
}

/**
 * The numbers a user is held to. Extra bot slots bought as a $1 add-on still
 * count on top, because those are sold separately from the plan.
 */
function limitsFor(user, at = Date.now()) {
  const key = planKeyFor(user, at);
  const p = PLANS[key];
  return {
    key,
    name: p.name,
    usd: typeof p.usd === 'function' ? p.usd() : p.usd,
    bots: p.bots() + billing.extraSlotCount(user, at),
    messages: p.messages(),
    ai: p.ai(),
    historyDays: p.historyDays(),
    api: p.api() || billing.featureActive(user, 'api', at),
  };
}

/**
 * Switch a plan on (or extend it). Buying the same plan again stacks the days.
 * `days <= 0` drops back to the free plan.
 */
function grantPlan(user, key, days) {
  if (!user) return null;
  const p = PLANS[key];
  if (!p || key === 'free') {
    user.planKey = null;
    user.planUntil = null;
    return null;
  }
  const n = days == null ? p.days() : days;
  const at = Date.now();
  if (!(n > 0)) {
    user.planKey = null;
    user.planUntil = null;
    return null;
  }
  // Extending the same plan stacks; switching plans starts a fresh window.
  const same = user.planKey === key && user.planUntil && user.planUntil > at;
  const base = same ? user.planUntil : at;
  user.planKey = key;
  user.planUntil = base + n * DAY;
  // Keep the legacy fields in step so every existing check agrees.
  user.subscriptionUntil = user.planUntil;
  user.botLimit = p.bots();
  return { key, until: user.planUntil, days: n };
}

/** Days left on a paid plan (0 when free). */
function planDaysLeft(user, at = Date.now()) {
  if (!planActive(user, at)) return 0;
  return Math.max(0, Math.ceil((user.planUntil - at) / DAY));
}

/**
 * Grace period: when a paid plan or the trial lapses the bots keep running for
 * a couple of days while the owner is reminded, instead of dying mid-conversation.
 */
function graceDays() {
  return num(process.env.GRACE_DAYS, 2);
}

function graceFor(user, at = Date.now()) {
  const days = graceDays();
  if (!user || user.isAdmin || days <= 0) return { active: false, until: null, daysLeft: 0, days };
  // Already running free: no grace to give.
  if (billing.runsFree(user, at)) return { active: false, until: null, daysLeft: 0, days };
  // The most recent thing that expired decides the grace window.
  const ended = Math.max(
    user.planUntil && user.planUntil <= at ? user.planUntil : 0,
    user.subscriptionUntil && user.subscriptionUntil <= at ? user.subscriptionUntil : 0,
    user.trialEndsAt && user.trialEndsAt <= at ? user.trialEndsAt : 0
  );
  if (!ended) return { active: false, until: null, daysLeft: 0, days };
  const until = ended + days * DAY;
  const active = until > at;
  return { active, until, daysLeft: active ? Math.max(1, Math.ceil((until - at) / DAY)) : 0, days };
}

/** Everything the dashboard needs to draw the plan card. */
function summary(user, at = Date.now()) {
  const key = planKeyFor(user, at);
  const lim = limitsFor(user, at);
  const paid = planActive(user, at);
  return {
    key,
    name: lim.name,
    usd: lim.usd,
    limits: { bots: lim.bots, messages: lim.messages, ai: lim.ai, historyDays: lim.historyDays, api: lim.api },
    until: paid ? user.planUntil : (user.subscriptionUntil && user.subscriptionUntil > at ? user.subscriptionUntil : null),
    daysLeft: paid ? planDaysLeft(user, at) : 0,
    paid,
    grace: graceFor(user, at),
    plans: catalog(),
    paidPlans: paidPlans(),
  };
}

module.exports = {
  PLANS,
  KEYS,
  PAID,
  DAY,
  catalog,
  view,
  paidPlans,
  planActive,
  planKeyFor,
  limitsFor,
  grantPlan,
  planDaysLeft,
  graceDays,
  graceFor,
  summary,
};
