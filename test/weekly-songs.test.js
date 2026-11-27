/**
 * Tests for the weekly song drop.
 *
 *   utils/weeklySongs.js   catalog, ISO-week rotation, subscriptions, scheduler
 *   commands/general/weekly.js   `.weekly`, `.weekly love`, `.weekly on|off`, …
 *
 * No network, no WhatsApp: the socket is a stub that records what it was asked
 * to send, and the bot's data folder is a throwaway temp directory.
 *
 * Run: node test/weekly-songs.test.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ladybug-weekly-test-'));
process.env.BOT_DATA_DIR = DATA;

const weekly = require('../bots/ladybug/utils/weeklySongs');
const command = require('../bots/ladybug/commands/general/weekly');

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ''}`);
}

function eq(name, got, want) {
  ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* --------------------------------------------------------------- the catalog */

const KEYS = weekly.KEYS;
ok('there are several categories', KEYS.length >= 6, String(KEYS.length));
eq('the eight promised categories', KEYS.join(','), 'love,zim,gospel,amapiano,afro,reggae,hiphop,oldies');

for (const key of KEYS) {
  const cat = weekly.CATALOG[key];
  ok(`${key} has a label`, Boolean(cat.label), key);
  ok(`${key} has an emoji`, Boolean(cat.emoji), key);
  ok(`${key} has at least eight songs`, cat.songs.length >= 8, `${key}: ${cat.songs.length}`);
  for (const song of cat.songs) {
    ok(`${key} song has a title`, Boolean(song.title && song.title.trim()), JSON.stringify(song));
    ok(`${key} song has an artist`, Boolean(song.artist && song.artist.trim()), song.title);
    ok(`${key} song has a plausible year`, Number(song.year) > 1900 && Number(song.year) <= 2030, `${song.title}: ${song.year}`);
    ok(`${key} song has a reason`, Boolean(song.why && song.why.length > 20), song.title);
    ok(`${key} reason is one line`, !/[\r\n]/.test(String(song.why)), song.title);
  }
  const titles = cat.songs.map((s) => s.title.toLowerCase());
  eq(`${key} has no duplicate titles`, new Set(titles).size, titles.length);
}

/* ------------------------------------------------------------- ISO week maths */

function iso(date) {
  return weekly.isoWeek(new Date(date + 'T12:00:00Z'));
}

let w = iso('2026-03-16');
eq('Monday 16 March 2026 is week 12', w.week, 12);
eq('…in 2026', w.year, 2026);

w = iso('2019-12-30');
eq('30 Dec 2019 belongs to week 1', w.week, 1);
eq('…of 2020', w.year, 2020);

w = iso('2021-01-01');
eq('1 Jan 2021 is still week 53', w.week, 53);
eq('…of 2020', w.year, 2020);

w = iso('2020-12-31');
eq('31 Dec 2020 is week 53', w.week, 53);

w = iso('2021-01-04');
eq('4 Jan 2021 starts week 1', w.week, 1);
eq('…of 2021', w.year, 2021);

eq('week keys are sortable', weekly.weekKey(new Date('2026-03-16T12:00:00Z')), '2026-W12');
eq('week keys are zero padded', weekly.weekKey(new Date('2026-01-05T12:00:00Z')), '2026-W02');

/* ------------------------------------------------------------------- rotation */

const monday = new Date('2026-03-16T09:00:00Z');
const tuesday = new Date('2026-03-17T21:00:00Z');
const nextMonday = new Date('2026-03-23T09:00:00Z');

const a = weekly.pick('', monday);
const b = weekly.pick('', tuesday);
eq('the same week gives the same song', a.song.title, b.song.title);
eq('…and the same category', a.key, b.key);
eq('…and the same week key', a.weekKey, b.weekKey);

const c = weekly.pick('', nextMonday);
ok('the next week moves on', c.song.title !== a.song.title || c.key !== a.key, `${a.song.title} vs ${c.song.title}`);

eq('the default category rotates', a.key, KEYS[12 % KEYS.length]);
eq('…which for week 12 is afro', a.key, 'afro');

