/**
 * Ladybug Cloud — Multi-tenant WhatsApp bot hosting
 * Made under Ntandomods
 */
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const db = require('./lib/store');
const bots = require('./lib/bots');
const installer = require('./lib/installer');
const sessiongen = require('./lib/sessiongen');
const FileSessionStore = require('./lib/session-store');
const billing = require('./lib/billing');
const payments = require('./lib/payments');
const mongoSync = require('./lib/mongo-sync');
const envvars = require('./lib/envvars');
const alerts = require('./lib/alerts');
const uptime = require('./lib/uptime');
const sessioninfo = require('./lib/sessioninfo');
const compression = require('compression');
const storage = require('./lib/storage');
const { securityHeaders, rateLimit } = require('./lib/security');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Ntando';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'mods';
const FREE_BOT_LIMIT = parseInt(process.env.FREE_BOT_LIMIT || '1', 10);
const PRO_BOT_LIMIT = parseInt(process.env.PRO_BOT_LIMIT || '10', 10);

// ---------------------------------------------------------------- middleware
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Login sessions never expire: they are stored on disk (survive restarts and
// redeploys), the signing secret is stable, and the cookie lasts ~10 years and
// is refreshed on every request. Users only get logged out by pressing Logout.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch (e) { /* first boot */ }
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(file, secret, { mode: 0o600 }); mongoSync.syncSecret().catch(() => {}); } catch (e) { console.error('[sessions] could not persist secret:', e.message); }
  return secret;
}

const sessionStore = new FileSessionStore(path.join(DATA_DIR, 'sessions'));
app.use(
  session({
    store: sessionStore,
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
      maxAge: 1000 * 60 * 60 * 24 * 365 * 10,
    },
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB
});

// ---------------------------------------------------------------- helpers
const uid = () => crypto.randomBytes(9).toString('hex');

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    plan: u.plan || 'free',
    isAdmin: !!u.isAdmin,
    botLimit: billing.botLimitFor(u),
    createdAt: u.createdAt,
    lastLogin: u.lastLogin || null,
    billingMode: billing.mode(u),
    trialEndsAt: u.trialEndsAt || null,
    subscriptionUntil: u.subscriptionUntil || null,
    coins: billing.totalCoins(u),
    autoClaimUntil: u.autoClaimUntil || null,
    extraSlots: billing.extraSlotCount(u),
    extraSlotsUntil: u.extraSlotsUntil || null,
    envVarsUntil: u.envVarsUntil || null,
    alertsUntil: u.alertsUntil || null,
    uptimeUntil: u.uptimeUntil || null,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.findUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session expired' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

function botView(bot) {
  const st = bots.status(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    sessionIdMasked: bot.sessionId
      ? `${bot.sessionId.slice(0, 12)}${'•'.repeat(Math.max(0, Math.min(20, bot.sessionId.length - 12)))}`
      : '',
    hasSession: !!bot.sessionId,
    autoRestart: bot.autoRestart !== false,
    createdAt: bot.createdAt,
    status: st.status,
    running: st.running,
    pid: st.pid,
    startedAt: st.startedAt,
    stoppedAt: st.stoppedAt,
    restarts: st.restarts,
    lastError: st.lastError,
    coinPaidUntil: bot.coinPaidUntil || null,
    suspendedReason: bot.suspendedReason || null,
    envCount: bot.env ? Object.keys(bot.env).length : 0,
    resources: st.resources || null,
  };
}

// ---------------------------------------------------------------- bootstrap admin
(function ensureAdmin() {
  let admin = db.findUserByUsername(ADMIN_USERNAME);
  if (!admin) {
    admin = {
      id: uid(),
      username: ADMIN_USERNAME,
      email: 'admin@ntandomods.local',
      passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      isAdmin: true,
      plan: 'pro',
      botLimit: 999,
      createdAt: new Date().toISOString(),
    };
    db.addUser(admin);
    console.log(`[boot] Admin account created: ${ADMIN_USERNAME}`);
  } else if (!admin.isAdmin) {
    db.updateUser(admin.id, { isAdmin: true, plan: 'pro', botLimit: 999 });
  }
})();

// Existing accounts from before billing existed get a fresh trial from now.
(function grandfatherUsers() {
  let n = 0;
  for (const u of db.data.users) {
    if (!u.isAdmin && !u.trialEndsAt) {
      u.trialEndsAt = Date.now() + billing.cfg.trialDays * billing.DAY;
      n++;
    }
    if (typeof u.coins !== 'number') u.coins = 0;
  }
  if (n) { db.save(); console.log(`[billing] granted a ${billing.cfg.trialDays}-day trial to ${n} existing user(s)`); }
})();

// ---------------------------------------------------------------- auth routes
// Brute-force and abuse protection (per client IP)
const authLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30, message: 'Too many sign-in attempts. Try again in a few minutes.' });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10, message: 'Too many sign-ups from this network. Try again later.' });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, message: 'Too many requests. Slow down and try again shortly.' });
app.use('/api/', apiLimiter);

