/**
 * Unit tests for the commands added in this pass:
 *
 *   .img       image generation with a provider chain (utils/imageGen.js)
 *   .bug       bug reports          (commands/general/report.js)
 *   .feature   feature requests     (same file)
 *   .feedback  general feedback     (same file)
 *   .help      per-command help     (commands/general/help.js)
 *   .id .poll .define .wiki .reports
 *
 * Nothing here touches the network: axios is stubbed through Module._load, and
 * the bot's own data folder is a throwaway temp directory.
 *
 * Run: node test/bot-commands.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-cmd-test-'));
process.env.BOT_DATA_DIR = DATA;

/* ------------------------------------------------------------------ axios stub */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

const calls = [];
let behaviour = () => ({ data: PNG, headers: { 'content-type': 'image/png' }, status: 200 });

const axiosStub = {
  create: () => axiosStub,
  get: async (url, opts) => {
    calls.push({ method: 'GET', url, opts });
    return behaviour(url, opts);
  },
  post: async (url, body, opts) => {
    calls.push({ method: 'POST', url, body, opts });
    return behaviour(url, opts);
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') return axiosStub;
  return origLoad.apply(this, arguments);
};

/* ------------------------------------------------------------------ helpers */
const imageGen = require('../bots/ladybug/utils/imageGen');
const reports = require('../bots/ladybug/utils/reports');

(async () => {
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32m\u2713\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m\u2717\x1b[0m ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}
function section(t) { console.log('\n' + t); }
function throws(name, fn, needle) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(name, !!err && (!needle || String(err.message).includes(needle)), err ? err.message : 'did not throw');
}
async function rejects(name, fn, needle) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(name, !!err && (!needle || String(err.message).includes(needle)), err ? err.message : 'did not throw');
}

/** Minimal sock/extra pair that records everything a command does. */
function harness(overrides = {}) {
  const sent = [];
  const replies = [];
  const reactions = [];
  const sock = {
    sendMessage: async (jid, payload, opts) => {
      sent.push({ jid, payload, opts });
      return { key: { id: 'sent' + sent.length } };
    },
  };
  const extra = {
    from: '263771000001@s.whatsapp.net',
    sender: '263771000001@s.whatsapp.net',
    isGroup: false,
    groupMetadata: null,
    pushName: 'Tester',
    isOwner: false,
    reply: async (text) => {
      replies.push(text);
      return { key: { id: 'reply' + replies.length } };
    },
    react: async (emoji) => { reactions.push(emoji); },
    ...overrides,
  };
  return { sock, extra, sent, replies, reactions };
}

const MSG = { key: { remoteJid: '263771000001@s.whatsapp.net', id: 'abc' }, message: { conversation: '.x' } };

/* ================================================================== imageGen */
section('image prompts are cleaned before they reach a provider');
eq('collapses whitespace', imageGen.cleanPrompt('  a   cat\n\non  a mat '), 'a cat on a mat');
eq('strips control characters', imageGen.cleanPrompt('a\u0000b\u001fc'), 'a b c');
eq('caps very long prompts', imageGen.cleanPrompt('x'.repeat(5000)).length, imageGen.MAX_PROMPT);
eq('null becomes empty', imageGen.cleanPrompt(null), '');

section('.img argument parsing');
eq('plain prompt', imageGen.parseArgs(['a', 'red', 'car']).prompt, 'a red car');
eq('default shape is square', imageGen.parseArgs(['cat']).size, 'square');
eq('--wide', imageGen.parseArgs(['cat', '--wide']).size, 'wide');
eq('--landscape alias', imageGen.parseArgs(['cat', '--landscape']).size, 'wide');
eq('--tall', imageGen.parseArgs(['cat', '--tall']).size, 'tall');
eq('--portrait alias', imageGen.parseArgs(['cat', '--portrait']).size, 'tall');
eq('--size=wide', imageGen.parseArgs(['cat', '--size=wide']).size, 'wide');
eq('--seed is read', imageGen.parseArgs(['cat', '--seed=42']).seed, 42);
eq('flag is not part of the prompt', imageGen.parseArgs(['cat', '--wide']).prompt, 'cat');
eq('unknown --flag stays in the prompt', imageGen.parseArgs(['a', '--neon', 'sign']).prompt, 'a --neon sign');
eq('empty args give an empty prompt', imageGen.parseArgs([]).prompt, '');

section('provider URLs are built correctly');
const poll = imageGen.pollinationsUrl('a red car', 'wide', 7);
ok('pollinations encodes the prompt', poll.includes(encodeURIComponent('a red car')));
ok('pollinations carries the width', poll.includes('width=1344'));
ok('pollinations carries the seed', poll.includes('seed=7'));
ok('pollinations hides the logo', poll.includes('nologo=true'));
const custom = imageGen.customUrl('https://example.com/img?prompt={prompt}&w={width}', 'a dog', 'tall');
ok('custom template fills prompt', custom.includes(encodeURIComponent('a dog')));
ok('custom template fills width', custom.includes('w=768'));
const plain = imageGen.customUrl('https://example.com/gen', 'a dog', 'square');
eq('plain URL gets a prompt query', new URL(plain).searchParams.get('prompt'), 'a dog');
eq('a rate-limit message gives the wait', imageGen.retryAfterMs('Free limit reached: 1 image every 45 seconds per IP. Retry after 38s, or get unlimited'), 38000);
eq('a Retry-After header is understood', imageGen.retryAfterMs('', { 'retry-after': '12' }), 12000);
eq('nonsense means no wait', imageGen.retryAfterMs('busy', {}), 0);
eq('a huge wait is capped', imageGen.retryAfterMs('retry after 900s'), 60000);

section('image bytes are validated, not trusted');
eq('detects PNG', imageGen.sniffImage(PNG), 'image/png');
eq('detects JPEG', imageGen.sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
eq('detects WEBP', imageGen.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])), 'image/webp');
eq('detects GIF', imageGen.sniffImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)])), 'image/gif');
eq('rejects HTML', imageGen.sniffImage(Buffer.from('<html><body>nope</body></html>')), false);
eq('rejects a short buffer', imageGen.sniffImage(Buffer.from('abc')), false);

