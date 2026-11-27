/**
 * Unit tests for two things the brain needs to behave in the real world:
 *
 *   1. Human takeover - pausing the bot in one chat when the owner replies, so the two of
 *      them never talk over each other. lib/wa-book.js owns the store; the bot enforces it.
 *   2. Media messages - a voice note or a photo with no caption is still a customer waiting
 *      for an answer, so the brain must say something instead of going silent.
 *
 * Run: node test/wa-takeover.test.js
 * A throwaway DATA_DIR is used. Nothing here touches the network or a real bot.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-takeover-test-'));

const book = require('../lib/wa-book');
const brain = require('../lib/bot-shims/ladybug-brain');

(async () => {
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m\u2713\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m\u2717\x1b[0m ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
function section(t) { console.log('\n' + t); }
function throws(name, fn) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(name, threw);
}

const BOT = 'takeoverbot01';
const A = '263771000001@s.whatsapp.net';
const B = '263771000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

const PROFILE = {
  name: 'Ladybug Studio',
  about: 'We build websites and WhatsApp bots in Harare.',
  tone: 'friendly',
  currency: 'USD',
  phone: '+263 77 123 4567',
  hours: { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00', tzOffsetMin: 120 },
  prices: [{ name: 'Starter website', amount: '150', note: '3 pages' }],
  faqs: [{ q: 'Do you have a free trial?', a: 'Yes - 7 days, no card needed.', tags: 'trial free' }],
};

/* ------------------------------------------------------------------ pause store */

section('pausing one chat');
{
  const r = book.pauseChat(BOT, A, { by: 'owner', reason: 'takeover' });
  eq('the pause is returned', r.jid, A);
  ok('the chat reads as paused', book.isPaused(BOT, A));
  ok('another chat is untouched', !book.isPaused(BOT, B));
  const v = book.pausedView(BOT);
  eq('one chat is listed', v.paused.length, 1);
  eq('with the reason kept', v.paused[0].reason, 'takeover');
  ok('and a time left', v.paused[0].leftMin > 0, 'leftMin ' + v.paused[0].leftMin);
}

section('resuming');
{
  const r = book.resumeChat(BOT, A);
  ok('resume reports the change', r.resumed);
  ok('the chat is no longer paused', !book.isPaused(BOT, A));
  eq('the list is empty', book.pausedView(BOT).paused.length, 0);
  ok('resuming again is a no-op', !book.resumeChat(BOT, A).resumed);
}

section('pausing everything');
{
  book.pauseChat(BOT, A, {});
  book.pauseChat(BOT, B, {});
  eq('two chats paused', book.pausedView(BOT).paused.length, 2);
  eq('resumeAll clears them', book.resumeAll(BOT).resumed, 2);
  eq('and the list is empty', book.pausedView(BOT).paused.length, 0);
}

section('pauses expire by themselves');
{
  // hours: 0 means "until I resume it" - no expiry.
  book.pauseChat(BOT, A, { hours: 0 });
  const v = book.pausedView(BOT);
  eq('a zero-hour pause has no expiry', v.paused[0].until, 0);
  eq('and says so', v.paused[0].leftMin, 0);
  ok('it still counts as paused', book.isPaused(BOT, A));
  book.resumeAll(BOT);

  // A one-hour pause, then move the clock past it.
  book.pauseChat(BOT, B, { hours: 1 });
  ok('a one-hour pause is live', book.isPaused(BOT, B));
  const raw = require('../lib/store').data.waBook[BOT].paused[B];
  raw.until = Date.now() - 1000;
  ok('an expired pause lifts itself', !book.isPaused(BOT, B));
  eq('and drops out of the list', book.pausedView(BOT).paused.length, 0);
}

section('pause input is validated');
{
  throws('a bad chat id is rejected', () => book.pauseChat(BOT, 'not-a-jid', {}));
  throws('an empty chat id is rejected', () => book.pauseChat(BOT, '', {}));
  throws('resume validates too', () => book.resumeChat(BOT, 'nope'));
  throws('a negative pause length is rejected', () => book.setPauseHours(BOT, -1));
  throws('an absurd pause length is rejected', () => book.setPauseHours(BOT, 100000));
  eq('the default length is 8 hours', book.pauseHoursFor(BOT), 8);
}

section('pause length is remembered');
{
  eq('setting 2 hours', book.setPauseHours(BOT, 2).hours, 2);
  eq('reads back', book.pauseHoursFor(BOT), 2);
  book.pauseChat(BOT, A, {});
  const left = book.pausedView(BOT).paused[0].leftMin;
  ok('a new pause uses the new length', left > 100 && left <= 120, 'leftMin ' + left);
  book.setPauseHours(BOT, 8);
  book.resumeAll(BOT);
}

