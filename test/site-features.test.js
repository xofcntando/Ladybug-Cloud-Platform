/**
 * Unit tests for the two site-wide features:
 *   - lib/activity.js      (account-wide audit trail)
 *   - lib/site-search.js   (cross-entity search for the command palette)
 *
 * Run: node test/site-features.test.js
 * Uses a throwaway DATA_DIR so the real data/db.json is never touched.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-site-'));

const db = require('../lib/store');
const events = require('../lib/events');
const storage = require('../lib/storage');
const activity = require('../lib/activity');
const siteSearch = require('../lib/site-search');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m\u2713\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m\u2717\x1b[0m ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function section(t) { console.log('\n' + t); }

/* ---------------------------------------------------------------- fixtures */
const alice = db.addUser({ id: 'u_alice', username: 'alice', email: 'alice@example.com', isAdmin: false });
const bob = db.addUser({ id: 'u_bob', username: 'bob', email: 'bob@example.com', isAdmin: false });

const botA = db.addBot({ id: 'b_alpha', userId: alice.id, name: 'Alpha Bot', status: 'running', hasSession: true });
db.addBot({ id: 'b_beta', userId: alice.id, name: 'Beta Helper', status: 'stopped' });
db.addBot({ id: 'b_secret', userId: bob.id, name: 'Alpha Secret', status: 'running' });

/* ---------------------------------------------------------------- activity: basics */
section('activity: writing and reading');
{
  activity.log(alice.id, { type: 'security', title: 'Signed in', detail: 'From 10.0.0.1' });
  activity.log(alice.id, { type: 'billing', title: 'Payment submitted', detail: 'Coins x1 - USD 3 (ref ABC).', meta: { item: 'coins100', amount: 3 } });
  activity.log(alice.id, { type: 'storage', title: 'Uploaded report.pdf', detail: '1.2 MB' });

  const r = activity.list(alice.id);
  eq('three entries stored', r.total, 3);
  eq('newest first', r.items[0].title, 'Uploaded report.pdf');
  eq('all unseen at first', r.unseen, 3);
  ok('ids are unique', new Set(r.items.map((i) => i.id)).size === 3);
  ok('timestamps are numbers', r.items.every((i) => typeof i.t === 'number' && i.t > 0));
  eq('type list exposed', r.types.map((t) => t.id), ['bot', 'billing', 'storage', 'security', 'account']);
  eq('bob sees nothing of alice', activity.list(bob.id).total, 0);
}

section('activity: filters, search and pagination');
{
  const onlyBilling = activity.list(alice.id, { type: 'billing' });
  eq('type filter narrows to billing', onlyBilling.items.length, 1);
  eq('filtered total is the filtered count', onlyBilling.matching, 1);
  eq('unfiltered total still reported', onlyBilling.total, 3);

  const found = activity.list(alice.id, { q: 'report' });
  eq('search matches title', found.items.length, 1);
  eq('search matches meta values', activity.list(alice.id, { q: 'coins100' }).items.length, 1);
  eq('search is case-insensitive', activity.list(alice.id, { q: 'SIGNED' }).items.length, 1);
  eq('multi-word search ANDs', activity.list(alice.id, { q: 'signed 10.0.0.1' }).items.length, 1);
  eq('no match returns nothing', activity.list(alice.id, { q: 'zzzz' }).items.length, 0);
  eq('unknown type is ignored, not fatal', activity.list(alice.id, { type: 'nope' }).items.length, 3);

  const page1 = activity.list(alice.id, { limit: 2 });
  eq('limit respected', page1.items.length, 2);
  ok('hasMore when more remain', page1.hasMore === true);
  ok('cursor points at the last item', page1.nextBefore === page1.items[1].t);
  const page2 = activity.list(alice.id, { limit: 2, before: page1.nextBefore });
  eq('second page has the remainder', page2.items.length, 1);
  ok('second page has no more', page2.hasMore === false);
  ok('pages do not overlap', !page2.items.some((i) => page1.items.some((j) => j.id === i.id)));
}

section('activity: read state and CSV');
{
  const before = activity.list(alice.id);
  const first = before.items[0];
  const r = activity.markSeen(alice.id, [first.id]);
  eq('one entry marked read', r.changed, 1);
  eq('unseen count drops', r.unseen, 2);
  eq('that entry is now seen', activity.list(alice.id).items.find((i) => i.id === first.id).seen, true);

  const all = activity.markSeen(alice.id, []);
  eq('mark all clears the rest', all.unseen, 0);
  eq('marking again changes nothing', activity.markSeen(alice.id, []).changed, 0);

  activity.log(alice.id, { type: 'account', title: 'Note with, a comma', detail: 'He said "hello" and left' });
  const csv = activity.csv(alice.id);
  const lines = csv.trim().split('\r\n');
  eq('csv has a header', lines[0], 'when,iso,category,title,detail,bot,read');
  ok('csv quotes commas and quotes', /"Note with, a comma"/.test(csv) && /"He said ""hello"" and left"/.test(csv), csv.split('\r\n')[1]);
  eq('csv row count matches entries', lines.length, 5); // header + 4
  ok('csv honours the type filter', activity.csv(alice.id, { type: 'billing' }).trim().split('\r\n').length === 2);
}

