/**
 * Tests for plans, metering, invoices and saved replies.
 *
 *   lib/plans.js     plan catalog, resolution, grants, limits, grace windows
 *   lib/usage.js     monthly counters, meters, invoices
 *   lib/snippets.js  saved replies: validation, cap, render, search
 *
 * Everything runs against a throwaway DATA_DIR, so db.json never touches the repo.
 *
 * Run: node test/plans-usage.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-plans-test-'));
process.env.DATA_DIR = DATA;

const db = require('../lib/store');
const billing = require('../lib/billing');
const plans = require('../lib/plans');
const usage = require('../lib/usage');
const snippets = require('../lib/snippets');

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? ` → ${detail}` : ''}`);
}
function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function section(t) { console.log(`\n— ${t}`); }

const DAY = 86400000;
const now = Date.now();

function mkUser(extra) {
  const u = Object.assign({
    id: 'u_' + Math.random().toString(36).slice(2, 8),
    username: 'tester' + Math.random().toString(36).slice(2, 6),
    email: '',
    passwordHash: 'x',
    createdAt: new Date().toISOString(),
    coins: 0,
    trialEndsAt: now + 3 * DAY,
  }, extra || {});
  db.addUser(u);
  return db.findUserById(u.id);
}

/* --------------------------------------------------------------- catalog */
section('plan catalog');

const cat = plans.catalog();
eq('four plans', cat.length, 4);
eq('keys in order', cat.map((p) => p.key).join(','), 'free,starter,pro,studio');
ok('free is free', cat[0].usd === 0);
ok('paid plans cost money', cat.slice(1).every((p) => p.usd > 0));
ok('limits grow with price', cat[1].messages < cat[2].messages && cat[2].messages < cat[3].messages);
ok('bots grow with price', cat[1].bots <= cat[2].bots && cat[2].bots < cat[3].bots);
ok('api only on higher plans', cat[0].api === false && cat[1].api === false && cat[2].api === true);
ok('every plan has a blurb', cat.every((p) => p.blurb && p.blurb.length > 10));
eq('paidPlans excludes free', plans.paidPlans().length, 3);
ok('view() returns one plan', plans.view('pro').key === 'pro');
eq('view() of nonsense is null', plans.view('gold'), null);

/* --------------------------------------------------------------- resolution */
section('plan resolution');

const fresh = mkUser();
eq('no plan falls back to free', plans.planKeyFor(fresh, now), 'free');
eq('free limits', plans.limitsFor(fresh, now).key, 'free');
ok('free limits are the free plan numbers', plans.limitsFor(fresh, now).messages === plans.PLANS.free.messages());

const sub = mkUser({ subscriptionUntil: now + 10 * DAY });
eq('legacy subscription reads as starter', plans.planKeyFor(sub, now), 'starter');
eq('legacy subscription limits are starter', plans.limitsFor(sub, now).messages, plans.PLANS.starter.messages());

const expired = mkUser({ planKey: 'pro', planUntil: now - DAY, subscriptionUntil: now - DAY });
eq('expired plan falls back to free', plans.planKeyFor(expired, now), 'free');

const admin = mkUser({ isAdmin: true });
eq('admins get studio', plans.planKeyFor(admin, now), 'studio');
ok('admins are always active', plans.planActive(admin, now) === true);

/* --------------------------------------------------------------- grants */
section('granting plans');

const buyer = mkUser();
const g = plans.grantPlan(buyer, 'pro', 30);
ok('grant returns the plan', g && g.key === 'pro');
eq('plan key stored', buyer.planKey, 'pro');
ok('plan until is ~30 days out', Math.abs(buyer.planUntil - (now + 30 * DAY)) < 5000);
eq('subscriptionUntil mirrors planUntil', buyer.subscriptionUntil, buyer.planUntil);
eq('botLimit mirrors the plan', buyer.botLimit, plans.PLANS.pro.bots());
eq('limits follow the grant', plans.limitsFor(buyer, now).messages, plans.PLANS.pro.messages());
ok('plan is active', plans.planActive(buyer, now));