section('pauses survive a restart');
{
  book.pauseChat(BOT, A, { hours: 4 });
  const auto = book.autoFor(BOT);
  ok('the paused map is part of the bot settings', !!auto.paused && !!auto.paused[A], JSON.stringify(auto.paused));
  eq('with the expiry as a timestamp', typeof auto.paused[A], 'number');
  eq('and the length travels too', auto.pauseHours, 8);
  book.resumeAll(BOT);
  const after = book.autoFor(BOT);
  ok('an empty map is left out entirely', after.paused === undefined, JSON.stringify(after.paused));
}

section('the store is capped');
{
  for (let i = 0; i < 320; i++) book.pauseChat(BOT, '263771' + String(100000 + i) + '@s.whatsapp.net', {});
  const n = book.pausedView(BOT).paused.length;
  ok('never more than the cap', n <= book.MAX_PAUSED, 'have ' + n);
  book.resumeAll(BOT);
}

section('groups can be paused too');
{
  book.pauseChat(BOT, GROUP, {});
  ok('a group id is accepted', book.isPaused(BOT, GROUP));
  book.resumeAll(BOT);
}


/* ------------------------------------------------------------------ learning from the owner */

section('the owner answering a customer teaches the brain');
{
  const row = book.addLearned(BOT, { q: 'do you install the bot on my own server', a: 'Yes - we install it on your Render account and hand over the keys.', jid: A });
  ok('the pair is stored', !!row && row.q.indexOf('install') !== -1);
  eq('with a hit count of one', row.hits, 1);
  eq('and a status of new', row.status, 'new');
  eq('the chat it came from is kept', row.jid, A);

  const again = book.addLearned(BOT, { q: 'Do you install the bot on my own server', a: 'Yes, and we hand over the keys.', jid: A });
  eq('asking the same thing again does not duplicate it', book.learnedView(BOT).learned.length, 1);
  eq('the hit count goes up instead', again.hits, 2);
  ok('and the latest answer wins', /hand over the keys/.test(again.a), again.a);

  const v = book.learnedView(BOT);
  ok('the list reports its cap', v.max > 0);
  eq('a pair the owner has not reviewed is handed to the brain', book.learnedFor(BOT).length, 1);
}

section('junk is not knowledge');
{
  const before = book.learnedView(BOT).learned.length;
  eq('a one-word question is refused', book.addLearned(BOT, { q: 'hi', a: 'Hello, how can I help you today?' }), null);
  eq('a one-word answer is refused', book.addLearned(BOT, { q: 'what time do you close today', a: 'ok' }), null);
  eq('nothing was added', book.learnedView(BOT).learned.length, before);
}

section('dismissing and promoting');
{
  const row = book.learnedView(BOT).learned[0];
  book.setLearnedStatus(BOT, row.id, 'dismissed');
  eq('a dismissed pair is no longer used by the brain', book.learnedFor(BOT).length, 0);
  ok('but it is still listed for the owner', book.learnedView(BOT).learned.some((r) => r.id === row.id));
  book.setLearnedStatus(BOT, row.id, 'new');
  eq('and it can come back', book.learnedFor(BOT).length, 1);

  book.setLearnedStatus(BOT, row.id, 'used');
  eq('a pair turned into a FAQ stops being learned knowledge', book.learnedFor(BOT).length, 0);

  throws('an unknown status is rejected', () => book.setLearnedStatus(BOT, row.id, 'banana'));
  throws('an unknown id is rejected', () => book.setLearnedStatus(BOT, 'nope', 'new'));
}

section('the brain gets the learned pairs, not the browser');
{
  book.addLearned(BOT, { q: 'do you offer a free trial', a: 'Yes - seven days, no card needed.' });
  book.setAuto(BOT, { brain: { enabled: true, profile: PROFILE } });
  const cfg = book.brainFor(BOT);
  ok('brainFor returns a brain config', !!cfg && !!cfg.profile);
  ok('with the learned pairs attached', Array.isArray(cfg.profile.learned));
  // The console sends whatever it last loaded; the store must still win.
  book.setAuto(BOT, { brain: { enabled: true, profile: Object.assign({}, PROFILE, { learned: [] }) } });
  const saved = book.autoFor(BOT).brain;
  ok('a stale save cannot wipe learned answers', Array.isArray(saved.profile.learned) && saved.profile.learned.length === 1, JSON.stringify(saved.profile.learned));
  ok('the brain config is a copy, not the stored object', book.brainFor(BOT) !== book.autoFor(BOT).brain);
}

section('clearing the learned list');
{
  book.clearLearned(BOT);
  eq('the list is empty', book.learnedView(BOT).learned.length, 0);
  eq('and the brain sees nothing', book.learnedFor(BOT).length, 0);
}

