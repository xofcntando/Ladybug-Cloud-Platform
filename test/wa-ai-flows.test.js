/**
 * Unit tests for the two advanced WhatsApp Web features:
 *   - lib/bot-shims/flow-engine.js  (multi-step chatbot flows, pure logic)
 *   - lib/wa-ai.js                  (bring-your-own-key AI assistant)
 *   - lib/wa-book.js                (flows are stored and validated with the automation settings)
 *
 * Run: node test/wa-ai-flows.test.js
 * A throwaway DATA_DIR is used, and the AI provider is a local HTTP stub, so no real
 * network call is made and no real key is needed.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-ai-test-'));

const flow = require('../lib/bot-shims/flow-engine');
const ai = require('../lib/wa-ai');
const book = require('../lib/wa-book');

(async () => {
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m\u2713\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m\u2717\x1b[0m ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
function section(t) { console.log('\n' + t); }

const jid = '2348012345678@s.whatsapp.net';
const menu = {
  id: 'abc123',
  name: 'Pricing menu',
  match: 'price',
  steps: [
    { text: 'What do you need?', options: [{ label: 'Prices', go: 1 }, { label: 'Support', go: 2 }] },
    { text: 'Plans start at $3/month.', options: [{ label: 'Back to menu', go: 0 }] },
    { text: 'A human will reply shortly.', options: [] },
  ],
};

/* ---------------------------------------------------------------- flow engine */
section('flow-engine: normalise');
{
  const list = flow.normalize([menu, null, { name: 'no steps' }, { name: 'no trigger', steps: [{ text: 'hi' }] }]);
  eq('drops flows without steps or a trigger', list.length, 1);
  eq('keeps the id', list[0].id, 'abc123');
  eq('keeps three steps', list[0].steps.length, 3);
  eq('option target survives', list[0].steps[0].options[0].go, 1);

  const clamped = flow.normalize([{ name: 'x', match: 'x', steps: [{ text: 'a', options: [{ label: 'go', go: 99 }] }] }]);
  eq('an out-of-range target becomes "end"', clamped[0].steps[0].options[0].go, 'end');

  const trimmed = flow.normalize([{ name: 'x'.repeat(200), match: 'm'.repeat(200), steps: [{ text: 't'.repeat(900) }] }]);
  ok('name is capped', trimmed[0].name.length <= 60, trimmed[0].name.length);
  ok('keyword is capped', trimmed[0].match.length <= 80, trimmed[0].match.length);
  ok('step text is capped', trimmed[0].steps[0].text.length <= 500, trimmed[0].steps[0].text.length);

  const empty = flow.normalize([{ name: 'x', match: 'x', steps: [{ text: '   ' }] }]);
  eq('a step with no text and no options is dropped', empty.length, 0);

  const dup = flow.normalize([{ name: 'a', match: 'Price', steps: [{ text: '1' }] }, { name: 'b', match: 'price', steps: [{ text: '2' }] }]);
  eq('duplicate keywords are dropped', dup.length, 1);

  const anyFlow = flow.normalize([{ name: 'welcome', any: true, steps: [{ text: 'hi' }] }]);
  eq('an "any message" flow needs no keyword', anyFlow.length, 1);

  eq('a non-array is safe', flow.normalize('nope'), []);
}

section('flow-engine: triggers');
{
  const flows = flow.normalize([menu, { name: 'welcome', any: true, steps: [{ text: 'hi' }] }]);
  eq('keyword inside a sentence matches', flow.pick(flows, 'what is the price?').id, 'abc123');
  eq('case does not matter', flow.pick(flows, 'PRICE').id, 'abc123');
  eq('unrelated text falls through to the any-flow', flow.pick(flows, 'hello').name, 'welcome');
  eq('empty text starts nothing', flow.pick(flows, '   '), null);

  const exact = flow.normalize([{ name: 'e', match: 'price', exact: true, steps: [{ text: 'x' }] }]);
  eq('exact trigger rejects a longer sentence', flow.pick(exact, 'what is the price?'), null);
  eq('exact trigger accepts the bare word', flow.pick(exact, 'price').name, 'e');

  const disabled = flow.normalize([{ name: 'off', match: 'price', enabled: false, steps: [{ text: 'x' }] }]);
  eq('a disabled flow never fires', flow.pick(disabled, 'price'), null);
}

