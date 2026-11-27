/**
 * Unit tests for Ladybug Brain - the built-in, key-free auto-responder.
 *
 *   - lib/bot-shims/ladybug-brain.js  (the reasoning engine, pure logic)
 *   - lib/wa-book.js                  (brain settings + the "could not answer" gap log)
 *
 * Run: node test/ladybug-brain.test.js
 * A throwaway DATA_DIR is used. Nothing here touches the network or a real bot.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-brain-test-'));

const brain = require('../lib/bot-shims/ladybug-brain');
const book = require('../lib/wa-book');

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

/* A realistic owner profile: the kind of thing the console panel saves. */
const PROFILE = {
  name: 'Ladybug Studio',
  about: 'Ladybug Studio builds websites and WhatsApp bots for small businesses in Harare.',
  tone: 'friendly',
  currency: 'USD',
  location: '12 Samora Machel Ave, Harare',
  phone: '+263 77 123 4567',
  email: 'hello@ladybug.studio',
  website: 'https://ladybug.studio',
  payments: 'We accept EcoCash, PayNow and bank transfer.',
  delivery: 'We deliver anywhere in Harare within 2 working days.',
  refunds: 'Full refund within 14 days if we have not started the work.',
  escalateTo: 'Tendai',
  hours: { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00', tzOffsetMin: 0 },
  prices: [
    { item: 'Starter website', amount: '150', note: '3 pages' },
    { item: 'WhatsApp bot', amount: '80' },
  ],
  faqs: [
    { id: 'trial', q: 'Do you have a free trial?', a: 'Yes - every bot comes with a 7 day free trial.', keys: 'trial free' },
    { id: 'hosting', q: 'Where is my data hosted?', a: 'On your own server, never on ours.', keys: 'data hosting server' },
  ],
};

/* Monday 10:00 UTC - inside the 08:00-17:00 Mon-Fri window. */
const MON_10 = Date.UTC(2024, 0, 1, 10, 0);
const MON_18 = Date.UTC(2024, 0, 1, 18, 0);
const SAT_10 = Date.UTC(2024, 0, 6, 10, 0);

/* ------------------------------------------------------------------ text utils */
section('text utils');
{
  eq('norm lowercases and strips punctuation', brain.norm('Hello, WORLD!'), 'hello world');
  eq('norm expands contractions', brain.norm("what's the price?"), 'what is the price');
  eq('norm keeps digits and dots', brain.norm('call 077 123 4567'), 'call 077 123 4567');
  eq('stem handles plurals', brain.stem('prices'), 'price');
  eq('stem handles -ies', brain.stem('deliveries'), 'delivery');
  eq('stem leaves short words alone', brain.stem('is'), 'is');
  eq('stem leaves numbers alone', brain.stem('1234'), '1234');
  ok('tokens drop stop-words', !brain.tokens('how much is the price').includes('the'));
  ok('words keep stop-words', brain.words('hi there').includes('hi'));
  ok('words are stemmed', brain.words('prices').includes('price'));
}

/* ------------------------------------------------------------------ entities */
section('entity extraction');
{
  const e = brain.entities('mail me at Sales@Ladybug.Studio or see https://ladybug.studio/x');
  eq('email', e.email, 'Sales@Ladybug.Studio');
  eq('url', e.url, 'https://ladybug.studio/x');
  eq('money with a symbol', brain.entities('it costs $1,250.50').amount, '1250.50');
  eq('money with a suffix', brain.entities('about 300 usd').amount, '300');
  eq('order reference', brain.entities('my order number is AB-1234').order, 'AB-1234');
  eq('time', brain.entities('can we meet at 3pm').time, '3pm');
  eq('date', brain.entities('can we meet tomorrow').date, 'tomorrow');
  ok('phone needs enough digits', !!brain.entities('call +263 77 123 4567').phone);
  eq('an empty string yields no entities', Object.keys(brain.entities('')).length, 0);
}

/* ------------------------------------------------------------------ sentiment */
section('sentiment and urgency');
{
  eq('a plain question is neutral', brain.sentiment('what are your prices').mood, 'neutral');
  ok('an angry message is negative', brain.sentiment('this is terrible and I am angry').negative);
  ok('two negatives tip the mood', brain.sentiment('useless and broken').mood === 'upset');
  ok('stemmed negatives still count', brain.sentiment('I have been waiting and nobody replies').negative);
  ok('delayed is scored negative', brain.sentiment('the delivery was delayed').score >= 1);
  ok('praise reads happy', brain.sentiment('great work, thank you').mood === 'happy');
  ok('asap is urgent', brain.sentiment('I need this asap').urgent);
  ok('double bang is urgent', brain.sentiment('call me!!').urgent);
  ok('shouting is detected', brain.sentiment('THIS IS COMPLETELY UNACCEPTABLE').shouting);
  ok('a short shout is not shouting', !brain.sentiment('OK THEN').shouting);
  ok('shouting raises the score', brain.sentiment('THIS IS COMPLETELY UNACCEPTABLE').score >= 2);
}

/* ------------------------------------------------------------------ profile */
section('profile normalisation');
{
  const p = brain.normalizeProfile(PROFILE);
  eq('name survives', p.name, 'Ladybug Studio');
  eq('currency survives', p.currency, 'USD');
  eq('hours survive', p.hours.days, [1, 2, 3, 4, 5]);
  eq('two prices survive', p.prices.length, 2);
  eq('two faqs survive', p.faqs.length, 2);

  const junk = brain.normalizeProfile({
    name: '   ', tone: 'sarcastic', currency: '', hours: { open: '99:99', close: 'noon', tzOffsetMin: 99999 },
    prices: [{ item: 'ok', amount: '5' }, { item: '', amount: '5' }, { item: 'x', amount: '' }, null, 'nope'],
    faqs: [{ q: 'has a', a: 'answer' }, { q: 'no answer', a: '' }, { q: '', a: 'x' }, 42],
  });
  eq('a blank name becomes empty', junk.name, '');
  eq('an unknown tone falls back to friendly', junk.tone, 'friendly');
  eq('a blank currency falls back to USD', junk.currency, 'USD');
  eq('a bad open time falls back', junk.hours.open, '08:00');
  eq('a bad close time falls back', junk.hours.close, '17:00');
  eq('a wild timezone is clamped', junk.hours.tzOffsetMin, 840);
  eq('only complete price rows survive', junk.prices.length, 1);
  eq('only complete faq rows survive', junk.faqs.length, 1);
  eq('a missing faq id is generated', junk.faqs[0].id, 'f0');

  const big = brain.normalizeProfile({
    prices: Array.from({ length: 80 }, (_, i) => ({ item: 'i' + i, amount: '1' })),
    faqs: Array.from({ length: 120 }, (_, i) => ({ q: 'q' + i, a: 'a' + i })),
  });
  eq('prices are capped', big.prices.length, brain.MAX_PRICES);
  eq('faqs are capped', big.faqs.length, brain.MAX_FAQS);
  ok('normalising junk never throws', !!brain.normalizeProfile(null) && !!brain.normalizeProfile('nope'));
  ok('html is stripped from fields', !/<b>/.test(brain.normalizeProfile({ name: '<b>hi</b>' }).name));

  ok('an empty profile is not ready', !brain.ready(brain.normalizeProfile({})));
  ok('a name alone makes it ready', brain.ready(brain.normalizeProfile({ name: 'x' })));
  ok('a faq alone makes it ready', brain.ready(brain.normalizeProfile({ faqs: [{ q: 'q', a: 'a' }] })));
}

/* ------------------------------------------------------------------ hours */
section('opening hours');
{
  const h = brain.normalizeProfile(PROFILE).hours;
  ok('open on a Monday morning', brain.hoursState(h, MON_10).open);
  ok('closed on a Monday evening', !brain.hoursState(h, MON_18).open);
  eq('Monday evening points at Tuesday', brain.hoursState(h, MON_18).nextDay, 2);
  eq('Saturday points at Monday', brain.hoursState(h, SAT_10).nextDay, 1);
  eq('no hours means no state', brain.hoursState(null, MON_10), null);
  const shifted = Object.assign({}, h, { tzOffsetMin: 120 });
  eq('the timezone offset shifts local time', brain.hoursState(shifted, MON_10).hhmm, '12:00');
}

/* ------------------------------------------------------------------ retrieval */
section('retrieval');
{
  const index = brain.buildIndex(brain.normalizeProfile(PROFILE));
  const hit = brain.retrieve(index, 'where is my data hosted');
  ok('the hosting faq wins', hit.best && hit.best.kind === 'faq' && hit.best.ref.id === 'hosting', JSON.stringify(hit.best && hit.best.ref && hit.best.ref.id));
  ok('the score is meaningful', hit.score > 0.55, hit.score);
  const miss = brain.retrieve(index, 'zzzz qqqq');
  eq('nonsense finds nothing', miss.best, null);
}

/* ------------------------------------------------------------------ intents */
section('intents and answers');
{
  const t = (msg, now, session) => brain.think(PROFILE, msg, session || null, { now: now || MON_10, jid: 'x' });

  let r = t('hi');
  eq('a greeting is recognised', r.intent, 'greeting');
  ok('the greeting names the business', r.reply.includes('Ladybug Studio'), r.reply);
  ok('the greeting knows we are open', /open right now/.test(r.reply), r.reply);

  r = t('how much is a website');
  eq('pricing is recognised', r.intent, 'pricing');
  ok('pricing lists the price rows', /Starter website/.test(r.reply) && /USD 150/.test(r.reply), r.reply);
  ok('pricing mentions how to pay', /EcoCash/.test(r.reply), r.reply);

  r = t('are you open');
  eq('hours are recognised', r.intent, 'hours');
  ok('hours say we are open', /open now, until 17:00/.test(r.reply), r.reply);

  r = t('are you open', MON_18);
  ok('hours say we are closed in the evening', /closed right now/.test(r.reply), r.reply);
  ok('hours name the next day', /Tuesday/.test(r.reply), r.reply);

  // A named day must be answered for that day, not for today (MON_10 is a Monday).
  r = t('are you open on Saturday?');
  ok('a named closed day is answered for that day', /closed on Saturdays/.test(r.reply), r.reply);
  r = t('are you open on Tuesday?');
  ok('a named open day is answered for that day', /open on Tuesday/.test(r.reply), r.reply);
  r = t('are you open on Monday?');
  ok('the named day is marked as today', /Monday \(today\)/.test(r.reply), r.reply);
  r = t('what time do you close on sunday');
  ok('a named day works with other phrasings', /closed on Sundays/.test(r.reply), r.reply);

  r = t('where are you located');
  eq('location is recognised', r.intent, 'location');
  ok('location gives the address', /Samora Machel/.test(r.reply), r.reply);

  r = t('what is your phone number');
  eq('contact is recognised', r.intent, 'contact');
  ok('contact gives the number', /\+263 77 123 4567/.test(r.reply), r.reply);
  ok('contact does not escalate', !r.escalate);

  r = t('how do i pay');
  eq('payment is recognised', r.intent, 'payment');
  ok('payment lists the methods', /EcoCash/.test(r.reply), r.reply);

  r = t('do you deliver');
  eq('delivery is recognised', r.intent, 'delivery');
  ok('delivery quotes the policy', /2 working days/.test(r.reply), r.reply);

  r = t('what is your refund policy');
  eq('refunds are recognised', r.intent, 'refund');
  ok('refunds quote the policy', /14 days/.test(r.reply), r.reply);

  r = t('what can you do');
  eq('capabilities are recognised', r.intent, 'capabilities');
  ok('capabilities explain the limits', /bring in a human/.test(r.reply), r.reply);

  r = t('who are you');
  eq('identity is recognised', r.intent, 'who');
  ok('identity quotes the about line', /builds websites/.test(r.reply), r.reply);

  r = t('thanks so much');
  eq('thanks are recognised', r.intent, 'thanks');

  r = t('bye');
  eq('goodbye is recognised', r.intent, 'goodbye');
}

/* ------------------------------------------------------------------ reasoning */
section('reasoning: weighing evidence');
{
  const r = brain.think(PROFILE, 'do you have a free trial', null, { now: MON_10, jid: 'x' });
  ok('the exact FAQ beats the generic availability answer', /7 day free trial/.test(r.reply), r.reply + ' | intent=' + r.intent);
  const weigh = r.trace.find((s) => s.rule === 'weigh');
  ok('the weigh step is recorded', !!weigh, JSON.stringify(r.trace));
  ok('the weigh step records both confidences', weigh && typeof weigh.intent === 'number' && typeof weigh.kb === 'number');

  // A tiny profile (one FAQ, no other facts) must still match its own FAQ: the score scale
  // shrinks with the corpus, so the decision uses term coverage as well as the raw score.
  const only = brain.normalizeProfile({ name: 'Acme', faqs: [{ q: 'Do you offer refunds?', a: 'Yes, within 14 days.' }] });
  const tiny = brain.think(only, 'do you offer refunds', null, { now: MON_10, jid: 'x' });
  ok('an exact FAQ wins even in a one-faq profile', /14 days/.test(tiny.reply), tiny.reply + ' | intent=' + tiny.intent);

  const oneWord = brain.think(PROFILE, 'website', null, { now: MON_10, jid: 'x' });
  ok('a single shared word still answers from the profile', oneWord.reply.length > 0 && oneWord.action === 'answer', JSON.stringify(oneWord));
}

/* ------------------------------------------------------------------ escalation */
section('escalation policy');
{
  let r = brain.think(PROFILE, 'I want to speak to a human', null, { now: MON_10, jid: 'x' });
  ok('asking for a human escalates', r.escalate && r.action === 'escalate');
  ok('the hand-off names the person', /Tendai/.test(r.reply), r.reply);
  ok('the hand-off offers the phone', /\+263 77 123 4567/.test(r.reply), r.reply);

  r = brain.think(PROFILE, 'this is terrible, I am very angry', null, { now: MON_10, jid: 'x' });
  ok('an angry customer is escalated', r.escalate);
  ok('an angry customer gets an apology', /sorry/i.test(r.reply), r.reply);

  r = brain.think(PROFILE, 'I have a complaint about my order', null, { now: MON_10, jid: 'x' });
  ok('a complaint is escalated', r.escalate && r.intent === 'complaint');

  const quiet = brain.normalizeProfile(Object.assign({}, PROFILE, { escalateTo: '', phone: '' }));
  r = brain.think(quiet, 'I want to speak to a human', null, { now: MON_10, jid: 'x' });
  ok('with no contact details it still hands off to the team', /the team/.test(r.reply), r.reply);
}

/* ------------------------------------------------------------------ slots */
section('slot filling across turns');
{
  let r = brain.think(PROFILE, 'where is my order', null, { now: MON_10, jid: 'x' });
  eq('an order question asks for the reference', r.action, 'slot');
  ok('the follow-up question is the order prompt', /order or reference number/.test(r.reply), r.reply);

  r = brain.think(PROFILE, 'AB-1234', r.session, { now: MON_10, jid: 'x' });
  eq('the reference is accepted', r.action, 'answer');
  ok('the reference is echoed back', /AB-1234/.test(r.reply), r.reply);
  ok('a checked order escalates', r.escalate);

  r = brain.think(PROFILE, 'where is my order', null, { now: MON_10, jid: 'x' });
  const again = brain.think(PROFILE, 'I do not have it', r.session, { now: MON_10, jid: 'x' });
  eq('an unusable reply re-asks', again.action, 'slot');

  r = brain.think(PROFILE, 'my order number is XY-99881', null, { now: MON_10, jid: 'x' });
  eq('a reference inside the first message needs no follow-up', r.action, 'answer');
  ok('the inline reference is used', /XY-99881/.test(r.reply), r.reply);
}

/* ------------------------------------------------------------------ gaps */
section('honest gaps');
{
  const thin = brain.normalizeProfile({ name: 'Thin Co', about: 'We sell things.' });
  let r = brain.think(thin, 'do you deliver to Bulawayo', null, { now: MON_10, jid: 'x' });
  eq('a recognised question with no facts is a gap', r.action, 'gap');
  ok('the gap records the reason', r.gap && r.gap.reason === 'profile-missing-delivery', JSON.stringify(r.gap));
  ok('the gap records the question', r.gap && /Bulawayo/.test(r.gap.question));
  ok('the reply refuses to guess', /rather not guess/.test(r.reply), r.reply);

  r = brain.think(PROFILE, 'what is the airspeed velocity of an unladen swallow', null, { now: MON_10, jid: 'x' });
  eq('nonsense is unknown', r.intent, 'unknown');
  eq('nonsense is recorded as a gap', r.gap.reason, 'no-match');
  ok('the first miss does not escalate', !r.escalate);

  const second = brain.think(PROFILE, 'and the capital of Peru', r.session, { now: MON_10, jid: 'x' });
  ok('a second miss escalates', second.escalate);
  ok('a second miss says a human was flagged', /flagged this for a human/.test(second.reply), second.reply);
}

/* ------------------------------------------------------------------ ambiguity */
section('ambiguity');
{
  // A thin profile cannot answer either reading, so the engine asks instead of guessing.
  const thin = brain.normalizeProfile({ name: 'Thin Co' });
  const r = brain.think(thin, 'book hours', null, { now: MON_10, jid: 'x' });
  eq('two equally strong intents ask a question', r.action, 'clarify');
  ok('the clarification offers both readings', /booking/.test(r.reply) && /opening hours/.test(r.reply), r.reply);

  const full = brain.think(PROFILE, 'book hours', null, { now: MON_10, jid: 'x' });
  eq('when one reading can be answered, it is answered', full.action, 'answer');
}

/* ------------------------------------------------------------------ sessions */
section('sessions');
{
  const s = brain.newSession(MON_10);
  ok('a new session is fresh', brain.fresh(s, MON_10 + 1000));
  ok('a session expires after the TTL', !brain.fresh(s, MON_10 + brain.SESSION_TTL_MS + 1));
  ok('a missing session is not fresh', !brain.fresh(null, MON_10));

  const a = brain.think(PROFILE, 'hi', null, { now: MON_10, jid: 'x' });
  const b = brain.think(PROFILE, 'hi again', a.session, { now: MON_10 + 5000, jid: 'x' });
  eq('turns accumulate', b.session.turns, 2);
  ok('an expired session is replaced', brain.think(PROFILE, 'hi', a.session, { now: MON_10 + brain.SESSION_TTL_MS + 1, jid: 'x' }).session.turns === 1);
}

/* ------------------------------------------------------------------ misc */
section('edge cases and preview');
{
  const r = brain.think(PROFILE, '   ', null, { now: MON_10 });
  eq('an empty message is ignored', r.action, 'ignore');
  eq('an empty message has no reply', r.reply, '');

  const long = brain.think(PROFILE, 'hi ' + 'x'.repeat(3000), null, { now: MON_10 });
  ok('a huge message is trimmed', long.reply.length <= brain.MAX_REPLY);

  ok('every answer carries a trace', Array.isArray(long.trace) && long.trace.length > 0);
  ok('the trace explains the intent step', long.trace.some((s) => s.step === 'intent'));

  const p = brain.preview(PROFILE, 'how much is a website', { now: MON_10 });
  eq('preview answers like think', p.intent, 'pricing');
  eq('preview uses a throwaway session', p.session.turns, 1);

  const raw = brain.think({ name: 'Raw Co', about: 'We fix phones.' }, 'hi', null, { now: MON_10 });
  ok('a raw profile is normalised on the fly', /Raw Co/.test(raw.reply), raw.reply);
}

/* ------------------------------------------------------------------ wa-book */
section('wa-book: brain settings');
{
  const botId = 'brainbot';
  const clean = book.cleanBrain({ enabled: true, profile: PROFILE, escalateAfter: 9, cooldownSec: -5, maxPerHour: 999 });
  eq('enabled is kept', clean.enabled, true);
  eq('escalateAfter is clamped', clean.escalateAfter, 5);
  eq('cooldownSec is clamped', clean.cooldownSec, 0);
  eq('maxPerHour is clamped', clean.maxPerHour, 60);
  eq('the profile is normalised', clean.profile.name, 'Ladybug Studio');

  throws('turning the brain on without a profile is refused', () => book.cleanBrain({ enabled: true, profile: {} }));
  ok('turning it off without a profile is allowed', book.cleanBrain({ enabled: false, profile: {} }).enabled === false);
  eq('null removes the settings', book.cleanBrain(null), null);
  throws('a non-object is refused', () => book.cleanBrain('nope'));

  book.setAuto(botId, { brain: { enabled: true, profile: PROFILE } });
  const saved = book.autoFor(botId);
  ok('the brain is stored with the automation settings', saved.brain && saved.brain.enabled === true);
  eq('the stored profile survives', saved.brain.profile.name, 'Ladybug Studio');

  book.setAuto(botId, { brain: null });
  ok('the brain can be removed again', !book.autoFor(botId).brain);
}

section('wa-book: the gap log');
{
  const botId = 'gapbot';
  eq('a fresh bot has no gaps', book.gapsView(botId).gaps.length, 0);
  eq('the cap is exposed', book.gapsView(botId).max, 120);

  book.addGap(botId, { q: 'Do you deliver to Bulawayo?', intent: 'delivery', reason: 'profile-missing-delivery' });
  book.addGap(botId, { q: 'do you deliver to bulawayo?', intent: 'delivery', reason: 'profile-missing-delivery' });
  book.addGap(botId, { q: 'Can I pay in rand?', intent: 'payment', reason: 'profile-missing-payment' });

  const view = book.gapsView(botId);
  eq('duplicates are merged', view.gaps.length, 2);
  eq('the duplicate count rises', view.gaps.find((g) => /bulawayo/i.test(g.q)).count, 2);
  eq('the newest gap is first', view.gaps[0].q, 'Can I pay in rand?');

  book.addGap(botId, { q: '' });
  eq('an empty question is ignored', book.gapsView(botId).gaps.length, 2);

  for (let i = 0; i < 130; i++) book.addGap(botId, { q: 'question ' + i, intent: 'unknown', reason: 'no-match' });
  eq('the log is capped', book.gapsView(botId).gaps.length, 120);

  book.clearGaps(botId);
  eq('the log can be cleared', book.gapsView(botId).gaps.length, 0);
}

/* ------------------------------------------------------------------ summary */
console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