section('the bot only learns from real owner replies');
{
  // The pairing rules live in the bot's web bridge. They are exported so they can be tested
  // without a WhatsApp socket: LADYBUG_AUTO seeds the brain config at require time.
  process.env.LADYBUG_AUTO = JSON.stringify({ brain: { enabled: true, profile: { name: 'Acme' } } });
  const sent = [];
  process.send = (m) => sent.push(m);
  const wb = require('../lib/bot-shims/webBridge')._learning;

  wb.noteInbound(A, 'do you install the bot on my own server');
  wb.learnFromOwner(A, 'Yes - we install it and hand over the keys.');
  eq('a real question and a real answer are reported', sent.filter((m) => m.event === 'brain-learn').length, 1);
  const pair = sent.find((m) => m.event === 'brain-learn');
  eq('with the customer question', pair.q, 'do you install the bot on my own server');
  eq('and the owner answer', pair.a, 'Yes - we install it and hand over the keys.');
  eq('one answer consumes one question', wb.lastInbound.has(A), false);

  sent.length = 0;
  wb.learnFromOwner(A, 'Sure, no problem at all.');
  eq('an answer with no question before it is not learned', sent.length, 0);

  wb.noteInbound(B, 'what are your opening hours on saturday');
  wb.learnFromOwner(B, 'ok');
  eq('a one-word reply is not learned', sent.length, 0);

  wb.noteInbound(B, 'hi');
  wb.learnFromOwner(B, 'Hello! How can I help you today?');
  eq('a one-word question is not learned', sent.length, 0);

  wb.noteInbound(B, 'where are you based exactly');
  wb.learnFromOwner(B, 'We are at 12 Samora Machel Ave in Harare.');
  eq('a good pair after the noise is still learned', sent.length, 1);

  delete process.send;
}

/* ------------------------------------------------------------------ media replies */

section('a voice note gets an answer, not silence');
{
  const out = brain.mediaReply(PROFILE, 'voice');
  ok('there is a reply', !!out && !!out.text);
  ok('it says plainly that it cannot listen', /cannot listen/i.test(out.text), out.text);
  ok('it asks for text instead', /type/i.test(out.text), out.text);
  ok('it offers the phone number as a way out', out.text.includes('+263 77 123 4567'), out.text);
  eq('and it is tagged as media', out.intent, 'media:voice');
  ok('it does not escalate on its own', out.escalate === false);
  ok('the reply is short enough for WhatsApp', out.text.length < brain.MAX_REPLY);
}

section('push-to-talk and uploaded audio are both handled');
{
  ok('a voice note', !!brain.mediaReply(PROFILE, 'voice'));
  ok('an audio file', !!brain.mediaReply(PROFILE, 'audio'));
  ok('both are tagged the same way', brain.mediaReply(PROFILE, 'voice').intent === 'media:voice' && brain.mediaReply(PROFILE, 'audio').intent === 'media:voice');
}

section('photos, videos and documents');
{
  const img = brain.mediaReply(PROFILE, 'image');
  ok('a photo gets a reply', !!img && !!img.text);
  ok('it does not pretend to see the picture', /cannot read pictures/i.test(img.text), img.text);
  eq('tagged as an image', img.intent, 'media:image');

  const vid = brain.mediaReply(PROFILE, 'video');
  ok('a video gets a reply', !!vid && /cannot watch/i.test(vid.text), vid && vid.text);

  const doc = brain.mediaReply(PROFILE, 'document');
  ok('a document gets a reply', !!doc && /cannot open documents/i.test(doc.text), doc && doc.text);
}

section('things that are not questions stay quiet');
{
  eq('a sticker', brain.mediaReply(PROFILE, 'sticker'), null);
  eq('a location', brain.mediaReply(PROFILE, 'location'), null);
  eq('a poll', brain.mediaReply(PROFILE, 'poll'), null);
  eq('an unknown kind', brain.mediaReply(PROFILE, 'nonsense'), null);
  eq('no kind at all', brain.mediaReply(PROFILE, ''), null);
}

section('media replies work without a phone number');
{
  const bare = brain.mediaReply({ name: 'Shop' }, 'voice');
  ok('there is still a reply', !!bare && !!bare.text);
  ok('with no dangling "call us on"', !/call us on/i.test(bare.text), bare.text);
}

section('media replies survive a missing profile');
{
  const out = brain.mediaReply(null, 'voice');
  ok('a null profile still answers', !!out && !!out.text);
}

section('the media kinds the bot will act on');
{
  eq('the list', brain.MEDIA_KINDS, ['voice', 'audio', 'image', 'video', 'document']);
  ok('voice is in it', brain.MEDIA_KINDS.indexOf('voice') !== -1);
  ok('a sticker is not', brain.MEDIA_KINDS.indexOf('sticker') === -1);
}

/* ------------------------------------------------------------------ summary */

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
