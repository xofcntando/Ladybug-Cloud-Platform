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


  console.log('\nget-to-know-you (settings + storage)');
  const J = '263771234567@s.whatsapp.net';
  ok('roles default', JSON.stringify(book.cleanAiReply({ enabled: true }).roles) === JSON.stringify(['student', 'business owner', 'customer', 'other']));
  ok('roles parsed from a string, deduped', JSON.stringify(book.cleanAiReply({ roles: 'Student, teacher,student , ' }).roles) === JSON.stringify(['Student', 'teacher']));
  ok('askWho defaults on, can be off', book.cleanAiReply({}).askWho === true && book.cleanAiReply({ askWho: false }).askWho === false);
  ok('fields default to all four in order', JSON.stringify(book.cleanAiReply({}).fields) === JSON.stringify(['name', 'role', 'age', 'location']));
  ok('fields filtered and reordered', JSON.stringify(book.cleanAiReply({ fields: ['location', 'name', 'bogus'] }).fields) === JSON.stringify(['name', 'location']));
  ok('empty fields = ask nothing', book.cleanAiReply({ fields: [] }).fields.length === 0);

  ok('no profile yet', book.aiPersonGet('bot2', J) === null);
  book.aiPersonSet('bot2', J, { status: 'asked', asking: 'name', tried: { name: 1 } });
  ok('asked stored', book.aiPersonGet('bot2', J).asking === 'name');
  book.aiPersonSet('bot2', J, { name: ' Tino<b> ', age: 17.6, city: 'Harare', country: 'Zimbabwe', role: 'Student' });
  const pr = book.aiPersonGet('bot2', J);
  ok('values cleaned', pr.name === 'Tinob' && pr.age === 18 && pr.city === 'Harare' && pr.role === 'student');
  book.aiPersonSet('bot2', J, { age: 3 });
  ok('absurd age ignored', book.aiPersonGet('bot2', J).age === 18);
  ok('missing: all answered -> none', book.aiMissing(book.aiPersonGet('bot2', J), ['name', 'role', 'age', 'location']).length === 0);
  ok('missing: skips declined and twice-asked', JSON.stringify(book.aiMissing({ skipped: ['age'], tried: { name: 2 } }, ['name', 'role', 'age', 'location'])) === JSON.stringify(['role', 'location']));
  book.aiPersonSet('bot2', J, { status: 'known' });
  const pv = book.aiPeopleView('bot2');
  ok('view: counts, places, average age', pv.counts.student === 1 && pv.places.zimbabwe === 1 && pv.avgAge === 18 && pv.known === 1);
  ok('rejects group jids', book.aiPersonSet('bot2', '123@g.us', { status: 'asked' }) === null);
  book.aiPersonSet('bot2', '263770000000@s.whatsapp.net', { status: 'existing' });
  ok('existing chats are hidden from the list', book.aiPeopleView('bot2').people.length === 1);
  book.aiPeopleClear('bot2');
  ok('clear forgets everyone', book.aiPersonGet('bot2', J) === null);

  console.log('\nget-to-know-you (prompting)');
  reply = 'Hi! Ladybug here. What should I call you?';
  await ai.autoReply('u1', hist, '', { first: true, missing: ['name', 'role', 'age', 'location'], roles: ['student', 'teacher'] });
  const sys = lastBody.messages[0].content;
  ok('first contact: introduce + playful + one question', /introduce yourself as Ladybug/.test(sys) && /at most ONE/.test(sys) && /playful pun/.test(sys));
  ok('first contact lists what to learn in order', sys.indexOf('their name') < sys.indexOf('which best describes') && sys.indexOf('which best describes') < sys.indexOf('how old') && sys.indexOf('how old') < sys.indexOf('city or country'));
  ok('first contact is plain text, not JSON', !/Reply with ONLY a JSON/.test(lastBody.messages[1].content));
  ok('age is optional and playful', /guess my age/.test(sys) && /fine to skip/.test(sys));

  reply = '```json\n{"reply":"Nice to meet you Tino! How old are you? Guess mine: 5 spots old","name":"Tino","role":"Student","age":null,"city":"Harare","country":null,"declined":false,"asked":"age"}\n```';
  const got = await ai.autoReply('u1', hist, '', { missing: ['name', 'role', 'age', 'location'], expect: 'name', roles: ['student'] });
  ok('collect reads several facts at once', got.found.name === 'Tino' && got.found.role === 'Student' && got.found.city === 'Harare' && got.found.age === null && got.asked === 'age' && !got.declined);
  ok('collect asks for JSON', /Reply with ONLY a JSON/.test(lastBody.messages[1].content) && /You last asked about: name/.test(lastBody.messages[1].content));
  reply = '{"reply":"Haha fair, a mystery! Where are you chatting from?","name":null,"role":null,"age":"abc","city":null,"country":null,"declined":true,"asked":"location"}';
  const dec = await ai.autoReply('u1', hist, '', { missing: ['age', 'location'], expect: 'age' });
  ok('declined detected, junk age ignored', dec.declined === true && dec.found.age === null && dec.asked === 'location');
  reply = 'Just plain text, no json';
  const plain = await ai.autoReply('u1', hist, '', { missing: ['name'], expect: 'name' });
  ok('survives non-JSON output', plain.text === 'Just plain text, no json' && plain.asked === null && plain.found.name === undefined);
  reply = 'Hello';
  await ai.autoReply('u1', hist, '', { profile: { name: 'Tino', age: 16, role: 'student', city: 'Harare' }, missing: [] });
  const sys2 = lastBody.messages[0].content;
  ok('known profile reaches the model, no more questions', /name: Tino/.test(sys2) && /from: Harare/.test(sys2) && !/at most ONE/.test(sys2));
  ok('minor gets age-appropriate guard', /under 18/.test(sys2));

  console.log('\nbot -> platform flow');
  const bots = require('../lib/bots');
  book.setAuto('bot3', { aiReply: { enabled: true } });
  const J2 = '263779999999@s.whatsapp.net';
  const ask = (history, jid) => new Promise((resolve) => {
    const proc = { connected: true, send: (m) => resolve(m) };
    bots._answerAiRequest({ botId: 'bot3' }, { userId: 'u1' }, proc, { id: 'r1', jid: jid || J2, history });
  });
  reply = 'Hey, Ladybug here! What should I call you?';
  const r1 = await ask([{ fromMe: false, text: 'hi' }]);
  ok('first message: reply with a question', r1.text && /\?/.test(r1.text));
  let pp = book.aiPersonGet('bot3', J2);
  ok('chat marked as getting-to-know, asking name', pp.status === 'asked' && pp.asking === 'name' && pp.tried.name === 1);

  reply = '{"reply":"Tino, love it! Are you a student, business owner...?","name":"Tino","role":null,"age":null,"city":null,"country":null,"declined":false,"asked":"role"}';
  await ask([{ fromMe: false, text: 'hi' }, { fromMe: true, text: 'q' }, { fromMe: false, text: 'Tino' }]);
  pp = book.aiPersonGet('bot3', J2);
  ok('name saved, now asking role', pp.name === 'Tino' && pp.asking === 'role' && pp.status === 'asked');

  reply = '{"reply":"Student life! How old are you?","name":null,"role":"student","age":null,"city":null,"country":null,"declined":false,"asked":"age"}';
  await ask([{ fromMe: false, text: 'student' }]);
  reply = '{"reply":"Ha, mystery person! Which city are you in?","name":null,"role":null,"age":null,"city":null,"country":null,"declined":true,"asked":"location"}';
  await ask([{ fromMe: false, text: 'not telling' }]);
  pp = book.aiPersonGet('bot3', J2);
  ok('declined age is skipped for good', pp.skipped.includes('age') && pp.asking === 'location');
  reply = '{"reply":"Zim! Welcome. How can I help?","name":null,"role":null,"age":null,"city":"Harare","country":"Zimbabwe","declined":false,"asked":null}';
  await ask([{ fromMe: false, text: 'Harare, Zimbabwe' }]);
  pp = book.aiPersonGet('bot3', J2);
  ok('finished: profile complete and marked known', pp.status === 'known' && pp.city === 'Harare' && pp.country === 'Zimbabwe' && pp.role === 'student' && !pp.asking);
  reply = 'Sure.';
  await ask([{ fromMe: false, text: 'price?' }]);
  ok('finished: no more questions, profile used', !/at most ONE/.test(lastBody.messages[0].content) && /name: Tino/.test(lastBody.messages[0].content));

  const J3 = '263778888888@s.whatsapp.net';
  await ask([{ fromMe: true, text: 'Hello from the owner' }, { fromMe: false, text: 'hi' }], J3);
  ok('an ongoing conversation is never quizzed', book.aiPersonGet('bot3', J3).status === 'existing' && !/at most ONE/.test(lastBody.messages[0].content));

  const J4 = '263777777777@s.whatsapp.net';
  reply = 'Hi! What should I call you?';
  await ask([{ fromMe: false, text: 'hi' }], J4);
  reply = '{"reply":"Hmm, what is your name?","name":null,"role":null,"age":null,"city":null,"country":null,"declined":false,"asked":"name"}';
  await ask([{ fromMe: false, text: 'what is this' }], J4);
  ok('re-asks once', book.aiPersonGet('bot3', J4).tried.name === 2);
  reply = '{"reply":"Okay okay! Are you a student or...?","name":null,"role":null,"age":null,"city":null,"country":null,"declined":false,"asked":"name"}';
  await ask([{ fromMe: false, text: 'lol' }], J4);
  ok('never asks the same thing a third time', book.aiPersonGet('bot3', J4).asking === null && book.aiMissing(book.aiPersonGet('bot3', J4), ['name', 'role', 'age', 'location']).indexOf('name') === -1);

  book.setAuto('bot3', { aiReply: { enabled: true, fields: ['location'] } });
  const J6 = '263775555555@s.whatsapp.net';
  reply = 'Hi, where are you from?';
  await ask([{ fromMe: false, text: 'hi' }], J6);
  ok('only the chosen fields are asked', /city or country/.test(lastBody.messages[0].content) && !/their name/.test(lastBody.messages[0].content));

  book.setAuto('bot3', { aiReply: { enabled: true, askWho: false } });
  const J5 = '263776666666@s.whatsapp.net';
  reply = 'Hello';
  await ask([{ fromMe: false, text: 'hi' }], J5);
  ok('switched off: never asks, stores nothing', book.aiPersonGet('bot3', J5) === null && !/at most ONE/.test(lastBody.messages[0].content));

  console.log('\npersonas');
  const per = require('../lib/wa-personas');
  ok('at least five personas', per.PERSONAS.length >= 5 && per.PERSONAS.some((p) => p.id === 'girlfriend'));
  ok('ids are unique', new Set(per.PERSONAS.map((p) => p.id)).size === per.PERSONAS.length);
  ok('public list hides prompts', per.listPublic().every((p) => p.id && p.label && p.sample && p.voice === undefined && p.role === undefined));
  ok('unknown persona falls back to default', per.get('nope').id === 'ladybug');
  ok('settings: valid persona kept, junk reset', book.cleanAiReply({ persona: 'tutor' }).persona === 'tutor' && book.cleanAiReply({ persona: 'x' }).persona === 'ladybug');
  ok('settings: persona name cleaned', !/[<>]/.test(book.cleanAiReply({ personaName: ' Lady<b>  Bug ' }).personaName) && book.cleanAiReply({ personaName: 'x'.repeat(99) }).personaName.length === 30)
  for (const p of per.PERSONAS) {
    const sys = ai.buildSystem(p.id, { name: 'Ladybug' });
    ok(`${p.id}: has identity, voice and the core rules`, sys.includes(p.role) && sys.includes('never invent them') && sys.includes('sincerely asks whether you are real or an AI'));
  }
  ok('professional uses no emoji', /Do not use emoji/.test(ai.buildSystem('professional')));
  ok('custom name is used', /^You are Sparkle /.test(ai.buildSystem('bestie', { name: 'Sparkle' })));
  ok('girlfriend without confirmed adult: friendly only', /NOT confirmed they are an adult/.test(ai.buildSystem('girlfriend', { romance: false })) && !/ROMANTIC COMPANION MODE/.test(ai.buildSystem('girlfriend', { romance: false })));
  const rom = ai.buildSystem('girlfriend', { romance: true });
  ok('girlfriend adult mode: PG, honest, no pressure', /PG/.test(rom) && /AI companion/.test(rom) && /Never sexual or explicit/.test(rom) && /self-harm/.test(rom));
  ok('non-romantic personas never get romance text', !/ROMANTIC COMPANION MODE|NOT confirmed they are an adult/.test(ai.buildSystem('sales', { romance: true })));

  console.log('\npersona in the bot flow');
  book.setAuto('bot4', { aiReply: { enabled: true, persona: 'girlfriend', personaName: 'Ladi' } });
  const askP = (history, jid) => new Promise((resolve) => {
    const proc = { connected: true, send: (m) => resolve(m) };
    bots._answerAiRequest({ botId: 'bot4' }, { userId: 'u1' }, proc, { id: 'p1', jid, history });
  });
  const G = '263771111111@s.whatsapp.net';
  reply = 'Hey! Ladi here. What should I call you?';
  await askP([{ fromMe: false, text: 'hi' }], G);
  let sysG = lastBody.messages[0].content;
  ok('persona and custom name reach the model', /^You are Ladi /.test(sysG) && /girlfriend-style/.test(sysG));
  ok('romance is OFF on first contact (age unknown)', /NOT confirmed they are an adult/.test(sysG));
  ok('romantic persona does not ask student/business', !/which best describes them/.test(sysG));
  reply = '{"reply":"Tino, cute name! How old are you? You can skip.","name":"Tino","role":null,"age":null,"city":null,"country":null,"declined":false,"asked":"age"}';
  await askP([{ fromMe: false, text: 'Tino' }], G);
  reply = '{"reply":"Nice, thanks!","name":null,"role":null,"age":16,"city":null,"country":null,"declined":false,"asked":null}';
  await askP([{ fromMe: false, text: '16' }], G);
  reply = 'Hello';
  await askP([{ fromMe: false, text: 'hey babe' }], G);
  ok('under 18: stays friendly, never romantic', /NOT confirmed they are an adult/.test(lastBody.messages[0].content) && /under 18/.test(lastBody.messages[0].content));
  const G2 = '263772222222@s.whatsapp.net';
  book.aiPersonSet('bot4', G2, { status: 'known', name: 'Anna', age: 24 });
  await askP([{ fromMe: false, text: 'hi' }], G2);
  ok('confirmed adult: romantic mode on', /ROMANTIC COMPANION MODE/.test(lastBody.messages[0].content));
  const G3 = '263773333333@s.whatsapp.net';
  await askP([{ fromMe: true, text: 'owner here' }, { fromMe: false, text: 'hi' }], G3);
  ok('ongoing chat (age unknown): romance stays off', /NOT confirmed they are an adult/.test(lastBody.messages[0].content));
  book.setAuto('bot4', { aiReply: { enabled: true, persona: 'girlfriend', askWho: false } });
  const G4 = '263774444444@s.whatsapp.net';
  await askP([{ fromMe: false, text: 'hi' }], G4);
  ok('questions switched off: romance cannot turn on', /NOT confirmed they are an adult/.test(lastBody.messages[0].content));

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
