/**
 * Payment details + ZiG pricing for Ladybug Cloud.
 *
 * Users pay the admin by bank transfer (NSB). The admin can edit everything
 * here from Admin -> Payments; the values are stored in the database
 * (settings.payments) and fall back to the defaults below, which can also be
 * overridden with environment variables.
 *
 * ZiG prices are the USD price multiplied by `zigPerUsd`. Keep that rate
 * current from the admin panel (or ZIG_PER_USD) - it is the only moving part.
 */
const db = require('./store');
const billing = require('./billing');

const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const DEFAULTS = {
  bankName: process.env.PAYMENT_BANK || 'NSB',
  accountName: process.env.PAYMENT_ACCOUNT_NAME || '',
  accounts: [
    { currency: 'ZiG', number: process.env.PAYMENT_ZIG_ACCOUNT || '3251650604001' },
    { currency: 'USD', number: process.env.PAYMENT_USD_ACCOUNT || '3251650604451' },
  ],
  zigPerUsd: num(process.env.ZIG_PER_USD, 26.57),
  instructions:
    process.env.PAYMENT_INSTRUCTIONS ||
    'Pay into the account that matches your currency, use your Ladybug Cloud username as the payment reference, ' +
      'then send the admin your proof of payment from the Contact admin page. Your plan is activated once the payment is confirmed.',
};

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function get() {
  const saved = (db.getSettings() || {}).payments || {};
  return {
    bankName: saved.bankName != null ? saved.bankName : DEFAULTS.bankName,
    accountName: saved.accountName != null ? saved.accountName : DEFAULTS.accountName,
    accounts: Array.isArray(saved.accounts) && saved.accounts.length ? saved.accounts : DEFAULTS.accounts,
    zigPerUsd: saved.zigPerUsd > 0 ? saved.zigPerUsd : DEFAULTS.zigPerUsd,
    instructions: saved.instructions != null ? saved.instructions : DEFAULTS.instructions,
    updatedAt: saved.updatedAt || null,
  };
}

/** Validate + store an admin edit. Throws Error(message) on bad input. */
function update(input) {
  const cur = get();
  const next = { ...cur };
  if (input.bankName != null) next.bankName = clean(input.bankName, 80);
  if (input.accountName != null) next.accountName = clean(input.accountName, 120);
  if (input.instructions != null) next.instructions = clean(input.instructions, 600);
  if (input.zigPerUsd != null) {
    const r = parseFloat(input.zigPerUsd);
    if (!Number.isFinite(r) || r <= 0 || r > 100000) throw new Error('Exchange rate must be a positive number.');
    next.zigPerUsd = Math.round(r * 10000) / 10000;
  }
  if (input.accounts != null) {
    if (!Array.isArray(input.accounts) || input.accounts.length > 6) throw new Error('Provide up to 6 accounts.');
    next.accounts = input.accounts
      .map((a) => ({ currency: clean(a && a.currency, 10), number: clean(a && a.number, 40) }))
      .filter((a) => a.currency && a.number);
    if (!next.accounts.length) throw new Error('Add at least one account (currency + number).');
  }
  next.updatedAt = Date.now();
  db.setSettings({ payments: next });
  return get();
}

const toZig = (usd, rate = get().zigPerUsd) => Math.round(usd * rate * 100) / 100;

/** What each paid option costs, in USD and ZiG. */
function prices() {
  const c = billing.cfg;
  const rate = get().zigPerUsd;
  const row = (key, name, usd, days, extra) => ({ key, name, usd, zig: toZig(usd, rate), days, ...(extra || {}) });
  return {
    zigPerUsd: rate,
    items: [
      row('unlimited', 'Unlimited', c.priceUsd, c.subscriptionDays),
      row('autoclaim', 'Auto-claim', c.autoClaimPriceUsd, c.autoClaimDays),
      row('slot', 'Extra bot slot', c.slotPriceUsd, c.slotDays),
      row('envvars', 'Custom bot settings (env vars)', c.envPriceUsd, c.envDays),
      row('alerts', 'Crash alerts (webhook)', c.alertsPriceUsd, c.alertsDays),
      ...c.packs.map((p) => row(p.key, `${p.coins} coins`, p.usd, null, { coins: p.coins })),
    ],
  };
}

module.exports = { get, update, prices, toZig };