const love = weekly.pick('love', monday);
eq('asking for love gives love', love.key, 'love');
eq('…and stays in love the next week', weekly.pick('love', nextMonday).key, 'love');
ok(
  'love songs advance week by week',
  weekly.pick('love', monday).song.title !== weekly.pick('love', new Date('2026-03-30T09:00:00Z')).song.title
);

ok('an unknown category returns null', weekly.pick('polka', monday) === null);
eq('a category is case-insensitive', weekly.pick('LOVE', monday).key, 'love');
eq('a unique prefix works', weekly.pick('amap', monday).key, 'amapiano');
eq('a country name works', weekly.pick('zimbabwe', monday).key, 'zim');
eq('an alias works', weekly.pick('r&b', monday).key, 'hiphop');
eq('an emoji-ish label is stripped', weekly.resolveCategory('🇿🇼'), '');
eq('blank means no category', weekly.resolveCategory(''), '');

// The rotation must not fall off the end of a short list.
let seen = new Set();
for (let i = 0; i < 60; i += 1) {
  const d = new Date(Date.UTC(2026, 0, 5 + i * 7));
  const p = weekly.pick('love', d);
  ok(`week ${i} returns a song`, Boolean(p && p.song), JSON.stringify(p && p.song));
  seen.add(p.song.title);
}
ok('a year of love songs is not one song', seen.size >= 8, `${seen.size} distinct`);

const nxt = weekly.nextPick('zim', monday);
eq('next week preview is one week ahead', nxt.weekKey, '2026-W13');
eq('next week preview keeps the category', nxt.key, 'zim');

/* ----------------------------------------------------------------------- card */

