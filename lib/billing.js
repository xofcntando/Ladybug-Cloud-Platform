/**
 * Billing rules for Ladybug Cloud.
 *
 *  1. Every new account gets a FREE TRIAL (default 7 days) for its bot.
 *  2. After the trial a bot keeps running if EITHER
 *       - the owner has an active $3/month subscription, OR
 *       - the owner pays for it with coins (default 20 coins per day of runtime).
 *  3. Every user can CLAIM free coins once per day (default 20), so claiming
 *     daily keeps one bot running for free.
 *  4. AUTO-CLAIM is a $2/month add-on: the server claims the daily coins for
 *     you, so a forgotten claim can no longer pause a running bot.
 *  5. EXTRA BOT SLOT is a $1/month add-on: each purchase adds one bot slot on
 *     top of the plan's limit. Slots stack and share one expiry date, which is
 *     pushed out 30 days by every new purchase.
 *
 * Everything is configurable through environment variables.
 */
const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

const DAY = 24 * 60 * 60 * 1000;

const cfg = {
  trialDays: num(process.env.TRIAL_DAYS, 7),
  claimCoins: num(process.env.CLAIM_COINS, 20),
  claimCooldownHours: num(process.env.CLAIM_COOLDOWN_HOURS, 24),
  maxCoins: num(process.env.MAX_COINS, 140),
  botCoinCost: num(process.env.BOT_COIN_COST, 20), // coins per period
  botPeriodDays: num(process.env.BOT_COIN_PERIOD_DAYS, 1), // days of runtime one payment buys
  priceUsd: num(process.env.SUBSCRIPTION_PRICE_USD, 3),
  subscriptionDays: num(process.env.SUBSCRIPTION_DAYS, 30),
  paymentUrl: process.env.PAYMENT_URL || '',
  autoClaimPriceUsd: num(process.env.AUTOCLAIM_PRICE_USD, 2),
  autoClaimDays: num(process.env.AUTOCLAIM_DAYS, 30),
  autoClaimPaymentUrl:
    process.env.AUTOCLAIM_PAYMENT_URL || process.env.PAYMENT_URL || '',
  slotPriceUsd: num(process.env.SLOT_PRICE_USD, 1),
  slotDays: num(process.env.SLOT_DAYS, 30),
  // Paid feature add-ons (30-day passes, switched on by the admin after payment)
  envPriceUsd: num(process.env.ENVVARS_PRICE_USD, 1),
  envDays: num(process.env.ENVVARS_DAYS, 30),
  alertsPriceUsd: num(process.env.ALERTS_PRICE_USD, 1),
  alertsDays: num(process.env.ALERTS_DAYS, 30),
  slotPaymentUrl: process.env.SLOT_PAYMENT_URL || process.env.PAYMENT_URL || '',
  baseBotLimit: num(process.env.FREE_BOT_LIMIT, 1),
  // Referral program: friend gets coins on signup, referrer when the friend's bot really runs.
  refReferrerCoins: num(process.env.REFERRAL_REFERRER_COINS, 40),
  refFriendCoins: num(process.env.REFERRAL_FRIEND_COINS, 20),
  refMonthlyCap: num(process.env.REFERRAL_MONTHLY_CAP, 10),
  refMinUptimeMin: num(process.env.REFERRAL_MIN_UPTIME_MIN, 10),
  // One-off coin top-up packs. Bought coins live in `bonusCoins`, which the
  // daily-claim cap (maxCoins) never touches.
  packs: [
    { key: 'coins100', coins: num(process.env.PACK_SMALL_COINS, 100), usd: num(process.env.PACK_SMALL_USD, 1) },
    { key: 'coins300', coins: num(process.env.PACK_LARGE_COINS, 300), usd: num(process.env.PACK_LARGE_USD, 2.5) },
  ],
};

/** Free + bought coins together. */
const totalCoins = (user) => (user.coins || 0) + (user.bonusCoins || 0);

const periodMs = () => cfg.botPeriodDays * DAY;

function trialEndsAt(user) {
  return user.trialEndsAt || null;
}

function mode(user, at = Date.now()) {
  if (user.isAdmin) return 'admin';
  if (user.subscriptionUntil && user.subscriptionUntil > at) return 'subscription';
  if (user.trialEndsAt && user.trialEndsAt > at) return 'trial';
  return 'coins';
}

