/**
 * Unit tests for the platform-side report inbox.
 *
 * `.bug`, `.feature` and `.feedback` are sent by the bot over IPC as
 * `{type:'wa', event:'report'}`. lib/bots.js hands that to lib/wa-book.js, which keeps a
 * capped, per-bot list, and to lib/activity.js so the owner sees it in the console feed.
 * These tests cover the store half: ids, kinds, caps, filtering, clearing and the
 * "same report arriving twice" case a bot restart can produce.
 *
 * Run: node test/report-inbox.test.js
 * A throwaway DATA_DIR is used. Nothing here touches the network or a real bot.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-report-test-'));

const book = require('../lib/wa-book');
const activity = require('../lib/activity');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m\u2713\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m\u2717\x1b[0m ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
function section(t) { console.log('\n' + t); }

const BOT = 'reportbot01';
const OTHER = 'reportbot02';
const SENDER = '263771000009@s.whatsapp.net';
const GROUP = '120363000000000009@g.us';

section('a report is stored with its context');
const bug = book.addReport(BOT, {
  kind: 'bug',
  text: '  .sticker   fails on big videos ',
  reportId: 'BUG-1A2B',
  jid: GROUP,
  sender: SENDER,
  name: 'Tendai',
  group: 'Testers',
});
ok('a row comes back', !!bug);
eq('the bot-supplied id is kept', bug.id, 'BUG-1A2B');
eq('the kind is kept', bug.kind, 'bug');
eq('the text is tidied', bug.text, '.sticker fails on big videos');
eq('the sender is kept', bug.sender, SENDER);
eq('the group is kept', bug.group, 'Testers');
eq('it starts unread', bug.done, false);

section('kinds, ids and defaults');
const feat = book.addReport(BOT, { kind: 'feature', text: 'add reminders' });
ok('a missing id gets a REQ tag', /^REQ-[0-9A-F]{4}$/.test(feat.id), feat.id);
const fb = book.addReport(BOT, { kind: 'feedback', text: 'too slow at night' });
ok('feedback gets an FBK tag', /^FBK-[0-9A-F]{4}$/.test(fb.id), fb.id);
const odd = book.addReport(BOT, { kind: 'nonsense', text: 'x' });
eq('an unknown kind becomes a bug', odd.kind, 'bug');
ok('and a BUG id', /^BUG-/.test(odd.id), odd.id);
eq('an empty report is ignored', book.addReport(BOT, { kind: 'bug', text: '   ' }), null);
eq('a missing report is ignored', book.addReport(BOT, null), null);
eq('control characters are stripped', book.addReport(BOT, { kind: 'bug', text: 'a\u0000b' }).text, 'ab');
const long = book.addReport(BOT, { kind: 'bug', text: 'y'.repeat(4000) });
eq('long text is cut', long.text.length, 1200);

section('the same report arriving twice is not duplicated');
const before = book.reportsView(BOT).counts.total;
const again = book.addReport(BOT, { kind: 'bug', text: 'a different body', reportId: 'BUG-1A2B' });
eq('the stored row wins', again.text, '.sticker fails on big videos');
eq('nothing was added', book.reportsView(BOT).counts.total, before);

section('the inbox view');
const view = book.reportsView(BOT);
eq('newest first', view.reports[0].id, long.id);
eq('counts add up', view.counts.total, view.reports.length);
ok('there are bugs', view.counts.bug >= 1);
ok('there are features', view.counts.feature >= 1);
ok('there is feedback', view.counts.feedback >= 1);
eq('filtering by kind works', book.reportsView(BOT, 'feature').reports.every((r) => r.kind === 'feature'), true);
eq('an unknown filter falls back to bug', book.reportsView(BOT, 'nonsense').reports.every((r) => r.kind === 'bug'), true);
eq('no filter returns everything', book.reportsView(BOT, '').counts.total, view.counts.total);
eq('another bot has its own inbox', book.reportsView(OTHER).counts.total, 0);

section('marking one as handled');
const marked = book.markReport(BOT, 'BUG-1A2B', true);
eq('the flag flips', marked.done, true);
eq('an unknown id returns null', book.markReport(BOT, 'BUG-ZZZZ'), null);
eq('the change is persisted', book.reportsView(BOT).reports.find((r) => r.id === 'BUG-1A2B').done, true);

section('the list is capped');
for (let i = 0; i < 340; i += 1) book.addReport(BOT, { kind: 'bug', text: 'flood ' + i });
eq('the cap holds', book.reportsView(BOT).reports.length <= 100, true);
eq('the stored count is capped too', book.reportsView(BOT).counts.total, book.MAX_REPORTS);
eq('the newest survived', book.reportsView(BOT).reports[0].text, 'flood 339');

section('clearing');
book.addReport(BOT, { kind: 'feature', text: 'keep me' });
const removed = book.clearReports(BOT, 'bug').removed;
ok('clearing bugs removes rows', removed > 0);
eq('no bugs left', book.reportsView(BOT).counts.bug, 0);
ok('the feature survived', book.reportsView(BOT).counts.feature >= 1);
eq('clearing everything empties the inbox', book.clearReports(BOT).removed > 0, true);
eq('the inbox is empty', book.reportsView(BOT).counts.total, 0);
eq('clearing an empty inbox is harmless', book.clearReports(BOT).removed, 0);

section('the owner sees a report in the activity feed');
const entry = activity.log('user-report-1', {
  type: 'bot',
  title: 'Bug report BUG-1A2B',
  detail: 'Tendai in Testers: .sticker fails on big videos',
  botId: BOT,
  meta: { reportId: 'BUG-1A2B', kind: 'bug' },
});
ok('an activity row is written', !!entry && !!entry.id);
eq('it is a bot event', entry.type, 'bot');
eq('it is tied to the bot', entry.botId, BOT);
eq('the report id is in the meta', entry.meta.reportId, 'BUG-1A2B');
const feed = activity.list('user-report-1', { type: 'bot' });
eq('it shows up in the feed', feed.items[0].title, 'Bug report BUG-1A2B');
ok('searching finds it', activity.list('user-report-1', { q: 'sticker' }).items.length >= 1);

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