section('activity: safety and caps');
{
  const long = 'x'.repeat(500);
  const e = activity.log(alice.id, { type: 'made-up', title: long, detail: long });
  ok('title truncated', e.title.length <= 140, String(e.title.length));
  ok('detail truncated', e.detail.length <= 300, String(e.detail.length));
  eq('unknown type falls back to account', e.type, 'account');
  ok('html is stripped from titles', !/[<>]/.test(activity.log(alice.id, { title: '<script>alert(1)</script>' }).title));
  eq('missing title is rejected', activity.log(alice.id, { type: 'account' }), null);
  eq('missing user is rejected', activity.log('', { title: 'x' }), null);
  eq('unknown user simply has no feed', activity.list('u_nobody').total, 0);

  const meta = {};
  for (let i = 0; i < 20; i++) meta['k' + i] = 'v' + i;
  const capped = activity.log(alice.id, { title: 'many meta', meta });
  ok('meta keys capped', Object.keys(capped.meta).length <= 8, String(Object.keys(capped.meta).length));

  activity.clear(alice.id);
  eq('clear empties the feed', activity.list(alice.id).total, 0);
}

section('activity: bot lifecycle bridge');
{
  activity.ensureAttached();
  activity.ensureAttached(); // must be idempotent
  events.bus.emit('bot', { botId: botA.id, type: 'crashed', detail: 'exit code 1' });
  const r = activity.list(alice.id);
  eq('bot event recorded for the owner', r.total, 1);
  eq('friendly title used', r.items[0].title, 'Bot crashed');
  eq('event type recorded', r.items[0].type, 'bot');
  eq('bot id attached', r.items[0].botId, botA.id);
  eq('bot name kept in meta', r.items[0].meta.bot, 'Alpha Bot');
  eq('detail preserved', r.items[0].detail, 'exit code 1');
  eq('other owners unaffected', activity.list(bob.id).total, 0);

  events.bus.emit('bot', { botId: 'b_missing', type: 'started' });
  eq('deleted bot does not throw or log', activity.list(alice.id).total, 1);
}

/* ---------------------------------------------------------------- site search */
section('site-search: relevance');
{
  ok('exact match scores highest', siteSearch.score('storage', 'storage') === 100);
  ok('prefix beats substring', siteSearch.score('storage drive', 'stor') > siteSearch.score('my storage', 'stor'));
  ok('word prefix recognised', siteSearch.score('my storage', 'stor') === 60);
  ok('substring inside a word is weakest', siteSearch.score('restorage', 'stor') === 30);
  ok('no match is zero', siteSearch.score('abc', 'zzz') === 0);
  ok('empty needle is zero', siteSearch.score('abc', '') === 0);
  ok('matching is case-insensitive', siteSearch.score('Alpha Bot', 'ALPHA') === 80);
}

section('site-search: results are scoped and typed');
{
  const r = siteSearch.search(alice, 'alpha');
  ok('finds the bot', r.results.some((x) => x.kind === 'bot' && x.id === 'b_alpha'), JSON.stringify(r.results));
  ok('never leaks another user\'s bot', !r.results.some((x) => x.id === 'b_secret'));
  ok('bot result links to the console', r.results.find((x) => x.id === 'b_alpha').href.indexOf('#/web?bot=') === 0);
  ok('counts are reported', r.counts.bot >= 1);

  const empty = siteSearch.search(alice, '   ');
  eq('blank query returns nothing', empty.results.length, 0);
  eq('blank query has empty counts', empty.counts, { bot: 0, file: 0, activity: 0 });

  const long = siteSearch.search(alice, 'a'.repeat(200));
  ok('over-long query is clamped', long.query.length <= 60);
}

section('site-search: drive files');
{
  const base = storage.resolveIn(alice.id, '').base;
  fs.mkdirSync(path.join(base, 'invoices'), { recursive: true });
  fs.writeFileSync(path.join(base, 'invoices', 'march-invoice.pdf'), 'x');
  fs.writeFileSync(path.join(base, '.hidden-invoice.pdf'), 'x');

  const r = siteSearch.search(alice, 'invoice');
  const files = r.results.filter((x) => x.kind === 'file');
  ok('finds the file', files.some((f) => f.title === 'march-invoice.pdf'), JSON.stringify(files));
  ok('finds the folder too', files.some((f) => f.title === 'invoices' && /folder/.test(f.sub)));
  ok('dotfiles are skipped', !files.some((f) => f.title === '.hidden-invoice.pdf'));
  ok('file result links to storage', files[0].href.indexOf('#/storage') === 0);
}

section('site-search: activity');
{
  activity.log(alice.id, { type: 'billing', title: 'Payment approved for coins', detail: 'Activated 100 coins.' });
  const r = siteSearch.search(alice, 'payment approved');
  ok('finds the activity entry', r.results.some((x) => x.kind === 'activity'), JSON.stringify(r.results));
  const hit = r.results.find((x) => x.kind === 'activity');
  ok('activity result links to the timeline', hit.href.indexOf('#/activity') === 0);
}

section('site-search: ordering and limits');
{
  activity.clear(alice.id);
  for (let i = 0; i < 40; i++) activity.log(alice.id, { title: 'Bulk event ' + i, detail: 'needle ' + i });
  const r = siteSearch.search(alice, 'needle');
  ok('results capped at 24', r.results.length <= 24, String(r.results.length));
  const scores = r.results.map((x) => x.score);
  ok('results sorted by score', scores.every((s, i) => i === 0 || scores[i - 1] >= s), JSON.stringify(scores));
  ok('every result has a usable link', r.results.every((x) => typeof x.href === 'string' && x.href.length > 1));
}

/* ---------------------------------------------------------------- summary */
console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