/** True when the user's bots run without spending coins. */
function runsFree(user, at = Date.now()) {
  return mode(user, at) !== 'coins';
}

function nextClaimAt(user) {
  if (!user.lastClaimAt) return 0;
  return user.lastClaimAt + cfg.claimCooldownHours * 3600 * 1000;
}

function canClaim(user, at = Date.now()) {
  return at >= nextClaimAt(user);
}

function logCoin(user, delta, reason) {
  user.coinLog = user.coinLog || [];
  user.coinLog.unshift({ at: Date.now(), delta, reason, balance: totalCoins(user) });
  user.coinLog.length = Math.min(user.coinLog.length, 30);
}

function claim(user) {
  const at = Date.now();
  if (!canClaim(user, at)) return { ok: false, nextClaimAt: nextClaimAt(user) };
  const before = user.coins || 0;
  user.coins = Math.min(cfg.maxCoins, before + cfg.claimCoins);
  user.lastClaimAt = at;
  logCoin(user, user.coins - before, 'Daily claim');
  return { ok: true, added: user.coins - before, coins: user.coins, nextClaimAt: nextClaimAt(user) };
}

/** Try to fund a bot with coins. Mutates user + returns the new paid-until (or null). */
function charge(user, bot) {
  const at = Date.now();
  if (totalCoins(user) < cfg.botCoinCost) return null;
  // spend the free daily coins first, bought coins only for what is left
  const fromFree = Math.min(user.coins || 0, cfg.botCoinCost);
  user.coins = (user.coins || 0) - fromFree;
  user.bonusCoins = Math.max(0, (user.bonusCoins || 0) - (cfg.botCoinCost - fromFree));
  const base = bot.coinPaidUntil && bot.coinPaidUntil > at ? bot.coinPaidUntil : at;
  const until = base + periodMs();
  logCoin(user, -cfg.botCoinCost, `Bot "${bot.name}" runtime`);
  return until;
}

/**
 * Decide whether a bot may run right now.
 * Returns { ok, until?, reason?, charged? }. When ok and `charged` is set,
 * the caller must persist user + bot.coinPaidUntil.
 */
function authorize(user, bot) {
  const at = Date.now();
  if (runsFree(user, at)) return { ok: true, free: true };
  if (bot.coinPaidUntil && bot.coinPaidUntil > at) return { ok: true, until: bot.coinPaidUntil };
  const until = charge(user, bot);
  if (until) return { ok: true, until, charged: true };
  return {
    ok: false,
    reason: `Free trial ended and you don't have enough coins. A bot costs ${cfg.botCoinCost} coins per ${
      cfg.botPeriodDays === 1 ? 'day' : cfg.botPeriodDays + ' days'
    }. Claim your ${cfg.claimCoins} free daily coins, buy a coin pack or subscribe for $${cfg.priceUsd}/month.`,
  };
}

/* ------------------------------------------------------------------ auto-claim */

/** Is the paid auto-claim add-on live for this user right now? */
function autoClaimActive(user, at = Date.now()) {
  return !!(user && user.autoClaimUntil && user.autoClaimUntil > at);
}

function autoClaimDaysLeft(user, at = Date.now()) {
  if (!autoClaimActive(user, at)) return 0;
  return Math.max(0, Math.ceil((user.autoClaimUntil - at) / DAY));
}

/** Extend (or start) the add-on. days <= 0 turns it off. */
function grantAutoClaim(user, days = cfg.autoClaimDays) {
  const at = Date.now();
  if (days <= 0) {
    user.autoClaimUntil = null;
    return null;
  }
  const base = user.autoClaimUntil && user.autoClaimUntil > at ? user.autoClaimUntil : at;
  user.autoClaimUntil = base + days * DAY;
  return user.autoClaimUntil;
}

/**
 * Should the server claim for this user right now?
 * Skips when the balance is already at the cap — claiming then would add 0 and
 * burn the cooldown, which would be worse than doing nothing.
 */
function autoClaimDue(user, at = Date.now()) {
  if (!autoClaimActive(user, at)) return false;
  if (!canClaim(user, at)) return false;
  return (user.coins || 0) < cfg.maxCoins;
}