app.post('/api/auth/register', registerLimiter, (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.findUserByUsername(username)) return res.status(409).json({ error: 'Username already taken' });
  if (email && db.findUserByEmail(email)) return res.status(409).json({ error: 'Email already registered' });

  // Referral: `ref` is the inviter's username. Self-referral and shared-IP signups earn nothing.
  const regIp = String(req.ip || '');
  let referrer = null;
  const refName = String((req.body && req.body.ref) || '').trim().slice(0, 40);
  if (refName) {
    const r = db.findUserByUsername(refName);
    if (r && !r.isAdmin && r.username.toLowerCase() !== String(username).trim().toLowerCase()) referrer = r;
  }
  const sameIp = !!(referrer && referrer.regIp && regIp && referrer.regIp === regIp);
  const ipWelcomes = db.data.users.filter((u) => u.regIp === regIp && u.referralWelcome).length;
  const welcome = !!referrer && !sameIp && ipWelcomes < 3;

  const user = {
    id: uid(),
    username: String(username).trim(),
    email: email ? String(email).trim() : null,
    passwordHash: bcrypt.hashSync(String(password), 10),
    isAdmin: false,
    plan: 'free',
    botLimit: FREE_BOT_LIMIT,
    createdAt: new Date().toISOString(),
    trialEndsAt: Date.now() + billing.cfg.trialDays * billing.DAY,
    coins: 0,
    regIp,
    ...(referrer ? {
      referredBy: referrer.id,
      referralStatus: sameIp ? 'blocked' : 'pending',
      referralNote: sameIp ? 'Same network as the referrer' : '',
      referralWelcome: welcome,
    } : {}),
  };
  if (welcome) billing.grantBonus(user, billing.cfg.refFriendCoins, 'Welcome bonus (invited by ' + referrer.username + ')');
  db.addUser(user);
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const user = db.findUserByUsername(username);
  if (!user || !bcrypt.compareSync(String(password), user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  db.updateUser(user.id, { lastLogin: new Date().toISOString() });
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.findUserById(req.session.userId);
  res.json({ user: user ? publicUser(user) : null });
});

// ---------------------------------------------------------------- account settings
// FREE feature: change your own password. Other devices are signed out too.
const pwFails = new Map(); // userId -> { n, first }
app.post('/api/account/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const rec = pwFails.get(req.user.id);
  if (rec && Date.now() - rec.first > 10 * 60 * 1000) pwFails.delete(req.user.id);
  const cur = pwFails.get(req.user.id);
  if (cur && cur.n >= 5) {
    return res.status(429).json({ error: 'Too many wrong attempts. Try again in a few minutes.' });
  }
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Enter your current and new password.' });
  if (!bcrypt.compareSync(String(currentPassword), req.user.passwordHash)) {
    const f = pwFails.get(req.user.id) || { n: 0, first: Date.now() };
    f.n += 1;
    pwFails.set(req.user.id, f);
    return res.status(401).json({ error: 'Your current password is wrong.' });
  }
  const np = String(newPassword);
  if (np.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  if (np.length > 200) return res.status(400).json({ error: 'New password is too long.' });
  if (np === String(currentPassword)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
  pwFails.delete(req.user.id);
  db.updateUser(req.user.id, { passwordHash: bcrypt.hashSync(np, 10) });
  // Sign out every other device that uses this account; keep this one.
  const signedOut = sessionStore.destroyForUser(req.user.id, req.sessionID);
  res.json({ ok: true, signedOutOthers: signedOut });
});

// PAID feature "Crash alerts": a webhook that is told when a bot goes down / comes back.
app.get('/api/account/alerts', requireAuth, (req, res) => {
  res.json({ webhook: req.user.alertWebhook || '', ...billing.featureSummary(req.user, 'alerts') });
});

app.put('/api/account/alerts', requireAuth, async (req, res) => {
  if (!billing.featureActive(req.user, 'alerts')) {
    return res.status(402).json({
      error: `Crash alerts is a paid feature ($${billing.cfg.alertsPriceUsd}/month). Buy it on the Pay page to unlock it.`,
    });
  }
  const url = String((req.body && req.body.webhook) || '').trim();
  if (!url) {
    db.updateUser(req.user.id, { alertWebhook: null });
    return res.json({ ok: true, webhook: '' });
  }
  try {
    await alerts.assertSafeUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  db.updateUser(req.user.id, { alertWebhook: url.slice(0, 500) });
  res.json({ ok: true, webhook: url });
});

const alertTests = new Map(); // userId -> last test time
app.post('/api/account/alerts/test', requireAuth, async (req, res) => {
  if (!billing.featureActive(req.user, 'alerts')) {
    return res.status(402).json({ error: 'Crash alerts is a paid feature. Buy it on the Pay page to unlock it.' });
  }
  if (!req.user.alertWebhook) return res.status(400).json({ error: 'Save a webhook URL first.' });
  if (Date.now() - (alertTests.get(req.user.id) || 0) < 15000) {
    return res.status(429).json({ error: 'Wait a few seconds between test alerts.' });
  }
  alertTests.set(req.user.id, Date.now());
  try {
    await alerts.sendTest(req.user.alertWebhook);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not reach the webhook.' });
  }
});

// ---------------------------------------------------------------- billing / coins
app.get('/api/billing', requireAuth, (req, res) => {
  res.json({ ...billing.summary(req.user), zigPerUsd: payments.get().zigPerUsd });
});

app.post('/api/coins/claim', requireAuth, (req, res) => {
  const r = billing.claim(req.user);
  if (!r.ok) {
    return res.status(429).json({ error: 'You already claimed today. Come back later!', nextClaimAt: r.nextClaimAt });
  }
  db.save();
  res.json({ ok: true, ...r, billing: billing.summary(req.user) });
});

// Auto-claim add-on ($2/month): the server claims the daily coins for you.
app.post('/api/billing/autoclaim', requireAuth, (req, res) => {
  const b = billing.summary(req.user);
  if (b.autoClaim.active) {
    return res.status(409).json({ error: 'Auto-claim is already active.', billing: b });
  }
  if (!billing.cfg.autoClaimPaymentUrl) {
    // No checkout configured: record the intent so the admin can see it.
    if (req.user.autoClaimRequestedAt) {
      return res.status(409).json({
        error: 'Your auto-claim request is already pending. The admin will activate it shortly.',
        billing: b,
      });
    }
    req.user.autoClaimRequestedAt = Date.now();
    db.save();
    return res.json({
      ok: true,
      manual: true,
      message:
        `Auto-claim costs $${billing.cfg.autoClaimPriceUsd}/month. ` +
        'Your request has been recorded - the admin will activate it for you.',
      billing: billing.summary(req.user),
    });
  }
  const url = billing.cfg.autoClaimPaymentUrl;
  res.json({
    ok: true,
    url:
      `${url}${url.includes('?') ? '&' : '?'}plan=autoclaim` +
      `&client_reference_id=${encodeURIComponent(req.user.username)}`,
  });
});

// Extra bot slot add-on ($1/month each): stacks on top of the plan limit.
app.post('/api/billing/slots', requireAuth, (req, res) => {
  const b = billing.summary(req.user);
  const want = Math.max(1, Math.min(5, parseInt(req.body && req.body.count, 10) || 1));
  if (!billing.cfg.slotPaymentUrl) {
    // No checkout configured: record the intent so the admin can see it.
    if (req.user.slotRequestedAt) {
      return res.status(409).json({
        error: 'Your slot request is already pending. The admin will activate it shortly.',
        billing: b,
      });
    }
    req.user.slotRequestedAt = Date.now();
    req.user.slotRequestedCount = want;
    db.save();
    return res.json({
      ok: true,
      manual: true,
      message:
        `An extra bot slot costs $${billing.cfg.slotPriceUsd}/month. ` +
        'Your request has been recorded - the admin will activate it for you.',
      billing: billing.summary(req.user),
    });
  }
  const url = billing.cfg.slotPaymentUrl;
  res.json({
    ok: true,
    url:
      `${url}${url.includes('?') ? '&' : '?'}plan=slot&qty=${want}` +
      `&client_reference_id=${encodeURIComponent(req.user.username)}`,
  });
});

// ---------------------------------------------------------------- prices + payment details
// Public: USD and ZiG prices for the pricing page.
app.get('/api/prices', (req, res) => {
  res.json(payments.prices());
});

// Signed-in users: prices plus the admin's bank details to pay into.
app.get('/api/payments', requireAuth, (req, res) => {
  const p = payments.get();
  res.json({
    ...payments.prices(),
    bankName: p.bankName,
    accountName: p.accountName,
    accounts: p.accounts,
    instructions: p.instructions,
    reference: req.user.username,
  });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  res.json({ ...payments.get(), prices: payments.prices() });
});

app.put('/api/admin/payments', requireAdmin, (req, res) => {
  try {
    const p = payments.update(req.body || {});
    res.json({ ok: true, ...p, prices: payments.prices() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------- contact admin (messages)
const MSG_MAX = 2000;

function cleanMessage(v) {
  return String(v == null ? '' : v).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function messageView(m) {
  return { id: m.id, from: m.from, body: m.body, at: m.at };
}

// The signed-in user's own conversation with the admin.
app.get('/api/messages', requireAuth, (req, res) => {
  const msgs = db.messagesForUser(req.user.id);
  const unread = msgs.filter((m) => m.from === 'admin' && !m.readByUser).length;
  if (req.query.markRead === '1' && unread) {
    msgs.forEach((m) => { if (m.from === 'admin') m.readByUser = true; });
    db.save();
  }
  res.json({ messages: msgs.map(messageView), unread: req.query.markRead === '1' ? 0 : unread });
});

app.get('/api/messages/unread', requireAuth, (req, res) => {
  const mine = db.messagesForUser(req.user.id).filter((m) => m.from === 'admin' && !m.readByUser).length;
  const admin = req.user.isAdmin
    ? db.allMessages().filter((m) => m.from === 'user' && !m.readByAdmin).length
    : 0;
  const pendingPayments = req.user.isAdmin ? db.allPayments().filter((x) => x.status === 'pending').length : 0;
  res.json({ unread: mine, adminUnread: admin, pendingPayments });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const body = cleanMessage(req.body && req.body.body);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  if (body.length > MSG_MAX) return res.status(400).json({ error: `Message is too long (max ${MSG_MAX} characters).` });
  const recent = db.messagesForUser(req.user.id).filter((m) => m.from === 'user' && Date.now() - m.at < 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Slow down - please wait a minute before sending more.' });
  const msg = db.addMessage({
    id: uid(),
    userId: req.user.id,
    from: 'user',
    body,
    at: Date.now(),
    readByAdmin: false,
    readByUser: true,
  });
  res.json({ ok: true, message: messageView(msg) });
});

// Admin inbox: one row per user who has written or been written to.
app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const byUser = new Map();
  for (const m of db.allMessages()) {
    if (!byUser.has(m.userId)) byUser.set(m.userId, []);
    byUser.get(m.userId).push(m);
  }
  const threads = [];
  for (const [userId, msgs] of byUser) {
    const u = db.findUserById(userId);
    if (!u) continue;
    const last = msgs[msgs.length - 1];
    threads.push({
      userId,
      username: u.username,
      email: u.email || '',
      count: msgs.length,
      unread: msgs.filter((m) => m.from === 'user' && !m.readByAdmin).length,
      last: { from: last.from, body: last.body.slice(0, 140), at: last.at },
    });
  }
  threads.sort((a, b) => b.last.at - a.last.at);
  res.json({ threads, unread: threads.reduce((n, t) => n + t.unread, 0) });
});

app.get('/api/admin/messages/:userId', requireAdmin, (req, res) => {
  const u = db.findUserById(req.params.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const msgs = db.messagesForUser(u.id);
  if (msgs.some((m) => m.from === 'user' && !m.readByAdmin)) {
    msgs.forEach((m) => { if (m.from === 'user') m.readByAdmin = true; });
    db.save();
  }
  res.json({ user: publicUser(u), messages: msgs.map(messageView) });
});

app.post('/api/admin/messages/:userId', requireAdmin, (req, res) => {
  const u = db.findUserById(req.params.userId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const body = cleanMessage(req.body && req.body.body);
  if (!body) return res.status(400).json({ error: 'Write a message first.' });
  if (body.length > MSG_MAX) return res.status(400).json({ error: `Message is too long (max ${MSG_MAX} characters).` });
  // replying implies the user's earlier messages were read
  db.messagesForUser(u.id).forEach((m) => { if (m.from === 'user') m.readByAdmin = true; });
  const msg = db.addMessage({
    id: uid(),
    userId: u.id,
    from: 'admin',
    body,
    at: Date.now(),
    readByAdmin: true,
    readByUser: false,
  });
  res.json({ ok: true, message: messageView(msg) });
});

app.delete('/api/admin/messages/:userId', requireAdmin, (req, res) => {
  db.deleteThread(req.params.userId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- payment submissions
// A user reports a transfer ("I paid"); the admin approves it in one click and the
// plan is switched on automatically, instead of hand-editing the user row.
const PAY_ITEMS = ['unlimited', 'autoclaim', 'slot', 'envvars', 'alerts', 'uptime', ...billing.cfg.packs.map((p) => p.key)];

function paymentView(x) {
  const u = db.findUserById(x.userId);
  return {
    id: x.id, userId: x.userId, username: u ? u.username : '(deleted)',
    item: x.item, itemName: x.itemName, qty: x.qty, currency: x.currency, amount: x.amount, amountUsd: x.amountUsd,
    reference: x.reference, status: x.status, createdAt: x.createdAt, decidedAt: x.decidedAt || null, reason: x.reason || '',
  };
}

/** Switch on whatever the user paid for. Returns a short human description. */
function applyPurchase(u, item, qty) {
  const at = Date.now();
  if (item === 'unlimited') {
    const base = u.subscriptionUntil && u.subscriptionUntil > at ? u.subscriptionUntil : at;
    u.subscriptionUntil = base + billing.cfg.subscriptionDays * billing.DAY;
    return `Unlimited for ${billing.cfg.subscriptionDays} days`;
  }
  if (item === 'autoclaim') {
    billing.grantAutoClaim(u, billing.cfg.autoClaimDays);
    u.autoClaimRequestedAt = null;
    return `Auto-claim for ${billing.cfg.autoClaimDays} days`;
  }
  if (billing.FEATURES[item]) {
    const days = billing.FEATURES[item].days();
    billing.grantFeature(u, item, days);
    const label = { envvars: 'Custom bot settings', alerts: 'Crash alerts', uptime: 'Uptime history' }[item];
    return `${label} for ${days} days`;
  }
  if (billing.packByKey(item)) {
    const added = billing.grantPack(u, item, qty);
    return `${added} bought coins added`;
  }
  billing.grantExtraSlots(u, qty, billing.cfg.slotDays);
  u.slotRequestedAt = null;
  u.slotRequestedCount = null;
  return `${qty} extra bot slot${qty > 1 ? 's' : ''} for ${billing.cfg.slotDays} days`;
}

function notifyUser(userId, body) {
  db.addMessage({ id: uid(), userId, from: 'admin', body, at: Date.now(), readByAdmin: true, readByUser: false });
}

app.get('/api/payments/mine', requireAuth, (req, res) => {
  const mine = db.allPayments().filter((x) => x.userId === req.user.id).slice(-10).reverse();
  res.json({ payments: mine.map(paymentView) });
});

app.post('/api/payments/submit', requireAuth, (req, res) => {
  const b = req.body || {};
  const item = String(b.item || '');
  if (!PAY_ITEMS.includes(item)) return res.status(400).json({ error: 'Choose what you paid for.' });
  const qty = item === 'slot' || billing.packByKey(item) ? Math.max(1, Math.min(5, parseInt(b.qty, 10) || 1)) : 1;
  const cfgPay = payments.get();
  const currency = cfgPay.accounts.map((a) => a.currency).find((c) => c.toLowerCase() === String(b.currency || '').toLowerCase());
  if (!currency) return res.status(400).json({ error: 'Choose the currency you paid in.' });
  const reference = String(b.reference || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  if (reference.length < 3) return res.status(400).json({ error: 'Enter the transaction reference or the name/number you paid from.' });
  const pending = db.allPayments().filter((x) => x.userId === req.user.id && x.status === 'pending');
  if (pending.length >= 3) return res.status(429).json({ error: 'You already have 3 payments waiting for approval.' });
  const price = payments.prices().items.find((i) => i.key === item);
  const usd = price.usd * qty;
  const amount = currency.toLowerCase() === 'zig' ? payments.toZig(usd) : usd;
  const rec = db.addPayment({
    id: uid(), userId: req.user.id, item, itemName: price.name, qty, currency, amount, amountUsd: usd,
    reference, status: 'pending', createdAt: Date.now(),
  });
  res.json({ ok: true, payment: paymentView(rec) });
});

app.get('/api/admin/payment-requests', requireAdmin, (req, res) => {
  const all = db.allPayments().slice().reverse();
  const pending = all.filter((x) => x.status === 'pending').map(paymentView).reverse(); // oldest first
  res.json({ pending, recent: all.filter((x) => x.status !== 'pending').slice(0, 15).map(paymentView) });
});

app.post('/api/admin/payment-requests/:id/approve', requireAdmin, (req, res) => {
  const x = db.findPayment(req.params.id);
  if (!x) return res.status(404).json({ error: 'Payment not found' });
  if (x.status !== 'pending') return res.status(409).json({ error: `Already ${x.status}.` });
  const u = db.findUserById(x.userId);
  if (!u) return res.status(404).json({ error: 'User no longer exists' });
  const what = applyPurchase(u, x.item, x.qty);
  x.status = 'approved';
  x.decidedAt = Date.now();
  notifyUser(u.id, `Payment confirmed (${x.currency} ${x.amount}, ref ${x.reference}). Activated: ${what}. Thank you!`);
  db.save();
  res.json({ ok: true, payment: paymentView(x), activated: what });
});

app.post('/api/admin/payment-requests/:id/reject', requireAdmin, (req, res) => {
  const x = db.findPayment(req.params.id);
  if (!x) return res.status(404).json({ error: 'Payment not found' });
  if (x.status !== 'pending') return res.status(409).json({ error: `Already ${x.status}.` });
  const reason = String((req.body && req.body.reason) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  x.status = 'rejected';
  x.decidedAt = Date.now();
  x.reason = reason;
  notifyUser(x.userId, `We could not confirm your payment (${x.currency} ${x.amount}, ref ${x.reference}).${reason ? ' Reason: ' + reason : ''} Reply here if you need help.`);
  db.save();
  res.json({ ok: true, payment: paymentView(x) });
});

// ---------------------------------------------------------------- referrals
const REF_MIN_MS = () => billing.cfg.refMinUptimeMin * 60 * 1000;

function maskName(n) {
  n = String(n || '');
  return n.slice(0, 2) + '*'.repeat(Math.max(2, Math.min(6, n.length - 2)));
}

app.get('/api/referrals', requireAuth, (req, res) => {
  const mine = db.data.users.filter((u) => u.referredBy === req.user.id);
  const monthAgo = Date.now() - 30 * billing.DAY;
  const rewardedMonth = mine.filter((u) => u.referralStatus === 'rewarded' && u.referralRewardedAt > monthAgo).length;
  res.json({
    code: req.user.username,
    referrerCoins: billing.cfg.refReferrerCoins,
    friendCoins: billing.cfg.refFriendCoins,
    minUptimeMin: billing.cfg.refMinUptimeMin,
    cap: billing.cfg.refMonthlyCap,
    rewardedMonth,
    invited: mine.length,
    earned: mine.filter((u) => u.referralStatus === 'rewarded').length * billing.cfg.refReferrerCoins,
    friends: mine.slice(-20).reverse().map((u) => ({
      name: maskName(u.username),
      status: u.referralStatus === 'rewarded' ? 'rewarded' : u.referralStatus === 'blocked' ? 'blocked' : 'waiting',
      at: u.createdAt,
    })),
  });
});

app.get('/api/admin/referrals', requireAdmin, (req, res) => {
  const rows = db.data.users.filter((u) => u.referredBy).map((u) => {
    const r = db.findUserById(u.referredBy);
    return {
      username: u.username, referrer: r ? r.username : '(deleted)', status: u.referralStatus || 'pending',
      note: u.referralNote || '', joined: u.createdAt, rewardedAt: u.referralRewardedAt || null, welcome: !!u.referralWelcome,
    };
  }).reverse();
  res.json({
    referrals: rows,
    rewarded: rows.filter((x) => x.status === 'rewarded').length,
    coinsGiven: rows.filter((x) => x.status === 'rewarded').length * billing.cfg.refReferrerCoins + rows.filter((x) => x.welcome).length * billing.cfg.refFriendCoins,
  });
});

/** Pay the referrer once the invited friend's bot has really been online for a while. */
function referralTick() {
  let changed = false;
  for (const u of db.data.users) {
    if (!u.referredBy || u.referralStatus !== 'pending') continue;
    const ref = db.findUserById(u.referredBy);
    if (!ref) { u.referralStatus = 'blocked'; u.referralNote = 'Referrer deleted'; changed = true; continue; }
    const myBots = db.botsForUser(u.id);
    const qualified = myBots.find((b) => {
      if (!b.sessionId) return false;
      const st = bots.status(b.id);
      return st.running && st.status === 'running' && st.startedAt && Date.now() - st.startedAt >= REF_MIN_MS();
    });
    if (!qualified) continue;
    // same WhatsApp session as one of the referrer's bots = same person
    const refSessions = new Set(db.botsForUser(ref.id).map((b) => b.sessionId).filter(Boolean));
    if (refSessions.has(qualified.sessionId)) { u.referralStatus = 'blocked'; u.referralNote = 'Same WhatsApp session as the referrer'; changed = true; continue; }
    const monthAgo = Date.now() - 30 * billing.DAY;
    const doneMonth = db.data.users.filter((x) => x.referredBy === ref.id && x.referralStatus === 'rewarded' && x.referralRewardedAt > monthAgo).length;
    if (doneMonth >= billing.cfg.refMonthlyCap) continue; // stays pending until the window frees up
    billing.grantBonus(ref, billing.cfg.refReferrerCoins, `Referral reward (${maskName(u.username)})`);
    u.referralStatus = 'rewarded';
    u.referralRewardedAt = Date.now();
    notifyUser(ref.id, `Your friend ${maskName(u.username)} got their bot online. You earned ${billing.cfg.refReferrerCoins} bonus coins. Thanks for spreading the word!`);
    changed = true;
  }
  if (changed) db.save();
}

// ---------------------------------------------------------------- user bots
app.get('/api/bots', requireAuth, (req, res) => {
  const list = db.botsForUser(req.user.id).map(botView);
  res.json({ bots: list, limit: billing.botLimitFor(req.user) });
});

app.post('/api/bots', requireAuth, (req, res) => {
  const { name, sessionId } = req.body || {};
  const owned = db.botsForUser(req.user.id);
  const limit = billing.botLimitFor(req.user);
  if (owned.length >= limit) {
    return res.status(403).json({
      error:
        `Bot limit reached (${limit}). Add an extra slot for $${billing.cfg.slotPriceUsd}/month, ` +
        'upgrade to Unlimited, or contact the admin.',
      limit,
    });
  }
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Bot name is required' });
  if (!sessionId || !String(sessionId).trim()) return res.status(400).json({ error: 'Session ID is required' });

  // One WhatsApp session = one connection. Reusing a session across bots makes
  // WhatsApp answer with "Stream Errored (conflict)" and both bots flap forever.
  const clash = db
    .listBots()
    .find((b) => b.sessionId && b.sessionId === String(sessionId).trim());
  if (clash) {
    return res.status(409).json({
      error: `That session ID is already used by the bot "${clash.name}". Each bot needs its own WhatsApp session.`,
    });
  }

  const bot = {
    id: uid(),
    userId: req.user.id,
    name: String(name).trim().slice(0, 40),
    sessionId: String(sessionId).trim(),
    autoRestart: true,
    createdAt: new Date().toISOString(),
    status: 'stopped',
  };
  db.addBot(bot);
  res.json({ ok: true, bot: botView(bot) });
});

function ownBot(req, res) {
  const bot = db.findBotById(req.params.id);
  if (!bot) {
    res.status(404).json({ error: 'Bot not found' });
    return null;
  }
  if (bot.userId !== req.user.id && !req.user.isAdmin) {
    res.status(403).json({ error: 'Not your bot' });
    return null;
  }
  return bot;
}

// Uptime history: everyone sees 24 hours, the paid pass unlocks 30 days.
app.get('/api/bots/:id/uptime', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  const owner = db.findUserById(bot.userId);
  const full = billing.featureActive(owner, 'uptime');
  res.json({ ...uptime.report(bot, full), summary: billing.featureSummary(owner, 'uptime') });
});

// Paid feature: custom environment variables per bot ("Custom bot settings").
app.get('/api/bots/:id/env', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  const owner = db.findUserById(bot.userId);
  res.json({
    env: bot.env || {},
    active: billing.featureActive(owner, 'envvars'),
    summary: billing.featureSummary(owner, 'envvars'),
    max: envvars.MAX_VARS,
  });
});

app.put('/api/bots/:id/env', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  const owner = db.findUserById(bot.userId);
  if (!billing.featureActive(owner, 'envvars')) {
    return res.status(402).json({
      error: `Custom bot settings is a paid feature ($${billing.cfg.envPriceUsd}/month). Buy it on the Pay page to unlock it.`,
    });
  }
  const r = envvars.sanitize(req.body && req.body.env);
  if (!r.ok) return res.status(400).json({ error: r.error });
  db.updateBot(bot.id, { env: r.env });
  const running = bots.status(bot.id).running;
  res.json({
    ok: true,
    env: r.env,
    restartNeeded: running,
    message: running ? 'Saved. Restart the bot to apply the new settings.' : 'Saved. They apply the next time the bot starts.',
  });
});

app.patch('/api/bots/:id', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  const patch = {};
  if (req.body.name) patch.name = String(req.body.name).trim().slice(0, 40);
  if (typeof req.body.sessionId === 'string' && req.body.sessionId.trim()) {
    const nextSession = req.body.sessionId.trim();
    const clash = db
      .listBots()
      .find((b) => b.id !== bot.id && b.sessionId && b.sessionId === nextSession);
    if (clash) {
      return res.status(409).json({
        error: `That session ID is already used by the bot "${clash.name}". Each bot needs its own WhatsApp session.`,
      });
    }
    patch.sessionId = nextSession;
  }
  if (typeof req.body.autoRestart === 'boolean') patch.autoRestart = req.body.autoRestart;
  db.updateBot(bot.id, patch);
  res.json({ ok: true, bot: botView(db.findBotById(bot.id)) });
});

app.delete('/api/bots/:id', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  bots.stop(bot.id);
  db.deleteBot(bot.id);
  res.json({ ok: true });
});

app.post('/api/bots/:id/start', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;

  // Safety net: if another bot is still running on the same session, stop it
  // first. Two sockets on one session always end in a conflict loop.
  const twin = db
    .listBots()
    .find((b) => b.id !== bot.id && b.sessionId && b.sessionId === bot.sessionId);
  if (twin && bots.status(twin.id).running) {
    bots.stop(twin.id);
    db.updateBot(twin.id, { status: 'stopped' });
  }

  const owner = db.findUserById(bot.userId) || req.user;
  const auth = billing.authorize(owner, bot);
  if (!auth.ok) return res.status(402).json({ error: auth.reason, billing: billing.summary(owner) });
  if (auth.charged) db.save();
  db.updateBot(bot.id, { status: 'running', suspendedReason: null, ...(auth.until ? { coinPaidUntil: auth.until } : {}) });
  const r = bots.start(db.findBotById(bot.id));
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, preparing: !!r.preparing, message: r.message, status: bots.status(bot.id) });
});

app.post('/api/bots/:id/stop', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  db.updateBot(bot.id, { status: 'stopped' });
  bots.stop(bot.id);
  res.json({ ok: true, status: bots.status(bot.id) });
});

app.post('/api/bots/:id/restart', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  const owner = db.findUserById(bot.userId) || req.user;
  const auth = billing.authorize(owner, bot);
  if (!auth.ok) return res.status(402).json({ error: auth.reason, billing: billing.summary(owner) });
  if (auth.charged) db.save();
  db.updateBot(bot.id, { status: 'running', suspendedReason: null, ...(auth.until ? { coinPaidUntil: auth.until } : {}) });
  bots.restart(db.findBotById(bot.id));
  res.json({ ok: true });
});

app.get('/api/bots/:id/logs', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  res.json({ logs: bots.logs(bot.id, parseInt(req.query.limit || '200', 10)), status: bots.status(bot.id) });
});

// Free feature: download the bot's full log buffer as a plain-text file.
// Secrets (session IDs, custom env var values) are scrubbed before sending.
app.get('/api/bots/:id/logs/download', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  const secrets = [bot.sessionId, ...Object.values(bot.env || {})]
    .map((v) => String(v || ''))
    .filter((v) => v.length >= 6);
  const scrub = (line) => {
    let out = String(line).replace(/Ladybug![A-Za-z0-9+/=_-]{8,}/g, 'Ladybug![hidden]');
    for (const sec of secrets) out = out.split(sec).join('[hidden]');
    return out;
  };
  const entries = bots.logs(bot.id, 100000);
  const st = bots.status(bot.id);
  const header = [
    `Ladybug Cloud - logs for "${bot.name}"`,
    `Exported: ${new Date().toISOString()}`,
    `Status: ${st && st.status ? st.status : 'unknown'}`,
    `Lines: ${entries.length} (the last 600 lines are kept per bot)`,
    '='.repeat(60),
    '',
  ];
  const body = entries.map(
    (l) => `[${new Date(l.t).toISOString()}] ${l.stream === 'stderr' ? 'ERR' : 'OUT'} ${scrub(l.line)}`
  );
  const safeName = String(bot.name || 'bot').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40) || 'bot';
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safeName}-logs-${stamp}.txt"`,
    'Cache-Control': 'no-store',
  });
  res.send(header.concat(body).join('\n') + '\n');
});

