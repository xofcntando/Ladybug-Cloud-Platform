/**
 * Unit tests for the three new WhatsApp Web features:
 *   - lib/wa-digest.js   (local conversation summariser)
 *   - lib/wa-book.js     (notes + follow-ups)
 *
 * Run: node test/wa-features.test.js
 * Uses a throwaway DATA_DIR so the real data/db.json is never touched.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-test-'));

const digest = require('../lib/wa-digest');
const book = require('../lib/wa-book');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
function section(t) { console.log('\n' + t); }

const NOW = Math.floor(Date.now() / 1000); // the bridge stores seconds
const HOUR = 3600;
const jid = '2348012345678@s.whatsapp.net';

function msg(o) {
  return Object.assign({ id: 'm' + Math.random().toString(36).slice(2), ts: NOW - HOUR, fromMe: false, text: '' }, o);
}

/* ---------------------------------------------------------------- digest */
section('wa-digest: shape and totals');
{
  const messages = [
    msg({ text: 'Hello there, how are you doing today?', ts: NOW - 5 * HOUR }),
    msg({ text: 'Can you please send the invoice by Friday?', ts: NOW - 4 * HOUR }),
    msg({ text: 'Sure, I will send it tomorrow morning.', fromMe: true, ts: NOW - 3 * HOUR }),
    msg({ text: 'We agreed on the 30% discount, confirmed.', ts: NOW - 2 * HOUR }),
    msg({ text: 'Here is the link https://example.com/invoice/42', ts: NOW - HOUR }),
    msg({ text: '', type: 'image', ts: NOW - HOUR / 2 }),
  ];
  const r = digest.summarize(messages, { days: 7 });
  ok('returns ok flag', r.ok === true);
  eq('counts messages', r.totals.messages, 6);
  eq('counts incoming', r.totals.incoming, 5);
  eq('counts outgoing', r.totals.outgoing, 1);
  eq('counts media', r.totals.media, 1);
  ok('span days honoured', r.span.days === 7);
  ok('summary is non-empty prose', Array.isArray(r.summary) && r.summary.length > 0, JSON.stringify(r.summary));
  ok('keywords found', r.keywords.length > 0);
  ok('link captured', r.links.length === 1 && r.links[0].url === 'https://example.com/invoice/42', JSON.stringify(r.links));
  ok('request detected', r.requests.length >= 1, JSON.stringify(r.requests.map((x) => x.text)));
  ok('decision detected', r.decisions.length >= 1, JSON.stringify(r.decisions.map((x) => x.text)));
  ok('questions were found and then closed out', r.questions.length === 0 && r.answeredQuestions === 2, 'open=' + r.questions.length + ' answered=' + r.answeredQuestions);
  ok('activity buckets exist', r.activity.hours.length === 24 && r.activity.weekdays.length === 7);
  ok('per-day series present', r.activity.perDay.length >= 1);
  ok('busiest hour is a number', Number.isInteger(r.activity.busiestHour));
}

section('wa-digest: window filtering');
{
  const old = msg({ text: 'ancient message about nothing', ts: NOW - 40 * 24 * HOUR });
  const fresh = msg({ text: 'recent message about the project', ts: NOW - HOUR });
  const r = digest.summarize([old, fresh], { days: 7 });
  eq('old messages excluded', r.totals.messages, 1);
}

section('wa-digest: millisecond timestamps are tolerated');
{
  const msgs = [msg({ text: 'hello from a millisecond archive', ts: Date.now() - 3600_000 })];
  const r = digest.summarize(msgs, { days: 7 });
  eq('ms ts counted', r.totals.messages, 1);
  ok('ms ts normalised to seconds', r.span.firstTs < 1e11, String(r.span.firstTs));
  ok('ms ts hour bucket sane', r.activity.hours.reduce((a, b) => a + b, 0) === 1);
}

section('wa-digest: empty + junk input');
{
  const r = digest.summarize([], { days: 7 });
  ok('empty list still returns ok', r.ok === true);
  eq('empty totals', r.totals.messages, 0);
  ok('empty summary explains nothing to report', r.summary.length > 0);
  const r2 = digest.summarize(null, { days: 7 });
  ok('null input tolerated', r2.ok === true && r2.totals.messages === 0);
  const r3 = digest.summarize([{ ts: NOW, text: 'x'.repeat(5000) }], { days: 1 });
  ok('huge text does not blow up', r3.ok === true);
}

section('wa-digest: people + deleted');
{
  const messages = [
    msg({ text: 'hi', senderName: 'Ada', sender: '111' }),
    msg({ text: 'hello', senderName: 'Ada', sender: '111' }),
    msg({ text: 'yo', senderName: 'Bob', sender: '222' }),
    msg({ text: 'gone', deleted: true }),
  ];
  const r = digest.summarize(messages, { days: 7 });
  eq('deleted counted', r.totals.deleted, 1);
  ok('two distinct people', r.people.length === 2, JSON.stringify(r.people));
  ok('Ada is most active', r.people[0].name === 'Ada' && r.people[0].total === 2, JSON.stringify(r.people[0]));
}