section('the provider chain falls back instead of failing');
delete process.env.LADYBUG_IMG_URL;
delete process.env.LADYBUG_IMG_KEY;
process.env.LADYBUG_IMG_FREE = '1';
calls.length = 0;
behaviour = () => ({ data: PNG, headers: { 'content-type': 'image/png' }, status: 200 });
const free = await imageGen.generate('a ladybug');
eq('key-free provider is used', free.provider, 'pollinations');
ok('a real buffer comes back', free.buffer.length > 8);
eq('the mime is sniffed', free.mime, 'image/png');

process.env.LADYBUG_IMG_URL = 'https://api.example.com/images/generations';
process.env.LADYBUG_IMG_KEY = 'sk-test';
calls.length = 0;
behaviour = () => ({ data: { data: [{ b64_json: PNG.toString('base64') }] }, headers: { 'content-type': 'application/json' }, status: 200 });
const own = await imageGen.generate('a cat');
eq('the owner endpoint wins when configured', own.provider, 'your endpoint');
eq('it posts to the OpenAI-compatible path', calls[0].method, 'POST');
eq('the model is sent', calls[0].body.model, 'dall-e-3');
eq('the key is sent as a bearer token', calls[0].opts.headers.Authorization, 'Bearer sk-test');
eq('square maps to the OpenAI size', calls[0].body.size, '1024x1024');

calls.length = 0;
behaviour = (url) => {
  if (String(url).includes('api.example.com')) throw new Error('provider is down');
  return { data: PNG, headers: { 'content-type': 'image/png' }, status: 200 };
};
const fell = await imageGen.generate('a cat');
eq('a dead provider falls through to the next one', fell.provider, 'pollinations');

behaviour = () => { throw new Error('everything is down'); };
await rejects('all providers failing throws a clear error', () => imageGen.generate('a cat'), 'Every image service failed');