// buying the same plan again should extend, not reset
const before = buyer.planUntil;
plans.grantPlan(buyer, 'pro', 30);
ok('same plan stacks', buyer.planUntil > before + 29 * DAY, String(buyer.planUntil - before));

// switching plans starts from now
const switcher = mkUser();
plans.grantPlan(switcher, 'starter', 30);
plans.grantPlan(switcher, 'studio', 30);
eq('switch changes the key', switcher.planKey, 'studio');
ok('switch does not stack the old plan', switcher.planUntil < now + 31 * DAY);

const cleared = mkUser({ planKey: 'pro', planUntil: now + 5 * DAY });
eq('granting free clears', plans.grantPlan(cleared, 'free', 30), null);
eq('planKey cleared', cleared.planKey, null);
eq('planUntil cleared', cleared.planUntil, null);

/* --------------------------------------------------------------- limits + slots */
section('limits and extra slots');

const slotty = mkUser();
plans.grantPlan(slotty, 'starter', 30);
const baseBots = plans.limitsFor(slotty, now).bots;
billing.grantExtraSlots(slotty, 2);
eq('extra slots raise the bot cap', plans.limitsFor(slotty, now).bots, baseBots + 2);

const apiUser = mkUser();
plans.grantPlan(apiUser, 'pro', 30);
ok('pro includes the API', plans.limitsFor(apiUser, now).api === true);
const freeUser = mkUser();
ok('free has no API', plans.limitsFor(freeUser, now).api === false);

/* --------------------------------------------------------------- grace */
section('grace windows');

const lapsed = mkUser({ planKey: 'starter', planUntil: now - DAY, subscriptionUntil: now - DAY, trialEndsAt: 1 });
const grace = plans.graceFor(lapsed, now);
ok('a recently lapsed plan has grace', grace.active);
eq('grace days left', grace.daysLeft, plans.graceDays() - 1);
const longGone = mkUser({ planKey: 'starter', planUntil: now - 30 * DAY, subscriptionUntil: now - 30 * DAY, trialEndsAt: 1 });
ok('old lapses have no grace', !plans.graceFor(longGone, now).active);
ok('admins never get grace', !plans.graceFor(admin, now).active);

/* --------------------------------------------------------------- summary */
section('plan summary');

const sum = plans.summary(buyer, now);
eq('summary key', sum.key, 'pro');
ok('summary has limits', sum.limits && sum.limits.messages > 0);
ok('summary lists plans', Array.isArray(sum.plans) && sum.plans.length === 4);
ok('summary says paid', sum.paid === true);
ok('summary counts days left', sum.daysLeft > 0);

/* --------------------------------------------------------------- metering */
section('usage metering');

const m = usage.monthKey(new Date(Date.UTC(2026, 2, 9)));
eq('month key', m, '2026-03');
eq('month start', usage.monthStart('2026-03'), Date.UTC(2026, 2, 1));
eq('shift back one', usage.shiftMonth('2026-01', -1), '2025-12');
eq('shift forward one', usage.shiftMonth('2025-12', 1), '2026-01');
eq('shift across a year', usage.shiftMonth('2026-03', -6), '2025-09');

const meter = usage.meter(50, 100);
eq('meter pct', meter.pct, 50);
eq('meter left', meter.left, 50);
ok('meter not warning at half', !meter.warn);
ok('meter warns at 80%', usage.meter(80, 100).warn);
ok('meter flags over', usage.meter(120, 100).over);
const unlimited = usage.meter(500, null);
eq('unlimited has no cap', unlimited.cap, null);
eq('unlimited pct', unlimited.pct, 0);
ok('unlimited never warns', !unlimited.warn);

const metered = mkUser();
plans.grantPlan(metered, 'starter', 30);
usage.record(metered.id, 'messages', 3);
usage.record(metered.id, 'messages', 2);
usage.record(metered.id, 'ai', 1);
const month = usage.monthKey(new Date());
eq('messages counted', db.usageFor(metered.id, month).messages, 5);
eq('ai counted', db.usageFor(metered.id, month).ai, 1);
ok('record ignores unknown kinds', (() => { usage.record(metered.id, 'nonsense', 5); return !db.usageFor(metered.id, month).nonsense; })());
ok('record ignores zero', (() => { usage.record(metered.id, 'messages', 0); return db.usageFor(metered.id, month).messages === 5; })());