section('flow-engine: rendering and stepping');
{
  const f = flow.normalize([menu])[0];
  const first = flow.render(f.steps[0]);
  ok('first message contains the question', first.includes('What do you need?'));
  ok('options are numbered', first.includes('1) Prices') && first.includes('2) Support'));

  const s = flow.start(f);
  eq('a session starts at step 0', s.step, 0);

  const byNumber = flow.advance(f, s, '1');
  eq('picking 1 moves to step 1', byNumber.session.step, 1);
  ok('the next step text is returned', byNumber.reply.includes('Plans start at $3/month.'));
  ok('the pick is marked as matched', byNumber.matched === true);

  const byLabel = flow.advance(f, s, 'support');
  ok('picking by label works too', byLabel.reply.includes('A human will reply shortly.'));
  ok('the last step has no options to render', !byLabel.reply.includes('1)'));

  const end = flow.advance(f, flow.start(f), '2');
  ok('a step with no options ends the session', end.session === null && end.matched === true);

  const back = flow.advance(f, { flowId: f.id, step: 1, at: Date.now() }, 'back to menu');
  eq('"Back to menu" loops to step 0', back.session.step, 0);

  const junk = flow.advance(f, s, 'something else');
  ok('an unrecognised reply does not advance', junk.matched === false && junk.session.step === 0);

  const stale = flow.advance(f, { flowId: f.id, step: 0, at: Date.now() - flow.SESSION_TTL_MS - 1000 }, '1');
  ok('a stale session is ignored', stale.session === null && stale.matched === false);
  ok('alive() agrees', flow.alive({ flowId: f.id, step: 0, at: Date.now() - flow.SESSION_TTL_MS - 1 }) === false);

  eq('render of nothing is empty', flow.render(null), '');
}

/* ---------------------------------------------------------------- wa-book storage */
section('wa-book: flows are stored with automation');
{
  const { saved } = book.setAuto('botF', { flows: [menu] });
  eq('one flow saved', saved.flows.length, 1);
  eq('it keeps its steps', saved.flows[0].steps.length, 3);
  eq('autoFor returns it', book.autoFor('botF').flows.length, 1);

  let threw = false;
  try { book.setAuto('botF', { flows: [{ name: 'x', steps: [{ text: 'hi' }] }] }); } catch (e) { threw = /keyword|any message/i.test(e.message); }
  ok('a flow without a trigger is refused', threw);

  threw = false;
  try { book.setAuto('botF', { flows: 'nope' }); } catch (e) { threw = /list/i.test(e.message); }
  ok('a non-list is refused', threw);

  const many = Array.from({ length: 25 }, (_, i) => ({ name: 'f' + i, match: 'k' + i, steps: [{ text: 'x' }] }));
  threw = false;
  try { book.setAuto('botF', { flows: many }); } catch (e) { threw = /At most 20/.test(e.message); }
  ok('the flow cap is enforced', threw);

  eq('other bots are unaffected', book.autoFor('botG').flows, undefined);
}

