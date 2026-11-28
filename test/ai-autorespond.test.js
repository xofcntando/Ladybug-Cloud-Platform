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

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