delete process.env.LADYBUG_IMG_URL;
process.env.LADYBUG_IMG_FREE = '0';
await rejects('free services can be switched off', () => imageGen.generate('a cat'), 'switched off');
process.env.LADYBUG_IMG_FREE = '1';

await rejects('an empty prompt is refused', () => imageGen.generate('   '), 'Tell me what to draw');

behaviour = () => ({ data: Buffer.from('<html>blocked</html>'), headers: { 'content-type': 'image/png' }, status: 200 });
await rejects('a non-image body is refused', () => imageGen.generate('a cat'), 'not an image');

/* ================================================================== reports */
section('reports are stored, capped and numbered');
fs.rmSync(path.join(DATA, 'reports.json'), { force: true });

const ipc = [];
const origSend = process.send;
process.send = (m) => { ipc.push(m); };

const one = reports.add({ kind: 'bug', text: '  .sticker   fails on big videos ', sender: '263771@s.whatsapp.net', name: 'Tendai' });
ok('a report gets an id', /^BUG-[0-9A-F]{4}$/.test(one.id), one.id);
eq('the text is tidied', one.text, '.sticker fails on big videos');
eq('it is saved to disk', one.saved, true);
eq('the platform is told', one.sent, true);
eq('the IPC event is a report', ipc[0].event, 'report');
eq('the IPC event carries the id', ipc[0].reportId, one.id);
eq('the IPC event carries the kind', ipc[0].kind, 'bug');

const two = reports.add({ kind: 'feature', text: 'add voice note transcription' });
ok('feature ids are tagged REQ', /^REQ-/.test(two.id), two.id);
const three = reports.add({ kind: 'feedback', text: 'replies are slow at night' });
ok('feedback ids are tagged FBK', /^FBK-/.test(three.id), three.id);

eq('newest first', reports.list({ limit: 3 })[0].id, three.id);
eq('filtering by kind works', reports.list({ kind: 'bug' }).length, 1);
eq('counts add up', reports.counts(), { bug: 1, feature: 1, feedback: 1, total: 3 });
eq('an unknown kind becomes a bug', reports.add({ kind: 'nonsense', text: 'x' }).kind, 'bug');
throws('an empty report is refused', () => reports.add({ kind: 'bug', text: '   ' }), 'needs some words');
eq('control characters are stripped', reports.add({ kind: 'bug', text: 'a\u0000b' }).text, 'a b');
eq('long text is cut', reports.add({ kind: 'bug', text: 'y'.repeat(4000) }).text.length, reports.MAX_TEXT);

for (let i = 0; i < 260; i += 1) reports.add({ kind: 'bug', text: 'spam ' + i });
eq('the store is capped', reports.read().length, reports.MAX_STORED);
// The cap evicts the oldest rows, so add a feature *after* the flood to prove
// that clearing bugs leaves the other kinds alone.
reports.add({ kind: 'feature', text: 'keep me' });
eq('clearing one kind removes rows', reports.clear('bug') > 0, true);
eq('only the requested kind was cleared', reports.counts().bug, 0);
ok('other kinds survived', reports.counts().feature >= 1);
reports.clear();
eq('clear with no argument empties everything', reports.read().length, 0);

/* ================================================================== commands */
section('the new command modules declare themselves properly');
// Point the loader at a tiny fake registry before help.js is required, so this
// test never needs the bot's full dependency tree (baileys, sharp, puppeteer...).
const loaderPath = require.resolve('../bots/ladybug/utils/commandLoader');
const realLoader = require.cache[loaderPath];
const fake = new Map();
fake.set('sticker', { name: 'sticker', aliases: ['s', 'stic'], category: 'general', description: 'Make a sticker', usage: '.sticker (reply to media)' });
fake.set('s', fake.get('sticker'));
fake.set('stic', fake.get('sticker'));
fake.set('ban', { name: 'ban', aliases: [], category: 'admin', description: 'Ban someone', usage: '.ban @user', adminOnly: true });
fake.set('menu', { name: 'menu', aliases: ['commands'], category: 'general', description: 'Show the menu', usage: '.menu', execute: async (s, m, a, e) => e.reply('MENU') });
require.cache[loaderPath] = { id: loaderPath, filename: loaderPath, loaded: true, exports: { loadCommands: () => fake } };