app.delete('/api/bots/:id/logs', requireAuth, (req, res) => {
  const bot = ownBot(req, res);
  if (!bot) return;
  bots.clearLogs(bot.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- sessions
// In-browser session generator: request a pairing code, then poll for the
// finished `Ladybug!...` session id.
app.post('/api/session/pair', requireAuth, (req, res) => {
  try {
    const job = sessiongen.start((req.body || {}).phone);
    res.json({ ok: true, job });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/session/pair/:id', requireAuth, (req, res) => {
  const job = sessiongen.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Pairing job not found or expired.' });
  res.json({ job });
});

app.delete('/api/session/pair/:id', requireAuth, (req, res) => {
  sessiongen.cancel(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public status
app.get('/api/status', (req, res) => {
  const allBots = db.listBots();
  const users = db.data.users || [];
  const running = allBots.filter((b) => bots.status(b.id).running).length;
  const installed = bots.botCodeInstalled();
  res.json({
    ok: true,
    platform: 'Ladybug Cloud',
    brand: 'Ntandomods',
    uptime: Math.round(process.uptime()),
    installed,
    stats: {
      users: users.length,
      bots: allBots.length,
      running,
      stopped: allBots.length - running,
    },
    bots: allBots
      .map((b) => {
        const st = bots.status(b.id);
        return {
          id: b.id,
          name: b.name,
          status: st.status,
          running: st.running,
          startedAt: st.startedAt,
          uptime: st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : 0,
        };
      })
      .sort((a, b) => Number(b.running) - Number(a.running))
      .slice(0, 50),
    generatedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------- admin
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const data = db.data;
  const mem = process.memoryUsage();
  res.json({
    users: data.users.length,
    admins: data.users.filter((u) => u.isAdmin).length,
    bots: data.bots.length,
    running: bots.runningCount(),
    installed: installer.getState().installed,
    uptime: process.uptime(),
    memory: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) },
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    cpus: os.cpus().length,
    backup: mongoSync.status(),
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.data.users.map((u) => ({
    ...publicUser(u),
    botCount: db.botsForUser(u.id).length,
  }));
  res.json({ users });
});

app.patch('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const patch = {};
  if (req.body.plan) {
    patch.plan = req.body.plan;
    patch.botLimit = req.body.plan === 'pro' ? PRO_BOT_LIMIT : FREE_BOT_LIMIT;
  }
  if (typeof req.body.botLimit === 'number') patch.botLimit = req.body.botLimit;
  if (typeof req.body.isAdmin === 'boolean') patch.isAdmin = req.body.isAdmin;
  if (typeof req.body.grantSubscriptionDays === 'number') {
    const days = req.body.grantSubscriptionDays;
    const base = u.subscriptionUntil && u.subscriptionUntil > Date.now() ? u.subscriptionUntil : Date.now();
    patch.subscriptionUntil = days <= 0 ? null : base + days * billing.DAY;
  }
  if (typeof req.body.grantCoins === 'number') {
    u.coins = Math.max(0, (u.coins || 0) + Math.round(req.body.grantCoins));
    patch.coins = u.coins;
  }
  if (typeof req.body.grantAutoClaimDays === 'number') {
    const days = req.body.grantAutoClaimDays;
    patch.autoClaimUntil = days <= 0 ? null : billing.grantAutoClaim(u, days);
    patch.autoClaimRequestedAt = null;
  }
  if (typeof req.body.grantSlotDays === 'number') {
    const days = req.body.grantSlotDays;
    const count = Math.max(1, Math.min(10, Math.round(req.body.grantSlots || 1)));
    if (days <= 0) {
      billing.grantExtraSlots(u, 0, 0);
      patch.extraSlots = 0;
      patch.extraSlotsUntil = null;
    } else {
      const r = billing.grantExtraSlots(u, count, days);
      patch.extraSlots = r.slots;
      patch.extraSlotsUntil = r.until;
    }
    patch.slotRequestedAt = null;
    patch.slotRequestedCount = null;
  }
  if (billing.FEATURES[req.body.grantFeature] && typeof req.body.grantFeatureDays === 'number') {
    const field = billing.FEATURES[req.body.grantFeature].field;
    patch[field] = billing.grantFeature(u, req.body.grantFeature, req.body.grantFeatureDays);
  }
  if (typeof req.body.extendTrialDays === 'number') {
    const base = u.trialEndsAt && u.trialEndsAt > Date.now() ? u.trialEndsAt : Date.now();
    patch.trialEndsAt = base + req.body.extendTrialDays * billing.DAY;
  }
  if (req.body.password) patch.passwordHash = bcrypt.hashSync(String(req.body.password), 10);
  db.updateUser(u.id, patch);
  res.json({ ok: true, user: publicUser(db.findUserById(u.id)) });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own admin account' });
  for (const b of db.botsForUser(u.id)) bots.stop(b.id);
  db.deleteUser(u.id);
  storage.removeAll(u.id).catch((e) => console.error('[storage] cleanup failed:', e.message));
  res.json({ ok: true });
});

app.get('/api/admin/bots', requireAdmin, (req, res) => {
  const list = db.data.bots.map((b) => {
    const owner = db.findUserById(b.userId);
    const st = bots.status(b.id);
    const info = sessioninfo.decode(b.sessionId);
    // the number the bot itself reported on connect wins; fall back to the one inside the session
    const number = st.wa.number || (info && info.number) || null;
    return {
      ...botView(b),
      owner: owner ? owner.username : 'deleted',
      waNumber: number,
      waName: info ? info.name : null,
      waState: st.wa.state,
      waSince: st.wa.since,
      lastLogAt: st.lastLogAt,
    };
  });
  res.json({ bots: list });
});

app.post('/api/admin/bots/:id/stop', requireAdmin, (req, res) => {
  const bot = db.findBotById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  db.updateBot(bot.id, { status: 'stopped' });
  bots.stop(bot.id);
  res.json({ ok: true });
});

app.delete('/api/admin/bots/:id', requireAdmin, (req, res) => {
  const bot = db.findBotById(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  bots.stop(bot.id);
  db.deleteBot(bot.id);
  res.json({ ok: true });
});

// --- bot code installer ---
app.get('/api/admin/installer', requireAdmin, (req, res) => {
  res.json(installer.getState());
});

app.post('/api/admin/installer/github', requireAdmin, async (req, res) => {
  try {
    const url = req.body && req.body.url ? String(req.body.url) : undefined;
    const r = await installer.installFromGitHub(url);
    res.json({ ok: true, ...r, state: installer.getState() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/installer/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const r = await installer.installFromBuffer(req.file.buffer, req.file.originalname);
    res.json({ ok: true, ...r, state: installer.getState() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/installer/deps', requireAdmin, (req, res) => {
  const r = installer.installDependencies();
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});


// ---------------------------------------------------------------- Ladybug Drive (file storage)
const driveUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, storage.TMP),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`),
  }),
  limits: { fileSize: storage.MAX_FILE_MB * 1024 * 1024, files: 20 },
});
const driveLimiter = rateLimit({ windowMs: 60_000, max: 120, key: (req) => req.session.userId || req.ip });

function driveSummary(user) {
  const used = storage.userUsed(user.id);
  const quota = storage.userQuotaBytes(user);
  const plat = storage.platform();
  return {
    usedBytes: used,
    quotaBytes: Math.min(quota, plat.capacityBytes),
    maxFileMB: storage.MAX_FILE_MB,
    platform: user.isAdmin ? plat : { capacityBytes: plat.capacityBytes, usedBytes: plat.usedBytes, freeBytes: plat.freeBytes, limited: plat.limited, persistent: plat.persistent, backend: plat.backend },
  };
}

app.get('/api/storage', requireAuth, driveLimiter, (req, res) => {
  try {
    const listing = storage.list(req.user.id, req.query.path);
    res.json({ ...listing, ...driveSummary(req.user), breakdown: storage.breakdown(req.user.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/storage/upload', requireAuth, driveLimiter, (req, res) => {
  driveUpload.array('files', 20)(req, res, async (err) => {
    const files = req.files || [];
    const discard = () => files.forEach((f) => fs.rm(f.path, { force: true }, () => {}));
    if (err) { discard(); return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${storage.MAX_FILE_MB} MB each).` : err.message }); }
    if (!files.length) return res.status(400).json({ error: 'No files received' });
    const saved = [];
    try {
      for (const f of files) {
        saved.push(await storage.accept(req.user, req.query.path, f.path, f.originalname, f.size));
      }
    } catch (e) {
      discard();
      return res.status(400).json({ error: e.message, saved });
    }
    res.json({ ok: true, saved, ...driveSummary(req.user) });
  });
});

app.post('/api/storage/folder', requireAuth, driveLimiter, async (req, res) => {
  try { await storage.mkdir(req.user.id, req.body.path, req.body.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/storage/rename', requireAuth, driveLimiter, async (req, res) => {
  try { await storage.rename(req.user.id, req.body.path, req.body.name); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/storage', requireAuth, driveLimiter, async (req, res) => {
  try { await storage.remove(req.user.id, req.query.path); res.json({ ok: true, ...driveSummary(req.user) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/storage/download', requireAuth, driveLimiter, (req, res) => {
  try {
    const { full } = storage.resolveIn(req.user.id, req.query.path);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).json({ error: 'File not found' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(full, path.basename(full));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/admin/storage', requireAdmin, (req, res) => {
  const users = db.data.users || [];
  res.json({
    platform: storage.platform(),
    userQuotaGB: storage.USER_GB,
    maxFileMB: storage.MAX_FILE_MB,
    users: users.map((u) => ({ id: u.id, username: u.username, usedBytes: storage.userUsed(u.id) }))
      .filter((u) => u.usedBytes > 0).sort((a, b) => b.usedBytes - a.usedBytes).slice(0, 50),
  });
});

// ---------------------------------------------------------------- static
app.get('/healthz', (req, res) => {
  const mem = process.memoryUsage();
  const allBots = db.listBots();
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    node: process.version,
    memoryMB: Math.round(mem.rss / 1048576),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    botsRunning: allBots.filter((b) => bots.status(b.id).running).length,
    botsTotal: allBots.length,
    botCodeInstalled: bots.botCodeInstalled(),
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------- boot
const server = app.listen(PORT, () => {
  console.log(`\n🐞 Ladybug Cloud running on port ${PORT}`);
  console.log(`   Admin: ${ADMIN_USERNAME}`);
  console.log(`   Bot code installed: ${installer.getState().installed ? 'yes' : 'no'}`);
});

// Resume bots that were running before a restart. On ephemeral filesystems the
// bot's node_modules may be gone, so make sure they exist first.
// A short delay lets an overlapping old instance (zero-downtime redeploys) shut
// its sockets down first - WhatsApp rejects two connections on one session.
const BOOT_RESUME_DELAY_MS = Math.max(3, parseInt(process.env.BOOT_RESUME_DELAY_SEC || '20', 10)) * 1000;
setTimeout(async () => {
  const pending = db.data.bots.filter((b) => b.status === 'running' && b.sessionId);
  if (!pending.length) return;
  console.log(`[boot] ${pending.length} bot(s) were running before the restart - resuming`);

  if (installer.getState().installed && !installer.depsInstalled()) {
    console.log('[boot] Bot dependencies missing - installing before resume...');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await installer.ensureDependencies((line) => console.log(`[deps] ${line}`));
        console.log('[boot] Dependencies ready.');
        break;
      } catch (e) {
        console.error(`[boot] Dependency install failed (attempt ${attempt}/3): ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  for (const bot of pending) {
    console.log(`[boot] Resuming bot "${bot.name}"`);
    try { bots.start(bot); } catch (e) { console.error(`[boot] could not start "${bot.name}": ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1500)); // stagger so the host is not hit all at once
  }
}, BOOT_RESUME_DELAY_MS);

// Watchdog: every minute make sure every bot that SHOULD be running IS running.
// Covers crash loops that exhausted auto-restart, failed resumes and WhatsApp
// conflicts during redeploys. Bots the user stopped (status 'stopped') are left alone.
function botWatchdog() {
  try {
    for (const bot of db.listBots()) {
      if (bot.status !== 'running' || !bot.sessionId) continue;
      bots.markHealthy(bot.id);
      const owner = db.findUserById(bot.userId);
      if (!owner) continue;
      // never revive a bot its owner can no longer pay for - billingTick stops those
      const paid = billing.runsFree(owner) || (bot.coinPaidUntil && bot.coinPaidUntil > Date.now()) ||
        billing.totalCoins(owner) >= billing.cfg.botCoinCost;
      if (!paid) continue;
      if (bots.revive(bot)) console.log(`[watchdog] restarted "${bot.name}" (${owner.username})`);
    }
  } catch (e) {
    console.error(`[watchdog] pass failed: ${e.message}`);
  }
}
setTimeout(() => setInterval(botWatchdog, 60 * 1000).unref(), BOOT_RESUME_DELAY_MS + 30 * 1000).unref();

// Keep-alive: Render's free plan puts the service to sleep after ~15 minutes without
// inbound traffic, which takes every bot offline. Pinging our own public URL counts as
// traffic. Only active when Render provides the public URL (or KEEP_ALIVE_URL is set).
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
if (KEEP_ALIVE_URL && process.env.KEEP_ALIVE !== 'false') {
  const pingUrl = KEEP_ALIVE_URL.replace(/\/+$/, '') + '/healthz';
  setInterval(() => {
    fetch(pingUrl, { signal: AbortSignal.timeout(15000) }).catch((e) => console.error(`[keep-alive] ping failed: ${e.message}`));
  }, 10 * 60 * 1000).unref();
  console.log(`[keep-alive] pinging ${pingUrl} every 10 minutes`);
}

// Every minute: renew coin-funded bots, stop the ones that can no longer pay,
// and top up anyone paying for auto-claim.
function billingTick() {
  try {
    const claimed = billing.runAutoClaims(db.data.users);
    if (claimed.length) {
      db.save();
      for (const c of claimed) {
        console.log(`[auto-claim] +${c.added} coins for ${c.user.username} (balance ${c.coins})`);
      }
    }
  } catch (e) {
    console.error(`[auto-claim] pass failed: ${e.message}`);
  }

  for (const bot of db.listBots()) {
    if (bot.status !== 'running' && !bots.status(bot.id).running) continue;
    const owner = db.findUserById(bot.userId);
    if (!owner) continue;
    const auth = billing.authorize(owner, bot);
    if (auth.ok) {
      if (auth.charged) {
        db.updateBot(bot.id, { coinPaidUntil: auth.until });
        db.save();
        console.log(`[billing] renewed "${bot.name}" for ${owner.username}`);
      }
      continue;
    }
    console.log(`[billing] stopping "${bot.name}" (${owner.username}): out of coins`);
    bots.stop(bot.id);
    db.updateBot(bot.id, { status: 'stopped', suspendedReason: 'Out of coins - claim daily coins, buy a coin pack or subscribe, then press Start.' });
  }
}
setInterval(billingTick, 60 * 1000).unref();
setInterval(() => { try { referralTick(); } catch (e) { console.error('[referral]', e.message); } }, 60 * 1000).unref();
setTimeout(billingTick, 5000).unref();
setInterval(() => {
  try { uptime.tick(db.listBots(), (id) => bots.status(id).running, db); } catch (e) { console.error('[uptime]', e.message); }
}, 60 * 1000).unref();

// Sample CPU/memory of running bots every 15s
setInterval(() => { try { bots.sampleResources(); } catch (e) { console.error('[metrics]', e.message); } }, 15 * 1000).unref();

// Loud warning when the built-in default admin credentials are still in use
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'mods') {
  console.warn('\n[security] ADMIN_PASSWORD is not set (default "mods" in use). Set ADMIN_PASSWORD and ADMIN_USERNAME in your environment before going public.\n');
}

function shutdown() {
  console.log('\n[shutdown] stopping bots...');
  bots.stopAll();
  db.flush();
  mongoSync.close().finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