/**
 * Run the auto-claim pass over a list of users.
 * Returns the users that were actually topped up, so the caller can persist.
 * @param {Array} users
 * @returns {Array<{user:object, added:number, coins:number}>}
 */
function runAutoClaims(users) {
  const at = Date.now();
  const done = [];
  for (const user of users || []) {
    if (!autoClaimDue(user, at)) continue;
    const r = claim(user);
    if (!r.ok) continue;
    // Re-label the log entry so the dashboard shows why the coins appeared.
    if (user.coinLog && user.coinLog[0]) user.coinLog[0].reason = 'Auto-claim';
    done.push({ user, added: r.added, coins: r.coins });
  }
  return done;
}

/** Give uncapped bonus coins with a log line. */
function grantBonus(user, coins, reason) {
  const add = Math.round(coins);
  if (!user || add <= 0) return 0;
  user.bonusCoins = (user.bonusCoins || 0) + add;
  logCoin(user, add, reason);
  return add;
}

/* ------------------------------------------------------------ coin packs */

function packByKey(key) {
  return cfg.packs.find((p) => p.key === key) || null;
}

/** Add bought coins (qty packs). Returns how many coins were added. */
function grantPack(user, key, qty = 1) {
  const pack = packByKey(key);
  if (!pack) return 0;
  const add = Math.round(pack.coins * Math.max(1, Math.floor(qty)));
  user.bonusCoins = (user.bonusCoins || 0) + add;
  logCoin(user, add, 'Coin pack purchase');
  return add;
}

/* ------------------------------------------------------------ extra slots */

/** True when the user has paid-for bot slots that have not expired. */
function extraSlotsActive(user, at = Date.now()) {
  return !!(user && user.extraSlots > 0 && user.extraSlotsUntil && user.extraSlotsUntil > at);
}

/** How many extra slots are live right now (0 once the window lapses). */
function extraSlotCount(user, at = Date.now()) {
  return extraSlotsActive(user, at) ? Math.floor(user.extraSlots) : 0;
}

function extraSlotDaysLeft(user, at = Date.now()) {
  if (!extraSlotsActive(user, at)) return 0;
  return Math.max(0, Math.ceil((user.extraSlotsUntil - at) / DAY));
}

/**
 * Add paid slots. Each purchase adds `count` slots and pushes the shared
 * expiry out by `days`, so buying twice gives you two slots for another month
 * rather than two slots that expire at different times.
 * Passing days <= 0 revokes every extra slot immediately.
 */
function grantExtraSlots(user, count = 1, days = cfg.slotDays) {
  if (!user) return null;
  if (days <= 0 || count <= 0) {
    user.extraSlots = 0;
    user.extraSlotsUntil = null;
    return null;
  }
  const at = Date.now();
  const base = user.extraSlotsUntil && user.extraSlotsUntil > at ? user.extraSlotsUntil : at;
  user.extraSlots = (extraSlotCount(user, at) || 0) + Math.floor(count);
  user.extraSlotsUntil = base + days * DAY;
  return { slots: user.extraSlots, until: user.extraSlotsUntil };
}

/**
 * The bot limit a user should be held to right now. Never mutate the stored
 * `botLimit` for this \u2014 extra slots must vanish on their own when the paid
 * window lapses, and a stored number would leak the upgrade forever.
 */
function botLimitFor(user, at = Date.now()) {
  const base = Number(user && user.botLimit) || cfg.baseBotLimit;
  return base + extraSlotCount(user, at);
}

/* ------------------------------------------------------------------ feature passes */
/**
 * Paid feature passes (30 days each):
 *   envvars - custom environment variables per bot (PREFIX, OWNER_NUMBER, ...)
 *   alerts  - crash / back-online alerts sent to the user's webhook
 * Stored as user.<key>Until (ms timestamp). Admins always have every feature.
 */
const FEATURES = {
  envvars: { field: 'envVarsUntil', price: () => cfg.envPriceUsd, days: () => cfg.envDays },
  alerts: { field: 'alertsUntil', price: () => cfg.alertsPriceUsd, days: () => cfg.alertsDays },
};