const imgCmd = require('../bots/ladybug/commands/ai/img');
const reportCmds = require('../bots/ladybug/commands/general/report');
const helpCmd = require('../bots/ladybug/commands/general/help');
const idCmd = require('../bots/ladybug/commands/general/id');
const pollCmd = require('../bots/ladybug/commands/general/poll');
const defineCmd = require('../bots/ladybug/commands/general/define');
const wikiCmd = require('../bots/ladybug/commands/general/wiki');
const reportsCmd = require('../bots/ladybug/commands/owner/reports');
const factCmd = require('../bots/ladybug/commands/ladybug/ladybugfact');

eq('.img is named img', imgCmd.name, 'img');
ok('.img answers to imagine', imgCmd.aliases.includes('imagine'));
ok('.img answers to draw', imgCmd.aliases.includes('draw'));
eq('.img is an ai command', imgCmd.category, 'ai');
ok('.img has a usage line', !!imgCmd.usage);

const byName = {};
for (const c of reportCmds) byName[c.name] = c;
ok('.bug exists', !!byName.bug);
ok('.feature exists', !!byName.feature);
ok('.feedback exists', !!byName.feedback);
ok('.bug answers to report', byName.bug.aliases.includes('report'));
ok('.feature answers to suggest', byName.feature.aliases.includes('suggest'));
eq('.bug is a general command', byName.bug.category, 'general');

eq('the old fact command was renamed', factCmd.name, 'ladybugfact');
ok('.bug is no longer the fact command', !factCmd.aliases.includes('bug'));
ok('the fact command still answers to fact', factCmd.aliases.includes('fact'));

eq('.reports is owner-only', reportsCmd.ownerOnly, true);
eq('.reports is in the owner category', reportsCmd.category, 'owner');
eq('.id is a general command', idCmd.category, 'general');
eq('.poll is a general command', pollCmd.category, 'general');
eq('.define is a general command', defineCmd.category, 'general');
eq('.wiki is a general command', wikiCmd.category, 'general');

section('.img replies with a picture');
process.env.LADYBUG_IMG_FREE = '1';
behaviour = () => ({ data: PNG, headers: { 'content-type': 'image/png' }, status: 200 });
let h = harness();
await imgCmd.execute(h.sock, MSG, ['a', 'ladybug', 'on', 'a', 'leaf'], h.extra);
eq('one image was sent', h.sent.filter((s) => s.payload.image).length, 1);
ok('the caption repeats the prompt', h.sent[0].payload.caption.includes('a ladybug on a leaf'));
ok('the caption is signed', h.sent[0].payload.caption.includes('Ladybug Mini'));
eq('the placeholder was cleaned up', h.sent.filter((s) => s.payload.delete).length, 1);
ok('the user got a reaction', h.reactions.includes('\u2705'));

h = harness();
await imgCmd.execute(h.sock, MSG, [], h.extra);
eq('no prompt means no image', h.sent.length, 0);
ok('no prompt shows usage', h.replies[0].includes('Describe the picture'));
ok('the usage box lists the shape flag', h.replies[0].includes('--wide'));

behaviour = () => { throw new Error('nope'); };
h = harness();
await imgCmd.execute(h.sock, MSG, ['cat'], h.extra);
eq('a failure sends no image', h.sent.filter((s) => s.payload.image).length, 0);
ok('the failure explains itself', h.replies.some((r) => /image failed/i.test(r)));
ok('the failure mentions the owner escape hatch', h.replies.some((r) => r.includes('LADYBUG_IMG_URL')));
ok('the failure reacts with a cross', h.reactions.includes('\u274c'));