const check = usage.check(metered, 'messages');
ok('check ok under the cap', check.ok);
eq('check reports the cap', check.cap, plans.PLANS.starter.messages());

const tight = mkUser();
plans.grantPlan(tight, 'starter', 30);
db.bumpUsage(tight.id, month, 'messages', plans.PLANS.starter.messages());
ok('check blocks at the cap', !usage.check(tight, 'messages').ok);
ok('check still allows other kinds', usage.check(tight, 'ai').ok);

const view = usage.view(metered, now);
eq('view plan key', view.plan.key, 'starter');
eq('view messages used', view.meters.messages.used, 5);
ok('view has six months', view.history.length === 6);
eq('view history is newest first', view.history[0].month, month);
ok('view has bots', typeof view.bots.used === 'number' && view.bots.cap >= 1);
ok('view offers upgrades', Array.isArray(view.upgrade) && view.upgrade.indexOf('pro') >= 0);

/* --------------------------------------------------------------- pruning */
section('pruning old months');

const pruner = mkUser();
db.bumpUsage(pruner.id, '2020-01', 'messages', 9);
db.bumpUsage(pruner.id, '2021-06', 'messages', 9);
const removed = db.pruneUsage(6, now);
ok('prune removed old rows', removed >= 2, String(removed));
eq('old row gone', db.usageFor(pruner.id, '2020-01').messages, undefined);
eq('current row kept', db.usageFor(pruner.id, month).messages, undefined);
ok('recent row survives', db.usageFor(metered.id, month).messages === 5);

/* --------------------------------------------------------------- invoices */
section('invoices');

function pay(user, extra) {
  const p = Object.assign({
    id: 'p_' + Math.random().toString(36).slice(2, 10),
    userId: user.id,
    item: 'unlimited',
    itemName: 'Unlimited hosting (30 days)',
    qty: 1,
    currency: 'USD',
    amount: 3,
    amountUsd: 3,
    status: 'approved',
    createdAt: now,
  }, extra || {});
  db.addPayment(p);
  return p;
}

const payer = mkUser();
const p1 = pay(payer);
const p2 = pay(payer, { item: 'pro', itemName: 'Pro plan (30 days)', amount: 8, amountUsd: 8, status: 'pending', createdAt: now - DAY });
const p3 = pay(payer, { item: 'coins100', amount: 1, amountUsd: 1, status: 'rejected', createdAt: now - 2 * DAY });
pay(mkUser(), { amount: 99, amountUsd: 99 }); // someone else's payment

const number = usage.invoiceNumber(p1);
ok('invoice number is stable', number === usage.invoiceNumber(p1));
ok('invoice number is readable', /^LB-\d{6}-[A-Z0-9]{4}$/.test(number), number);

const inv = usage.invoices(payer);
eq('only my invoices', inv.count, 3);
eq('newest first', inv.items[0].id, p1.id);
eq('paid total', inv.paidUsd, 3);
eq('pending total', inv.pendingUsd, 8);
eq('rejected total', inv.rejectedUsd, 1);
eq('currency', inv.currency, 'USD');
ok('invoice rows carry a number', inv.items.every((i) => i.number && i.date));

const one = usage.invoice(payer, p1.id);
ok('single invoice found', one && one.invoice.id === p1.id);
eq('invoice names the seller', one.seller.name, 'Ladybug Cloud');
eq('invoice carries the plan', one.plan.key, plans.planKeyFor(payer, now));
eq('invoice hides other users payments', usage.invoice(payer, 'nope'), null);

/* --------------------------------------------------------------- snippets */
section('saved replies');

const snipUser = mkUser();
eq('empty at first', snippets.list(snipUser.id).length, 0);
const empty = snippets.view2(snipUser.id);
ok('suggestions offered while empty', empty.suggestions.length > 0);
eq('cap is a number', typeof empty.max, 'number');