function featureActive(user, key, at = Date.now()) {
  const f = FEATURES[key];
  if (!user || !f) return false;
  if (user.isAdmin) return true;
  return !!(user[f.field] && user[f.field] > at);
}

function featureUntil(user, key) {
  const f = FEATURES[key];
  return f && user ? user[f.field] || null : null;
}

/** Extend (or start) a feature pass. days <= 0 turns it off. Returns the new expiry. */
function grantFeature(user, key, days) {
  const f = FEATURES[key];
  if (!f) return null;
  const at = Date.now();
  if (!(days > 0)) {
    user[f.field] = null;
    return null;
  }
  const base = user[f.field] && user[f.field] > at ? user[f.field] : at;
  user[f.field] = base + days * DAY;
  return user[f.field];
}

function featureSummary(user, key, at = Date.now()) {
  const f = FEATURES[key];
  const until = user[f.field] || null;
  return {
    active: featureActive(user, key, at),
    until,
    daysLeft: until && until > at ? Math.ceil((until - at) / DAY) : 0,
    priceUsd: f.price(),
    days: f.days(),
  };
}

function summary(user) {
  const at = Date.now();
  return {
    mode: mode(user, at),
    trialEndsAt: trialEndsAt(user),
    subscriptionUntil: user.subscriptionUntil || null,
    coins: user.coins || 0,
    bonusCoins: user.bonusCoins || 0,
    totalCoins: totalCoins(user),
    packs: cfg.packs,
    canClaim: canClaim(user, at),
    nextClaimAt: nextClaimAt(user) || null,
    log: (user.coinLog || []).slice(0, 10),
    autoClaim: {
      active: autoClaimActive(user, at),
      until: user.autoClaimUntil || null,
      daysLeft: autoClaimDaysLeft(user, at),
      priceUsd: cfg.autoClaimPriceUsd,
      days: cfg.autoClaimDays,
      requested: !!user.autoClaimRequestedAt,
      paymentUrl: cfg.autoClaimPaymentUrl,
      // True when the add-on is pointless because coins already run free.
      // Only a paid Unlimited subscription makes auto-claim pointless. The free
      // trial also "runs free" but expires, so we do not flag it as redundant.
      redundant: mode(user, at) === 'subscription',
    },
    extraSlots: {
      active: extraSlotsActive(user, at),
      count: extraSlotCount(user, at),
      until: user.extraSlotsUntil || null,
      daysLeft: extraSlotDaysLeft(user, at),
      priceUsd: cfg.slotPriceUsd,
      days: cfg.slotDays,
      requested: !!user.slotRequestedAt,
      paymentUrl: cfg.slotPaymentUrl,
      botLimit: botLimitFor(user, at),
    },
    envVars: featureSummary(user, 'envvars', at),
    alerts: featureSummary(user, 'alerts', at),
    config: {
      trialDays: cfg.trialDays,
      claimCoins: cfg.claimCoins,
      botCoinCost: cfg.botCoinCost,
      botPeriodDays: cfg.botPeriodDays,
      priceUsd: cfg.priceUsd,
      subscriptionDays: cfg.subscriptionDays,
      maxCoins: cfg.maxCoins,
      paymentUrl: cfg.paymentUrl,
      autoClaimPriceUsd: cfg.autoClaimPriceUsd,
      autoClaimDays: cfg.autoClaimDays,
      slotPriceUsd: cfg.slotPriceUsd,
      slotDays: cfg.slotDays,
      refReferrerCoins: cfg.refReferrerCoins,
      refFriendCoins: cfg.refFriendCoins,
    },
  };
}

module.exports = {
  cfg,
  DAY,
  mode,
  runsFree,
  canClaim,
  nextClaimAt,
  claim,
  authorize,
  summary,
  autoClaimActive,
  autoClaimDaysLeft,
  autoClaimDue,
  grantAutoClaim,
  runAutoClaims,
  extraSlotsActive,
  extraSlotCount,
  extraSlotDaysLeft,
  grantExtraSlots,
  botLimitFor,
  totalCoins,
  grantBonus,
  packByKey,
  grantPack,
  FEATURES,
  featureActive,
  featureUntil,
  grantFeature,
  featureSummary,
};