section('.bug files a report and quotes a reference');
fs.rmSync(path.join(DATA, 'reports.json'), { force: true });
h = harness();
await byName.bug.execute(h.sock, MSG, ['.sticker', 'crashes', 'on', 'mp4'], h.extra);
eq('a report was stored', reports.read().length, 1);
ok('the reply quotes the reference', h.replies[0].includes(reports.read()[0].id));
ok('the reply says it reached the owner', h.replies[0].includes('delivered to the owner'));
eq('the stored kind is bug', reports.read()[0].kind, 'bug');
ok('the sender is recorded', reports.read()[0].sender.includes('263771'));
ok('the bug reaction is a ladybug', h.reactions.includes('\ud83d\udc1e'));

h = harness();
await byName.bug.execute(h.sock, MSG, [], h.extra);
eq('an empty .bug stores nothing', reports.read().length, 1);
ok('an empty .bug shows usage', h.replies[0].includes('what went wrong'));

h = harness();
await byName.feature.execute(h.sock, MSG, ['add', 'a', 'reminder', 'command'], h.extra);
eq('the feature kind is stored', reports.read()[0].kind, 'feature');
ok('the request reply is themed as a request', /feature request/i.test(h.replies[0]));

h = harness();
await byName.feedback.execute(h.sock, MSG, ['great', 'bot'], h.extra);
eq('the feedback kind is stored', reports.read()[0].kind, 'feedback');

section('.bug can quote the message being replied to');
const quotedMsg = {
  key: { remoteJid: '263771@s.whatsapp.net', id: 'q1' },
  message: {
    extendedTextMessage: {
      text: '.bug',
      contextInfo: { stanzaId: 'orig', participant: '263772@s.whatsapp.net', quotedMessage: { conversation: 'the menu never loads' } },
    },
  },
};
h = harness();
await byName.bug.execute(h.sock, quotedMsg, [], h.extra);
ok('the quoted text is included', reports.read()[0].text.includes('the menu never loads'));

section('.bug records the group name');
h = harness({ isGroup: true, groupMetadata: { subject: 'Harare Traders', participants: [] }, from: '120363000000000001@g.us' });
await byName.bug.execute(h.sock, MSG, ['welcome', 'message', 'is', 'blank'], h.extra);
eq('the group is recorded', reports.read()[0].group, 'Harare Traders');

section('.reports shows the inbox to the owner');
h = harness();
await reportsCmd.execute(h.sock, MSG, [], h.extra);
ok('the inbox lists a reference', /BUG-|REQ-|FBK-/.test(h.replies[0]));
ok('the inbox shows counts', h.replies[0].includes('Bugs'));
h = harness();
await reportsCmd.execute(h.sock, MSG, ['feature'], h.extra);
ok('filtering by feature works', h.replies[0].includes('FEATURE REPORTS'));
h = harness();
await reportsCmd.execute(h.sock, MSG, ['clear'], h.extra);
eq('clear empties the store', reports.read().length, 0);
ok('clear reports how many went', h.replies[0].includes('Cleared'));
h = harness();
await reportsCmd.execute(h.sock, MSG, [], h.extra);
ok('an empty inbox says so', h.replies[0].includes('Nothing here yet'));

section('.help explains one command');
h = harness();
await helpCmd.execute(h.sock, MSG, ['sticker'], h.extra);
ok('help shows the description', h.replies[0].includes('Make a sticker'));
ok('help shows the usage', h.replies[0].includes('.sticker (reply to media)'));
ok('help lists aliases', h.replies[0].includes('.s'));
ok('help says who can use it', h.replies[0].includes('everyone'));

h = harness();
await helpCmd.execute(h.sock, MSG, ['ban'], h.extra);
ok('admin commands are marked', h.replies[0].includes('group admins only'));

h = harness();
await helpCmd.execute(h.sock, MSG, ['stiker'], h.extra);
ok('a typo gets a suggestion', h.replies[0].includes('Did you mean'));
ok('the suggestion is the right command', h.replies[0].includes('.sticker'));

h = harness();
await helpCmd.execute(h.sock, MSG, [], h.extra);
eq('help with no argument falls back to the menu', h.replies[0], 'MENU');

if (realLoader) require.cache[loaderPath] = realLoader;
else delete require.cache[loaderPath];