/* ---------------------------------------------------------------- AI helpers */
section('wa-ai: key handling and SSRF guards');
{
  ok('maskKey hides the middle', ai.maskKey('sk-abcdefghijklmnop').includes('\u2026'));
  ok('maskKey keeps the last four', ai.maskKey('sk-abcdefghijklmnop').endsWith('mnop'));
  eq('a short key is fully masked', ai.maskKey('short'), '****');
  eq('no key, no mask', ai.maskKey(''), '');

  ok('10.x is private', ai.privateIp('10.1.2.3'));
  ok('192.168.x is private', ai.privateIp('192.168.1.1'));
  ok('172.16-31 is private', ai.privateIp('172.20.0.1'));
  ok('169.254 metadata is private', ai.privateIp('169.254.169.254'));
  ok('127.0.0.1 is private', ai.privateIp('127.0.0.1'));
  ok('::1 is private', ai.privateIp('::1'));
  ok('a public address is allowed', !ai.privateIp('93.184.216.34'));
  ok('garbage is refused', ai.privateIp('not-an-ip'));

  const noCfg = ai.settings('nobody');
  eq('an unknown user has no provider', noCfg.configured, false);

  let threw = false;
  try { await ai.save('u1', { baseUrl: 'http://example.com/v1', model: 'm', apiKey: 'sk-1234567890' }); } catch (e) { threw = /https/.test(e.message); }
  ok('plain http to a remote host is refused', threw);

  threw = false;
  try { await ai.save('u1', { baseUrl: 'https://api.example.com/v1', model: '', apiKey: 'sk-1234567890' }); } catch (e) { threw = /model/i.test(e.message); }
  ok('a missing model is refused', threw);

  threw = false;
  try { await ai.save('u1', { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' }); } catch (e) { threw = /key/i.test(e.message); }
  ok('a missing key is refused', threw);

  threw = false;
  try { await ai.chat('nobody', [{ role: 'user', content: 'hi' }]); } catch (e) { threw = e.status === 409; }
  ok('chat without a configured provider answers 409', threw);
}

/* ---------------------------------------------------------------- AI against a local stub */
section('wa-ai: requests against a local provider');
{
  const seen = { chat: 0, audio: 0, auth: null, lastBody: null, lastAudioBytes: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      seen.auth = req.headers.authorization || null;
      if (req.url === '/v1/chat/completions') {
        seen.chat++;
        seen.lastBody = JSON.parse(buf.toString('utf8'));
        const sys = seen.lastBody.messages[0].content || '';
        let content = '1. Sure, that works for me.\n2. Can we do it tomorrow?\n3. Thanks, I will check and come back to you.';
        if (/Summarise/.test(sys) || /Summarise/.test(seen.lastBody.messages[1].content)) content = 'Summary: they agreed on the plan.\nOpen questions: none.\nPromises or deadlines: invoice by Friday.\nNext step: send the invoice.';
        if (/Rewrite/.test(seen.lastBody.messages[1].content)) content = 'Shorter version.';
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ model: 'stub-1', choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 20 } }));
      }
      if (req.url === '/v1/audio/transcriptions') {
        seen.audio++;
        seen.lastAudioBytes = buf.length;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ text: 'Hello, this is a transcribed voice note.' }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const saved = await ai.save('u2', { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stub-1', apiKey: 'sk-test-1234567890' });
  eq('the provider is configured', saved.configured, true);
  eq('the key is masked in the response', saved.keyMask.endsWith('7890'), true);
  ok('the raw key is never returned', !JSON.stringify(saved).includes('sk-test-1234567890'));

  const msgs = [
    { fromMe: false, senderName: 'Thabo', text: 'Can you send the invoice by Friday?' },
    { fromMe: true, text: 'Sure, I will send it tomorrow morning.' },
    { fromMe: false, senderName: 'Thabo', text: 'Thanks!' },
  ];

  const replies = await ai.suggestReplies('u2', msgs, 3);
  eq('three suggestions come back', replies.replies.length, 3);
  ok('numbering is stripped', !/^1\./.test(replies.replies[0]), replies.replies[0]);
  ok('the transcript is sent to the provider', seen.lastBody.messages[1].content.includes('Thabo: Can you send the invoice'));
  ok('the bearer token is sent', seen.auth === 'Bearer sk-test-1234567890');

  const sum = await ai.summarize('u2', msgs);
  ok('the summary has the requested shape', /Summary:/.test(sum.text) && /Next step:/.test(sum.text));

  const rw = await ai.rewrite('u2', 'Hey, I wanted to ask if you could maybe send it?', 'shorter');
  eq('rewrite returns the provider text', rw.text, 'Shorter version.');
  eq('the tone is echoed back', rw.tone, 'shorter');

  const tr = await ai.transcribe('u2', { data: Buffer.from('fake-ogg-audio').toString('base64'), mime: 'audio/ogg', name: 'voice.ogg' });
  ok('transcription returns text', /transcribed voice note/.test(tr.text));
  eq('the audio request reached the provider', seen.audio, 1);
  ok('the multipart body carries the audio', seen.lastAudioBytes > 20);

  let threw = false;
  try { await ai.transcribe('u2', { data: '' }); } catch (e) { threw = /No audio/.test(e.message); }
  ok('empty audio is refused', threw);

  threw = false;
  try { await ai.rewrite('u2', '   ', 'shorter'); } catch (e) { threw = /Write something/.test(e.message); }
  ok('an empty draft is refused', threw);

  // A provider that answers 401 must surface as a key problem, not a generic failure.
  const bad = http.createServer((req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'invalid api key' } })); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  await ai.save('u3', { baseUrl: `http://127.0.0.1:${bad.address().port}/v1`, model: 'm', apiKey: 'sk-bad-key-000000' });
  threw = false;
  try { await ai.chat('u3', [{ role: 'user', content: 'hi' }]); } catch (e) { threw = e.status === 401 && /rejected the API key/.test(e.message); }
  ok('a rejected key is reported clearly', threw);

  // Clearing removes the key and the feature goes back to "not configured".
  const cleared = await ai.save('u2', { clear: true });
  eq('clearing removes the provider', cleared.configured, false);
  threw = false;
  try { await ai.chat('u2', [{ role: 'user', content: 'hi' }]); } catch (e) { threw = e.status === 409; }
  ok('after clearing, chat answers 409 again', threw);

  await new Promise((r) => server.close(r));
  await new Promise((r) => bad.close(r));
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