const card = weekly.card(a);
ok('the card names the song', card.includes(a.song.title), card);
ok('the card names the artist', card.includes(a.song.artist), card);
ok('the card shows the year', card.includes(String(a.song.year)), card);
ok('the card shows the week', card.includes(String(a.week)), card);
ok('the card has a YouTube link', /youtube\.com\/results\?search_query=/.test(card), card);
ok('the card has a Spotify link', /open\.spotify\.com\/search\//.test(card), card);
ok('the card explains the pick', card.includes(a.song.why.slice(0, 20)), card);
ok('the card tells you how to get the audio', card.includes('.song '), card);
ok('the card never says undefined', !/undefined|null|NaN/.test(card), card);
ok('the card fits one WhatsApp message', card.length < 1200, String(card.length));

const bare = weekly.card(a, { footer: false });
ok('the footer can be dropped', !bare.includes('.weekly on'), bare);

const links = weekly.searchLinks({ title: 'Todii', artist: 'Oliver Mtukudzi' });
ok('links are encoded', links.youtube.includes('Todii%20Oliver%20Mtukudzi'), links.youtube);

/* -------------------------------------------------------------- subscriptions */

eq('nothing is subscribed yet', weekly.subscribers().length, 0);
eq('a chat starts unsubscribed', weekly.isSubscribed('263771234567@s.whatsapp.net'), false);

const first = weekly.subscribe('263771234567@s.whatsapp.net', 'Tino');
eq('subscribing reports it is new', first.already, false);
eq('…and the chat is subscribed', weekly.isSubscribed('263771234567@s.whatsapp.net'), true);
eq('…and shows up in the list', weekly.subscribers().length, 1);
eq('…with its name kept', weekly.subscribers()[0].name, 'Tino');

const again = weekly.subscribe('263771234567@s.whatsapp.net', 'Tino');
eq('subscribing twice is not an error', again.already, true);
eq('…and does not duplicate', weekly.subscribers().length, 1);

weekly.subscribe('120363000000000000@g.us', 'group');
eq('a group can subscribe too', weekly.subscribers().length, 2);

eq('unsubscribing a known chat', weekly.unsubscribe('263771234567@s.whatsapp.net'), true);
eq('…removes it', weekly.isSubscribed('263771234567@s.whatsapp.net'), false);
eq('unsubscribing an unknown chat', weekly.unsubscribe('263771234567@s.whatsapp.net'), false);
eq('the group is still there', weekly.subscribers().length, 1);

ok('a blank chat id is refused', (() => {
  try {
    weekly.subscribe('', 'x');
    return false;
  } catch (e) {
    return true;
  }
})());

// the cap
for (let i = 0; i < weekly.MAX_SUBS + 5; i += 1) {
  try {
    weekly.subscribe(`2637700${String(i).padStart(5, '0')}@s.whatsapp.net`, `n${i}`);
  } catch (e) {
    /* cap reached, expected */
  }
}
eq('the subscriber list is capped', weekly.subscribers().length, weekly.MAX_SUBS);
ok('the cap throws rather than silently dropping', (() => {
  try {
    weekly.subscribe('999999999999@s.whatsapp.net', 'overflow');
    return false;
  } catch (e) {
    return /follows/.test(e.message);
  }
})());

/* --------------------------------------------------------------- the delivery */

// back to a clean, small state
for (const s of weekly.subscribers()) weekly.unsubscribe(s.jid);
weekly.subscribe('263771234567@s.whatsapp.net', 'Tino');
weekly.subscribe('120363000000000000@g.us', 'group');

eq('both chats are due this week', weekly.due(monday).length, 2);
eq('…and both carry the week key', weekly.due(monday)[0].week, '2026-W12');

const sent = [];
const sock = {
  ws: { readyState: 1 },
  user: { id: '263770000000:1@s.whatsapp.net' },
  async sendMessage(jid, payload) {
    sent.push({ jid, payload });
    return { key: { id: 'x' } };
  },
};

(async () => {
  const res = await weekly.deliver(sock, { date: monday, gap: 0 });
  eq('both chats got a song', res.sent, 2);
  eq('nothing failed', res.failed, 0);
  eq('two messages went out', sent.length, 2);
  eq('…to the person', sent[0].jid, '263771234567@s.whatsapp.net');
  eq('…and the group', sent[1].jid, '120363000000000000@g.us');
  ok('the message is the card', sent[0].payload.text.includes('WEEKLY SONG DROP'), sent[0].payload.text);
  eq('both are now served', weekly.due(monday).length, 0);

  const second = await weekly.deliver(sock, { date: monday, gap: 0 });
  eq('a second pass sends nothing', second.sent, 0);
  eq('…and does not double-post', sent.length, 2);

  // a new week is due again
  eq('next week is due again', weekly.due(nextMonday).length, 2);

  // a forced send ignores the "already served" mark
  const forced = await weekly.deliver(sock, { date: monday, force: true, gap: 0 });
  eq('a forced send goes out anyway', forced.sent, 2);

  // one broken chat must not stop the rest
  const flaky = [];
  const halfBroken = {
    ws: { readyState: 1 },
    async sendMessage(jid) {
      if (String(jid).endsWith('@g.us')) throw new Error('not a participant');
      flaky.push(jid);
    },
  };
  const partial = await weekly.deliver(halfBroken, { date: nextMonday, force: true, gap: 0 });
  eq('the good chat still got it', partial.sent, 1);
  eq('the bad chat is counted', partial.failed, 1);
  ok('the failure is remembered for .weekly status', /participant/.test(weekly.status().lastError), weekly.status().lastError);

  // a closed socket sends nothing
  const closed = await weekly.tick({ ws: { readyState: 3 } });
  ok('a closed socket is idle', closed.idle === true, JSON.stringify(closed));

  // the timer
  eq('the timer starts stopped', weekly.status().running, false);
  weekly.start(sock, { intervalMs: 3600000, firstDelayMs: 3600000 });
  eq('start turns the timer on', weekly.status().running, true);
  weekly.start(sock, { intervalMs: 3600000, firstDelayMs: 3600000 });
  eq('starting twice is harmless', weekly.status().running, true);
  weekly.stop();
  eq('stop turns the timer off', weekly.status().running, false);

  /* ------------------------------------------------------------ the command */

  const replies = [];
  function extra(over = {}) {
    return Object.assign(
      {
        from: '263771234567@s.whatsapp.net',
        sender: '263771234567@s.whatsapp.net',
        isGroup: false,
        isOwner: false,
        isAdmin: false,
        pushName: 'Tino',
        reply: async (text) => { replies.push(text); return text; },
        react: async () => {},
      },
      over
    );
  }
  const fakeSock = { sendMessage: async () => ({}) };
  const fakeMsg = { key: { remoteJid: '263771234567@s.whatsapp.net', id: '1' } };

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, [], extra());
  ok('`.weekly` answers with a card', /WEEKLY SONG DROP/.test(replies[0]), replies[0]);
  ok('…and mentions the weekly switch', /\.weekly (on|off)/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['love'], extra());
  ok('`.weekly love` answers with a love song', /Love songs/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['zim'], extra());
  ok('`.weekly zim` answers with a Zimbabwean song', /Zimbabwe/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['polka'], extra());
  ok('an unknown category is explained', /No category called/.test(replies[0]), replies[0]);
  ok('…and lists the real ones', /amapiano/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['all'], extra());
  ok('`.weekly all` lists the categories', /Love songs/.test(replies[0]) && /Gospel/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['next'], extra());
  ok('`.weekly next` previews next week', /NEXT WEEK/i.test(replies[0]), replies[0]);

  // subscribe from a direct chat
  for (const s of weekly.subscribers()) weekly.unsubscribe(s.jid);
  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['on'], extra());
  ok('`.weekly on` confirms', /is on/.test(replies[0]), replies[0]);
  eq('…and the chat is subscribed', weekly.isSubscribed('263771234567@s.whatsapp.net'), true);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['on'], extra());
  ok('`.weekly on` twice says it was already on', /already on/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['off'], extra());
  ok('`.weekly off` confirms', /is off/.test(replies[0]), replies[0]);
  eq('…and the chat is unsubscribed', weekly.isSubscribed('263771234567@s.whatsapp.net'), false);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['off'], extra());
  ok('`.weekly off` twice is polite', /was not on/.test(replies[0]), replies[0]);

  // a group needs an admin to switch it on
  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['on'], extra({ isGroup: true, from: '120363000000000000@g.us' }));
  ok('a group member cannot switch it on', /admin/.test(replies[0]), replies[0]);
  eq('…and the group is not subscribed', weekly.isSubscribed('120363000000000000@g.us'), false);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['on'], extra({ isGroup: true, isAdmin: true, from: '120363000000000000@g.us' }));
  ok('a group admin can switch it on', /is on/.test(replies[0]), replies[0]);
  eq('…and the group is subscribed', weekly.isSubscribed('120363000000000000@g.us'), true);
  weekly.unsubscribe('120363000000000000@g.us');

  // owner-only bits
  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['status'], extra());
  ok('a stranger cannot read the subscriber list', /Owner only/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['status'], extra({ isOwner: true }));
  ok('the owner sees the status', /Chats following/.test(replies[0]), replies[0]);
  ok('…and the week', /2026-W|W\d\d/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['send'], extra());
  ok('a stranger cannot force a broadcast', /Owner only/.test(replies[0]), replies[0]);

  replies.length = 0;
  await command.execute(fakeSock, fakeMsg, ['send'], extra({ isOwner: true }));
  ok('the owner can force a broadcast', /Weekly drop sent/.test(replies[0]), replies[0]);

  /* --------------------------------------------------------------- hygiene */

  eq('newlines are stripped from stored names', weekly.clean('a\nb\tc', 20), 'a b c');
  eq('names are capped', weekly.clean('x'.repeat(200), 10).length, 10);
  ok('the state file lives in the bot data folder', weekly.file().startsWith(DATA), weekly.file());
  ok('the state file was written', fs.existsSync(weekly.file()), weekly.file());
  const saved = JSON.parse(fs.readFileSync(weekly.file(), 'utf8'));
  ok('the file has both maps', typeof saved.subs === 'object' && typeof saved.sent === 'object', JSON.stringify(Object.keys(saved)));

  // a corrupt file must not crash the bot
  fs.writeFileSync(weekly.file(), '{not json');
  eq('a corrupt file reads as empty', weekly.subscribers().length, 0);
  const recovered = await weekly.tick(sock);
  ok('…and the bot carries on', typeof recovered.week === 'string', JSON.stringify(recovered));

  /* ------------------------------------------------------------- reporting */

  const total = passed + failures.length;
  console.log(`\nweekly songs: ${passed}/${total} passed`);
  if (failures.length) {
    console.log(`\n${failures.length} failure(s):`);
    for (const f of failures) console.log('  ✗ ' + f);
    process.exitCode = 1;
  } else {
    console.log('all good');
  }
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
})();