section('.id prints the identifiers');
h = harness();
await idCmd.execute(h.sock, MSG, [], h.extra);
ok('shows the chat JID', h.replies[0].includes('263771000001@s.whatsapp.net'));
ok('shows the chat type', h.replies[0].includes('private chat'));
ok('shows the sender number', h.replies[0].includes('+263771000001'));
h = harness({ isGroup: true, groupMetadata: { subject: 'Testers', participants: [1, 2, 3] } });
await idCmd.execute(h.sock, MSG, [], h.extra);
ok('shows the group name', h.replies[0].includes('Testers'));
ok('shows the member count', h.replies[0].includes('*Members:* 3'));

section('.poll builds a native poll');
eq('parses question and options', pollCmd.parse('Where? | A | B').options, ['A', 'B']);
eq('trims each part', pollCmd.parse(' Where? |  A  | B ').question, 'Where?');
eq('drops empty parts', pollCmd.parse('Q | A |  | B').options, ['A', 'B']);
h = harness();
await pollCmd.execute(h.sock, MSG, ['Where?', '|', 'Harare', '|', 'Bulawayo'], h.extra);
eq('a poll message was sent', h.sent.length, 1);
eq('the poll question is right', h.sent[0].payload.poll.name, 'Where?');
eq('the options are right', h.sent[0].payload.poll.values, ['Harare', 'Bulawayo']);
eq('one choice per person', h.sent[0].payload.poll.selectableCount, 1);
h = harness();
await pollCmd.execute(h.sock, MSG, ['Just', 'a', 'question'], h.extra);
eq('a poll without options is refused', h.sent.length, 0);
ok('the refusal explains the format', h.replies[0].includes('|'));

section('.define and .wiki need a word');
h = harness();
await defineCmd.execute(h.sock, MSG, [], h.extra);
ok('.define with no word shows usage', h.replies[0].includes('Usage'));
h = harness();
await wikiCmd.execute(h.sock, MSG, [], h.extra);
ok('.wiki with no topic shows usage', h.replies[0].includes('Usage'));

section('.define formats a real dictionary payload');
behaviour = () => ({
  data: {
    en: [{
      partOfSpeech: 'Noun',
      definitions: [{
        definition: 'The <a href="/wiki/phenomenon">phenomenon</a> of events by chance in a happy way.',
        parsedExamples: [{ example: 'a fortunate stroke of serendipity' }],
      }],
    }],
  },
  headers: { 'content-type': 'application/json' },
  status: 200,
});
h = harness();
await defineCmd.execute(h.sock, MSG, ['serendipity'], h.extra);
ok('the word is the heading', h.replies[0].includes('SERENDIPITY'));
ok('the definition is shown', h.replies[0].includes('by chance in a happy way'));
ok('the part of speech is shown', h.replies[0].includes('Noun'));
ok('the example is shown', h.replies[0].includes('fortunate stroke'));
ok('HTML tags are stripped', !h.replies[0].includes('<a href'));
eq('entities are decoded', defineCmd.plain('a & b "c"'), 'a & b "c"');

section('.wiki formats a real summary payload');
behaviour = () => ({
  data: {
    title: 'Zimbabwe',
    description: 'country in Southern Africa',
    extract: 'Zimbabwe is a landlocked country in Southern Africa.',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Zimbabwe' } },
  },
  headers: { 'content-type': 'application/json' },
  status: 200,
});
h = harness();
await wikiCmd.execute(h.sock, MSG, ['Zimbabwe'], h.extra);
ok('the title is the heading', h.replies[0].includes('ZIMBABWE'));
ok('the extract is shown', h.replies[0].includes('landlocked country'));
ok('the link is shown', h.replies[0].includes('en.wikipedia.org/wiki/Zimbabwe'));

behaviour = () => { const e = new Error('Request failed'); e.response = { status: 404 }; throw e; };
h = harness();
await wikiCmd.execute(h.sock, MSG, ['zzzznotathing'], h.extra);
ok('a missing page is explained', h.replies[0].includes('Nothing on Wikipedia'));

/* ------------------------------------------------------------------ done */
process.send = origSend;
Module._load = origLoad;
console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m');
process.exit(fail ? 1 : 0);
})();