/* ------------------------------------------------------- notes & follow-ups */
section('wa-book: notes');
{
  const v0 = book.notesView('bot1');
  eq('starts empty', [v0.notes.length, v0.followups.length], [0, 0]);
  ok('limits exposed', v0.maxNote === 2000 && v0.maxFollowups === 200);

  const saved = book.saveNote('bot1', { jid, text: 'Prefers voice notes.\nCall after 6pm.', chatName: 'Ada' });
  ok('note saved', saved.ok && saved.note.text.includes('voice notes'));
  ok('chat name stored', saved.note.chatName === 'Ada');

  const v1 = book.notesView('bot1');
  eq('one note listed', v1.notes.length, 1);
  eq('note jid', v1.notes[0].jid, jid);

  book.saveNote('bot1', { jid, text: 'Updated note' });
  eq('note overwritten not duplicated', book.notesView('bot1').notes.length, 1);
  eq('note text updated', book.notesView('bot1').notes[0].text, 'Updated note');

  let threw = false;
  try { book.saveNote('bot1', { jid: 'not-a-jid', text: 'x' }); } catch (e) { threw = e.status === 400; }
  ok('bad jid rejected', threw);

  const del = book.saveNote('bot1', { jid, text: '   ' });
  ok('blank text deletes note', del.deleted === true && book.notesView('bot1').notes.length === 0);

  book.saveNote('bot1', { jid, text: 'again' });
  book.deleteNote('bot1', jid);
  eq('deleteNote removes it', book.notesView('bot1').notes.length, 0);
  threw = false;
  try { book.deleteNote('bot1', jid); } catch (e) { threw = e.status === 404; }
  ok('deleting missing note 404s', threw);

  const long = book.saveNote('bot1', { jid, text: 'a'.repeat(5000) });
  ok('note text truncated to 2000', long.note.text.length === 2000);
  book.deleteNote('bot1', jid);
}

section('wa-book: follow-ups');
{
  const due = Date.now() + 2 * HOUR;
  const r = book.addFollowup('bot1', { jid, text: 'Chase the invoice', dueAt: due, chatName: 'Ada' });
  ok('follow-up created', r.ok && /^fu_/.test(r.followup.id));
  eq('dueAt preserved', r.followup.dueAt, due);
  eq('not done yet', r.followup.done, false);

  let threw = false;
  try { book.addFollowup('bot1', { jid, text: '', dueAt: due }); } catch (e) { threw = e.status === 400; }
  ok('empty text rejected', threw);

  threw = false;
  try { book.addFollowup('bot1', { jid, text: 'x', dueAt: Date.now() - 5 * 86_400_000 }); } catch (e) { threw = e.status === 400; }
  ok('far-past date rejected', threw);

  threw = false;
  try { book.addFollowup('bot1', { jid, text: 'x', dueAt: Date.now() + 400 * 86_400_000 }); } catch (e) { threw = e.status === 400; }
  ok('more than a year ahead rejected', threw);

  threw = false;
  try { book.addFollowup('bot1', { jid, text: 'x', dueAt: 'tomorrow' }); } catch (e) { threw = e.status === 400; }
  ok('non-numeric date rejected', threw);

  const id = r.followup.id;
  const upd = book.updateFollowup('bot1', id, { done: true });
  ok('marked done', upd.followup.done === true && upd.followup.doneAt > 0);

  const view = book.notesView('bot1');
  eq('done follow-up not counted as due', view.due, 0);

  book.updateFollowup('bot1', id, { text: 'Chase the invoice again' });
  eq('text updated', book.notesView('bot1').followups.find((f) => f.id === id).text, 'Chase the invoice again');

  book.updateFollowup('bot1', id, { done: false });
  const reopened = book.notesView('bot1').followups.find((f) => f.id === id);
  ok('reopened clears doneAt', reopened.done === false && reopened.doneAt === null);

  // an overdue one should raise the due counter
  book.addFollowup('bot1', { jid, text: 'Overdue thing', dueAt: Date.now() - HOUR });
  eq('overdue counted', book.notesView('bot1').due, 1);

  book.deleteFollowup('bot1', id);
  ok('deleted', !book.notesView('bot1').followups.some((f) => f.id === id));
  threw = false;
  try { book.deleteFollowup('bot1', 'fu_nope'); } catch (e) { threw = e.status === 404; }
  ok('deleting missing follow-up 404s', threw);

  // cap enforcement
  const before = book.notesView('bot1').followups.filter((f) => !f.done).length;
  let capped = false;
  try {
    for (let i = before; i < 205; i++) book.addFollowup('bot1', { jid, text: 'f' + i, dueAt: Date.now() + HOUR });
  } catch (e) { capped = /up to 200/.test(e.message); }
  ok('open follow-up cap enforced', capped);
}

section('wa-book: bots are isolated');
{
  book.saveNote('bot2', { jid, text: 'other bot note' });
  eq('bot1 has no note', book.notesView('bot1').notes.length, 0);
  eq('bot2 has one note', book.notesView('bot2').notes.length, 1);
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