const made = snippets.create(snipUser.id, { shortcut: '/Price', title: 'Price list', body: 'Hi {first}, plans start at $3.', tags: ['Sales', 'pricing'] });
ok('create returns a snippet', made.snippet && made.snippet.id);
eq('shortcut normalised', made.snippet.shortcut, 'price');
eq('tags lowercased', made.snippet.tags.join(','), 'sales,pricing');
eq('suggestions hidden once you have one', snippets.view2(snipUser.id).suggestions.length, 0);

ok('duplicate shortcut refused', !!snippets.create(snipUser.id, { shortcut: 'price', title: 'x', body: 'y' }).error);
ok('missing title refused', !!snippets.create(snipUser.id, { shortcut: 'a1', body: 'y' }).error);
ok('missing body refused', !!snippets.create(snipUser.id, { shortcut: 'a1', title: 't' }).error);
ok('bad shortcut refused', !!snippets.create(snipUser.id, { shortcut: 'has space', title: 't', body: 'y' }).error);
const trunc = snippets.create(mkUser().id, { shortcut: 'big', title: 't', body: 'x'.repeat(2100) });
eq('overlong body is truncated, not refused', trunc.snippet.body.length, 2000);

const found = snippets.find(snipUser.id, 'price');
ok('find by shortcut', found && found.id === made.snippet.id);
ok('find by id', snippets.find(snipUser.id, made.snippet.id).id === made.snippet.id);
ok('find is scoped to the owner', snippets.find(mkUser().id, made.snippet.id) === null);

const used = snippets.use(snipUser.id, 'price', { name: 'Tendai Moyo', first: 'Tendai', bot: 'Ladybug' });
eq('render fills {first}', used.text, 'Hi Tendai, plans start at $3.');
eq('use bumps the counter', used.snippet.uses, 1);
eq('render handles unknown vars', snippets.render('{nope} {bot}', { bot: 'B' }), '{nope} B');
ok('render fills date', /\d/.test(snippets.render('{date}', {})));

const edited = snippets.update(snipUser.id, 'price', { title: 'Prices' });
eq('update changes the title', edited.snippet.title, 'Prices');
ok('update keeps the shortcut', edited.snippet.shortcut === 'price');

const second = snippets.create(snipUser.id, { shortcut: 'hours', title: 'Opening hours', body: 'We open at 8am.' });
ok('second snippet created', second.snippet && second.snippet.shortcut === 'hours');
eq('search by title', snippets.search(snipUser.id, 'open').length, 1);
eq('search by body', snippets.search(snipUser.id, '8am').length, 1);
eq('search misses', snippets.search(snipUser.id, 'zzzz').length, 0);

ok('remove works', snippets.remove(snipUser.id, 'hours') === true);
eq('removed', snippets.list(snipUser.id).length, 1);
ok('remove of nothing is false', snippets.remove(snipUser.id, 'hours') === false);

// the cap
const capUser = mkUser();
const cap = snippets.view2(capUser.id).max;
for (let i = 0; i < cap; i++) {
  const r = snippets.create(capUser.id, { shortcut: 's' + i, title: 'S' + i, body: 'body' });
  ok('fill up to the cap ' + i, !!r.snippet);
}
ok('cap enforced', !!snippets.create(capUser.id, { shortcut: 'over', title: 'x', body: 'y' }).error);

// deleting a user takes their snippets and usage with them
const doomed = mkUser();
snippets.create(doomed.id, { shortcut: 'gone', title: 'Gone', body: 'bye' });
usage.record(doomed.id, 'messages', 1);
db.deleteUser(doomed.id);
eq('snippets purged with the user', snippets.list(doomed.id).length, 0);
eq('usage purged with the user', db.usageFor(doomed.id, month).messages, undefined);

/* --------------------------------------------------------------- store defaults */
section('store defaults');

ok('usage bucket exists', typeof db.data.usage === 'object' && db.data.usage !== null);
ok('snippets bucket exists', Array.isArray(db.data.snippets));

/* --------------------------------------------------------------- report */
console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
