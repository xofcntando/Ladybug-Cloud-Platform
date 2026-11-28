/**
 * AI auto-respond: per-bot settings validation (lib/wa-book.js) and reply generation
 * (lib/wa-ai.js) against a local HTTP stub provider. No real network, no real key.
 * Run: node test/ai-autorespond.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-aiauto-'));

const ai = require('../lib/wa-ai');
const book = require('../lib/wa-book');

(async () => {
  let pass = 0, fail = 0;
  const ok = (n, c, x) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (x ? ' -> ' + x : '')); } };

  console.log('\nsettings');
  const c = book.cleanAiReply({ enabled: true, instructions: ' Open 8-5 \u0000', cooldownSec: 9999, maxPerHour: 0 });
  ok('enabled only when exactly true', c.enabled === true && book.cleanAiReply({ enabled: 'yes' }).enabled === false);
  ok('control chars stripped and trimmed', c.instructions === 'Open 8-5');
  ok('cooldown clamped to 600', c.cooldownSec === 600);
  ok('maxPerHour clamped to at least 1', c.maxPerHour === 1);
  ok('null clears', book.cleanAiReply(null) === null);
  let threw = false; try { book.cleanAiReply('x'); } catch (e) { threw = true; }
  ok('rejects junk', threw);
  const long = book.cleanAiReply({ instructions: 'a'.repeat(5000) });
  ok('instructions capped at 1500', long.instructions.length === 1500);

  const saved = book.setAuto('bot1', { aiReply: { enabled: true, instructions: 'Delivery is $3' } });
  ok('setAuto stores aiReply', saved.saved.aiReply && saved.saved.aiReply.enabled === true);
  ok('autoFor returns aiReply for the bot env', book.autoFor('bot1').aiReply.instructions === 'Delivery is $3');
  book.setAuto('bot1', { aiReply: null });
  ok('aiReply:null removes it', book.autoFor('bot1').aiReply === undefined);

  console.log('\nreply generation (stub provider)');
  let reply = 'Delivery within the city is $3.';
  let lastBody = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      lastBody = JSON.parse(b);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: 'stub', choices: [{ message: { content: reply } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/v1';
  await ai.save('u1', { baseUrl: base, model: 'stub', apiKey: 'sk-test-12345678' });
  ok('isConfigured after save', ai.isConfigured('u1') && !ai.isConfigured('nobody'));

  const hist = [{ fromMe: false, text: 'How much is delivery?' }];
  const out = await ai.autoReply('u1', hist, 'Delivery is $3 in the city');
  ok('returns reply text', !out.handoff && out.text === reply);
  ok('owner instructions reach the model', lastBody.messages[0].content.includes('Delivery is $3 in the city'));
  ok('speaks as Ladybug', lastBody.messages[0].content.includes('You are Ladybug') && lastBody.messages[0].content.includes('Ntandomods'));
  const noInstr = await ai.autoReply('u1', hist, '');
  ok('works with no instructions', !noInstr.handoff && /chat naturally/.test(lastBody.messages[0].content));
  ok('conversation reaches the model', lastBody.messages[1].content.includes('Them: How much is delivery?'));

  reply = ai.HANDOFF_TOKEN;
  ok('handoff token becomes handoff', (await ai.autoReply('u1', hist, '')).handoff === true);
  reply = 'Sure! ' + ai.HANDOFF_TOKEN;
  ok('handoff token anywhere hands off', (await ai.autoReply('u1', hist, '')).handoff === true);
  reply = '"Me: Hello there"';
  ok('strips quotes and speaker label', (await ai.autoReply('u1', hist, '')).text === 'Hello there');
  reply = 'x'.repeat(2000);
  ok('reply capped at 600 chars', (await ai.autoReply('u1', hist, '')).text.length === 600);

  let e1 = null; try { await ai.autoReply('u1', [], ''); } catch (e) { e1 = e; }
  ok('empty history rejected', !!e1);
  let e2 = null; try { await ai.autoReply('nobody', hist, ''); } catch (e) { e2 = e; }
  ok('no provider -> 409', e2 && e2.status === 409);


  console.log('\nfirst-contact question');
  const J = '263771234567@s.whatsapp.net';
  ok('roles default', JSON.stringify(book.cleanAiReply({ enabled: true }).roles) === JSON.stringify(['student', 'business owner', 'customer', 'other']));
  ok('roles parsed from a string, deduped', JSON.stringify(book.cleanAiReply({ roles: 'Student, teacher,student , ' }).roles) === JSON.stringify(['Student', 'teacher']));
  ok('askWho defaults on, can be off', book.cleanAiReply({}).askWho === true && book.cleanAiReply({ askWho: false }).askWho === false);

  reply = 'Hi! Delivery is $3.';
  const asked = await ai.autoReply('u1', hist, '', { stage: 'ask', roles: ['student', 'teacher'] });
  ok('ask stage tells the model to ask', /ONE short, friendly question/.test(lastBody.messages[0].content) && /student, teacher/.test(lastBody.messages[0].content));
  ok('question appended when the model forgot it', /are you student or teacher\?$/.test(asked.text));
  reply = 'Hi! Are you a student or a teacher?';
  ok('question not duplicated when the model asked', (await ai.autoReply('u1', hist, '', { stage: 'ask', roles: ['student', 'teacher'] })).text === reply);

  reply = '```json\n{"reply":"Welcome, student! How can I help?","role":"Student","name":"Tino"}\n```';
  const got = await ai.autoReply('u1', hist, '', { stage: 'collect', roles: ['student', 'teacher'] });
  ok('collect extracts role and name', got.role === 'student' && got.name === 'Tino' && got.text === 'Welcome, student! How can I help?');
  reply = '{"reply":"Sure, delivery is $3.","role":null,"name":null}';
  const none = await ai.autoReply('u1', hist, '', { stage: 'collect' });
  ok('no answer -> role null, still replies', none.role === null && none.text === 'Sure, delivery is $3.');
  reply = 'Just plain text, no json';
  const plain = await ai.autoReply('u1', hist, '', { stage: 'collect' });
  ok('collect survives non-JSON output', plain.role === null && plain.text === 'Just plain text, no json');
  reply = 'Hello';
  await ai.autoReply('u1', hist, '', { role: 'student', name: 'Tino' });
  ok('known role is passed to the model', /they are: student/.test(lastBody.messages[0].content) && /Tino/.test(lastBody.messages[0].content));

  ok('no profile yet', book.aiPersonGet('bot2', J) === null);
  book.aiPersonSet('bot2', J, { status: 'asked', tries: 1 });
  ok('asked stored', book.aiPersonGet('bot2', J).status === 'asked');
  book.aiPersonSet('bot2', J, { status: 'known', role: ' Student<b> ', name: 'Tino' });
  const pv = book.aiPeopleView('bot2');
  ok('known stored and cleaned', pv.people[0].role === 'studentb' && pv.counts.studentb === 1 && pv.known === 1);
  ok('rejects group jids', book.aiPersonSet('bot2', '123@g.us', { status: 'asked' }) === null);
  book.aiPersonSet('bot2', '263770000000@s.whatsapp.net', { status: 'existing' });
  ok('existing chats are hidden from the list', book.aiPeopleView('bot2').people.length === 1);
  book.aiPeopleClear('bot2');
  ok('clear forgets everyone', book.aiPersonGet('bot2', J) === null);

  console.log('\nbot -> platform flow (ask, collect, remember)');
  const bots = require('../lib/bots');
  book.setAuto('bot3', { aiReply: { enabled: true } });
  const J2 = '263779999999@s.whatsapp.net';
  const ask = (history, jid) => new Promise((resolve) => {
    const proc = { connected: true, send: (m) => resolve(m) };
    bots._answerAiRequest({ botId: 'bot3' }, { userId: 'u1' }, proc, { id: 'r1', jid: jid || J2, history });
  });
  reply = 'Hey, I am Ladybug! Are you a student or a business owner?';
  let r1 = await ask([{ fromMe: false, text: 'hi' }]);
  ok('first message gets a reply with the question', r1.text && /\?/.test(r1.text));
  ok('chat is now marked as asked', book.aiPersonGet('bot3', J2).status === 'asked');
  reply = '{"reply":"Nice, a student! What do you need?","role":"student","name":null}';
  let r2 = await ask([{ fromMe: false, text: 'hi' }, { fromMe: true, text: 'q' }, { fromMe: false, text: "I'm a student" }]);
  ok('answer is collected and the reply goes out', r2.text === 'Nice, a student! What do you need?');
  ok('role remembered', book.aiPersonGet('bot3', J2).role === 'student' && book.aiPersonGet('bot3', J2).status === 'known');
  reply = 'Sure.';
  await ask([{ fromMe: false, text: 'price?' }]);
  ok('known person is not asked again', !/ONE short, friendly question/.test(lastBody.messages[0].content) && /they are: student/.test(lastBody.messages[0].content));
  const J3 = '263778888888@s.whatsapp.net';
  await ask([{ fromMe: true, text: 'Hello from the owner' }, { fromMe: false, text: 'hi' }], J3);
  ok('an ongoing conversation is never quizzed', book.aiPersonGet('bot3', J3).status === 'existing' && !/ONE short, friendly question/.test(lastBody.messages[0].content));
  const J4 = '263777777777@s.whatsapp.net';
  book.aiPersonSet('bot3', J4, { status: 'asked', tries: 1 });
  reply = '{"reply":"ok","role":null,"name":null}';
  await ask([{ fromMe: false, text: 'what?' }], J4);
  await ask([{ fromMe: false, text: 'what?' }], J4);
  ok('gives up after repeated non-answers', book.aiPersonGet('bot3', J4).status === 'skipped');
  book.setAuto('bot3', { aiReply: { enabled: true, askWho: false } });
  const J5 = '263776666666@s.whatsapp.net';
  reply = 'Hello';
  await ask([{ fromMe: false, text: 'hi' }], J5);
  ok('askWho off: never asks, stores nothing', book.aiPersonGet('bot3', J5) === null && !/ONE short, friendly question/.test(lastBody.messages[0].content));

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
