/**
 * Ladybug Cloud — the weekly song drop.
 *
 * One song a week, picked from a catalog that ships with the bot, so the owner
 * sets nothing up: no API key, no playlist link, no cron entry. The rotation is
 * driven by the ISO week number, which means every bot in the world agrees on
 * what "this week's song" is, and the same week always gives the same answer
 * (a bot that restarts on Thursday does not suddenly change its mind).
 *
 * Two ways a song reaches a chat:
 *
 *   1. On demand — `.weekly`, `.weekly love`, `.weekly zim`, …
 *   2. On a schedule — `.weekly on` subscribes that chat, and a timer inside the
 *      bot posts the new pick once the ISO week turns over. The timer is started
 *      from index.js when the socket opens, so it dies with the process.
 *
 * What is sent is a card: title, artist, year, why it is worth four minutes, and
 * two search links (YouTube and Spotify). Audio is deliberately not attached —
 * `.song <title>` already downloads it, and a weekly broadcast that depends on
 * eight third-party download APIs would fail half the time.
 *
 * State lives in `weekly-songs.json` in the bot's data folder, capped, and is
 * written through a temp file so a crash mid-write cannot leave it unreadable.
 *
 * This file is copied into bots/ladybug/utils/ by the platform installer.
 * Edit lib/bot-shims/weeklySongs.js in the platform repo instead.
 */
const fs = require('fs');
const path = require('path');

const MAX_SUBS = 200;
const MAX_NAME = 60;
const TICK_MS = 20 * 60 * 1000; // check every 20 minutes; a week is a long time
const SEND_GAP_MS = 1500; // breathe between chats so WhatsApp does not throttle
const MAX_PER_TICK = 25;

/* ------------------------------------------------------------------ catalog */

/**
 * Every entry is a real, well-known recording. `why` is one line about the song
 * itself — no invented chart positions or dates, because a wrong fact in a
 * weekly broadcast is worse than no fact at all.
 */
const CATALOG = {
  love: {
    label: 'Love songs',
    emoji: '💗',
    blurb: 'the ones that still work on a long drive',
    songs: [
      { title: 'At Last', artist: 'Etta James', year: 1960, why: 'Six decades on, that opening string line still stops a room.' },
      { title: 'My Girl', artist: 'The Temptations', year: 1964, why: 'Three chords, one bass walk, and the sunniest vocal in Motown.' },
      { title: 'Unchained Melody', artist: 'The Righteous Brothers', year: 1965, why: 'Bobby Hatfield holds one note long enough to make you nervous.' },
      { title: "Let's Stay Together", artist: 'Al Green', year: 1971, why: 'The hi-hat alone is a love letter. Then he starts singing.' },
      { title: 'Wonderful Tonight', artist: 'Eric Clapton', year: 1977, why: 'A song about waiting by the stairs, which is where most love actually happens.' },
      { title: 'Endless Love', artist: 'Lionel Richie & Diana Ross', year: 1981, why: 'Two voices trading lines like a couple finishing each other sentences.' },
      { title: 'I Will Always Love You', artist: 'Whitney Houston', year: 1992, why: 'The a cappella opening is the whole argument for the human voice.' },
      { title: 'A Thousand Years', artist: 'Christina Perri', year: 2011, why: 'Wedding-playlist royalty, and it earns it on the bridge.' },
      { title: 'All of Me', artist: 'John Legend', year: 2013, why: 'Plain piano, plain words, and it still lands harder than most ballads.' },
      { title: 'Best Part', artist: 'Daniel Caesar & H.E.R.', year: 2017, why: 'Two people being quietly sure about each other. Rare in any decade.' },
      { title: 'Perfect', artist: 'Ed Sheeran', year: 2017, why: 'A slow-dance waltz written for the last song of the night.' },
      { title: 'Adorn', artist: 'Miguel', year: 2012, why: 'Smooth enough to be a slow jam, strange enough to be interesting.' },
    ],
  },
  zim: {
    label: 'Zimbabwe',
    emoji: '🇿🇼',
    blurb: 'chimurenga, sungura, Zimdancehall and the new wave',
    songs: [
      { title: 'Shabini', artist: 'Bhundu Boys', year: 1986, why: 'The jit that took a Harare bar band to a London stage.' },
      { title: 'Chitekete', artist: 'Leonard Dembo', year: 1988, why: 'Sungura at its most patient — the guitar does the talking.' },
      { title: 'Corruption', artist: 'Thomas Mapfumo', year: 1989, why: 'Chimurenga as protest music, with the mbira pushed to the front.' },
      { title: 'Neria', artist: 'Oliver Mtukudzi', year: 1991, why: 'A song for widows that became a national anthem of stubborn dignity.' },
      { title: 'Todii', artist: 'Oliver Mtukudzi', year: 2001, why: 'The husky voice, the question in the chorus, the whole country singing along.' },
      { title: 'Amai VaRudo', artist: 'Alick Macheso', year: 2003, why: 'The bass line is the lead instrument. Nobody argues about this.' },
      { title: 'Eriya', artist: 'Jah Prayzah', year: 2015, why: 'Marimba, mbira and a chorus built for a stadium.' },
      { title: 'Disappear', artist: 'Winky D', year: 2016, why: 'Zimdancehall with a message, and a hook you cannot unhear.' },
      { title: 'Ngaibake', artist: 'Freeman HKD', year: 2017, why: 'The dancefloor hit that made every Harare wedding sound the same, happily.' },
      { title: 'Maoko Kumusoro', artist: 'Killer T', year: 2018, why: 'Hands in the air, literally. Zimdancehall as a group activity.' },
      { title: 'Mhai', artist: 'Tocky Vibes', year: 2014, why: 'The song that turned a teenager into the sound of a whole summer.' },
      { title: 'Zvandofarira', artist: 'Andy Muridzo', year: 2016, why: 'Sungura for people who grew up on sungura and then found afrobeats.' },
    ],
  },
  gospel: {
    label: 'Gospel',
    emoji: '🙏',
    blurb: 'choir, church and Sunday-morning volume',
    songs: [
      { title: 'Amazing Grace', artist: 'Mahalia Jackson', year: 1947, why: 'The definitive reading of the most sung hymn in English.' },
      { title: 'Oh Happy Day', artist: 'Edwin Hawkins Singers', year: 1969, why: 'The moment gospel choir crossed into pop radio and stayed there.' },
      { title: 'Total Praise', artist: 'Richard Smallwood', year: 1996, why: 'A choir piece so strong other choirs use it to prove themselves.' },
      { title: 'Stand', artist: 'Donnie McClurkin', year: 2000, why: 'Written after a hard year, sung like it.' },
      { title: 'I Smile', artist: 'Kirk Franklin', year: 2011, why: 'Gospel that admits the week was rough before it celebrates.' },
      { title: 'Way Maker', artist: 'Sinach', year: 2015, why: 'A Nigerian church song that travelled to every continent without a label push.' },
      { title: 'Goodness of God', artist: 'CeCe Winans', year: 2019, why: 'Restrained until the last chorus, then not restrained at all.' },
      { title: 'Great Are You Lord', artist: 'All Sons & Daughters', year: 2012, why: 'Simple enough for a room with one guitar and no band.' },
    ],
  },
  amapiano: {
    label: 'Amapiano',
    emoji: '🎹',
    blurb: 'log drums, long intros, patience',
    songs: [
      { title: 'Sponono', artist: 'Kabza De Small & DJ Maphorisa', year: 2019, why: 'The log drum pattern that became a whole genre blueprint.' },
      { title: 'Ke Star', artist: 'Focalistic & Vigro Deep', year: 2020, why: 'The crossover record — piano tempo, rap energy.' },
      { title: 'Adiwele', artist: 'Kabza De Small & DJ Maphorisa ft. Young Stunna', year: 2021, why: 'Young Stunna announcing himself over a beat that refuses to hurry.' },
      { title: 'Asibe Happy', artist: 'Kabza De Small & DJ Maphorisa ft. Ami Faku', year: 2021, why: 'The rare piano track you can play for your mother.' },
      { title: 'Banyana', artist: 'Tyler ICU & Nicole Elocin', year: 2022, why: 'A vocal loop used like a drum. Textbook.' },
      { title: 'Mnike', artist: 'Tyler ICU & Tumelo.za ft. DJ Maphorisa, Nandipha808, Ceeka RSA, Tyron Dee', year: 2023, why: 'The one that made the whole continent do the same dance.' },
      { title: 'Yini', artist: 'Mas Musiq ft. Aymos & Samthing Soweto', year: 2021, why: 'Softer piano, closer to soul, and it holds up on headphones.' },
      { title: 'iPlan', artist: 'Focalistic ft. Mr JazziQ, Kabza De Small, Mellow & Sleazy', year: 2021, why: 'A hook that works in a club, a taxi and a church hall.' },
    ],
  },
  afro: {
    label: 'Afrobeats',
    emoji: '🌍',
    blurb: 'Lagos to Accra to Joburg, all hooks',
    songs: [
      { title: 'Ojuelegba', artist: 'Wizkid', year: 2014, why: 'A love letter to a Lagos neighbourhood that became a global reference point.' },
      { title: 'Fall', artist: 'Davido', year: 2017, why: 'The record that made Afrobeats a stadium proposition outside Africa.' },
      { title: 'Ye', artist: 'Burna Boy', year: 2018, why: 'Slow, heavy and confident — the sound of an artist deciding to be huge.' },
      { title: 'Love Nwantiti', artist: 'CKay', year: 2019, why: 'A bedroom-sized song that quietly became one of the most streamed African records ever.' },
      { title: 'Essence', artist: 'Wizkid ft. Tems', year: 2020, why: 'Two of the best voices in the scene, and a beat that leaves them room.' },
      { title: 'Peru', artist: 'Fireboy DML', year: 2021, why: 'Afro-R&B with a chorus that sounds like it was always there.' },
      { title: 'Last Last', artist: 'Burna Boy', year: 2022, why: 'Heartbreak you can dance to, built on a sample everyone recognises.' },
      { title: 'Calm Down', artist: 'Rema', year: 2022, why: 'The most exported Nigerian song of its year, and it still sounds light.' },
      { title: 'Rush', artist: 'Ayra Starr', year: 2022, why: 'A pop song with Afrobeats bones and no interest in being subtle.' },
      { title: 'Terminator', artist: 'King Promise', year: 2023, why: 'Ghanaian highlife-pop that sounds like good weather.' },
    ],
  },
  reggae: {
    label: 'Reggae & dancehall',
    emoji: '🌴',
    blurb: 'one drop, and the other one',
    songs: [
      { title: 'No Woman, No Cry', artist: 'Bob Marley & The Wailers', year: 1974, why: 'Comfort that never turns into a lecture.' },
      { title: 'Three Little Birds', artist: 'Bob Marley & The Wailers', year: 1977, why: 'Three chords, one promise, and it works on a bad day.' },
      { title: 'Is This Love', artist: 'Bob Marley & The Wailers', year: 1978, why: 'The warmest thing in the Wailers catalogue.' },
      { title: 'Redemption Song', artist: 'Bob Marley', year: 1980, why: 'Just voice and guitar, and it is still the biggest song he left behind.' },
      { title: 'Murder She Wrote', artist: 'Chaka Demus & Pliers', year: 1993, why: 'The dancehall record every DJ keeps within reach.' },
      { title: 'Here Comes the Hotstepper', artist: 'Ini Kamoze', year: 1994, why: 'A chant with a bass line, and it refuses to age.' },
      { title: 'Temperature', artist: 'Sean Paul', year: 2005, why: 'Dancehall as pure pop physics — impossible to stand still through.' },
      { title: 'Welcome to Jamrock', artist: 'Damian Marley', year: 2005, why: 'A serious song wearing a party beat, which is the hardest trick in the genre.' },
    ],
  },
  hiphop: {
    label: 'Hip-hop & R&B',
    emoji: '🎤',
    blurb: 'bars, and the slow jams next to them',
    songs: [
      { title: 'C.R.E.A.M.', artist: 'Wu-Tang Clan', year: 1993, why: 'A piano loop and four bars that explain an entire economy.' },
      { title: 'Juicy', artist: 'The Notorious B.I.G.', year: 1994, why: 'The blueprint for every "we made it" record since.' },
      { title: 'N.Y. State of Mind', artist: 'Nas', year: 1994, why: 'No hook, no chorus, no problem — just the best verse of its year.' },
      { title: 'Lose Yourself', artist: 'Eminem', year: 2002, why: 'A film soundtrack that outgrew the film.' },
      { title: 'Empire State of Mind', artist: 'JAY-Z ft. Alicia Keys', year: 2009, why: 'A city anthem with a chorus borrowed from a church.' },
      { title: 'Alright', artist: 'Kendrick Lamar', year: 2015, why: 'Protest chant and radio hit at the same time, which almost never happens.' },
      { title: 'Location', artist: 'Khalid', year: 2016, why: 'R&B with the volume turned down and the honesty turned up.' },
      { title: 'Snooze', artist: 'SZA', year: 2022, why: 'The slow jam of its decade, and the writing is the reason.' },
    ],
  },
  oldies: {
    label: 'Oldies & soul',
    emoji: '📻',
    blurb: 'the records your parents were right about',
    songs: [
      { title: "What's Going On", artist: 'Marvin Gaye', year: 1971, why: 'A protest song that never raises its voice and never stops being relevant.' },
      { title: 'Superstition', artist: 'Stevie Wonder', year: 1972, why: 'That clavinet riff is the whole song and it is enough.' },
      { title: 'September', artist: 'Earth, Wind & Fire', year: 1978, why: 'The most reliable good mood in recorded music.' },
      { title: 'Hotel California', artist: 'Eagles', year: 1976, why: 'Two guitar solos and a story that gets stranger every listen.' },
      { title: 'Dancing Queen', artist: 'ABBA', year: 1976, why: 'Perfect pop construction, no wasted second.' },
      { title: 'Billie Jean', artist: 'Michael Jackson', year: 1982, why: 'A bass line, a hi-hat, and nothing else needed.' },
      { title: 'Fast Car', artist: 'Tracy Chapman', year: 1988, why: 'A whole novel in under five minutes, sung quietly.' },
      { title: 'Kiss from a Rose', artist: 'Seal', year: 1994, why: 'Over the top in the best way, and nobody has copied it successfully.' },
    ],
  },
};

/** Short names people actually type. */
const ALIASES = {
  love: ['love', 'loves', 'love songs', 'lovesongs', 'romance', 'romantic', 'rugo'],
  zim: ['zim', 'zimbabwe', 'zimba', 'zw', 'local', 'sungura', 'zimdancehall', 'chimurenga'],
  gospel: ['gospel', 'church', 'worship', 'christian', 'spiritual'],
  amapiano: ['amapiano', 'piano', 'yanos', 'amapiano songs'],
  afro: ['afro', 'afrobeats', 'afropop', 'afrobeat', 'afro pop'],
  reggae: ['reggae', 'dancehall', 'ragga', 'roots'],
  hiphop: ['hiphop', 'hip-hop', 'rap', 'rnb', 'r&b', 'hip hop'],
  oldies: ['oldies', 'old', 'classics', 'classic', 'soul', 'old school', 'oldschool'],
};

const KEYS = Object.keys(CATALOG);

/* -------------------------------------------------------------------- state */

function dataDir() {
  return process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'database');
}

function file() {
  return path.join(dataDir(), 'weekly-songs.json');
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const out = { subs: {}, sent: {} };
    if (parsed && typeof parsed.subs === 'object' && parsed.subs) {
      for (const [jid, row] of Object.entries(parsed.subs)) {
        if (!jid || !row) continue;
        out.subs[jid] = { name: clean(row.name, MAX_NAME), at: Number(row.at) || Date.now() };
      }
    }
    if (parsed && typeof parsed.sent === 'object' && parsed.sent) {
      for (const [jid, row] of Object.entries(parsed.sent)) {
        if (!jid || !row) continue;
        out.sent[jid] = { week: clean(row.week, 20), id: clean(row.id, 80), at: Number(row.at) || 0 };
      }
    }
    return out;
  } catch (e) {
    return { subs: {}, sent: {} };
  }
}

function write(state) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const jids = Object.keys(state.subs).slice(0, MAX_SUBS);
    const subs = {};
    const sent = {};
    for (const jid of jids) {
      subs[jid] = state.subs[jid];
      if (state.sent[jid]) sent[jid] = state.sent[jid];
    }
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ subs, sent }, null, 2));
    fs.renameSync(tmp, file());
    return true;
  } catch (e) {
    console.error('[weekly] could not save:', e.message);
    return false;
  }
}

/* ----------------------------------------------------------------- rotation */

/**
 * ISO-8601 week number. The catalog rotation uses this rather than "days since
 * some epoch" because it lines up with how people already think about weeks:
 * Monday starts one, and 1 January can belong to the previous year's last week.
 */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // Sunday -> 7
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday decides the year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/** "2026-W12" — the key a chat is marked as served with. */
function weekKey(date = new Date()) {
  const { year, week } = isoWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Accepts "love", "Love Songs", "🇿🇼", "zimba"…; returns a catalog key or ''. */
function resolveCategory(input) {
  const needle = clean(input, 40).toLowerCase().replace(/[^a-z0-9& -]/g, '');
  if (!needle) return '';
  if (CATALOG[needle]) return needle;
  for (const key of KEYS) {
    if ((ALIASES[key] || []).includes(needle)) return key;
  }
  // last resort: a unique prefix, so ".weekly amap" still works
  const prefixed = KEYS.filter((k) => k.startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : '';
}

function categories() {
  return KEYS.map((key) => ({
    key,
    label: CATALOG[key].label,
    emoji: CATALOG[key].emoji,
    blurb: CATALOG[key].blurb,
    count: CATALOG[key].songs.length,
  }));
}

/**
 * The pick for a given week.
 *
 * The default category changes every week, so a chat that never passes an
 * argument still gets variety instead of twelve love songs in a row. Inside a
 * category the song advances once per visit, which means a category with twelve
 * entries takes twelve of its turns — nearly two years — to come back around.
 */
function pick(category, date = new Date()) {
  const { year, week } = isoWeek(date);
  const key = category ? resolveCategory(category) : '';
  if (category && !key) return null;
  const catKey = key || KEYS[week % KEYS.length];
  const list = CATALOG[catKey].songs;
  // One song forward per week, with a per-category offset so the eight lists do
  // not all turn over on the same week.
  const offset = KEYS.indexOf(catKey) * 3;
  const song = list[(((week + offset) % list.length) + list.length) % list.length];
  return {
    key: catKey,
    label: CATALOG[catKey].label,
    emoji: CATALOG[catKey].emoji,
    blurb: CATALOG[catKey].blurb,
    song,
    year,
    week,
    weekKey: `${year}-W${String(week).padStart(2, '0')}`,
  };
}

/** Next week's pick, for the "what is coming" line. */
function nextPick(category, date = new Date()) {
  const d = new Date(date.getTime() + 7 * 86400000);
  return pick(category, d);
}

function searchLinks(song) {
  const q = encodeURIComponent(`${song.title} ${song.artist}`);
  return {
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    spotify: `https://open.spotify.com/search/${encodeURIComponent(song.title + ' ' + song.artist)}`,
  };
}

/** The message body. Plain text on purpose: it has to look the same on every phone. */
function card(p, opts = {}) {
  if (!p) return '';
  const links = searchLinks(p.song);
  const lines = [];
  lines.push(`🎵 *WEEKLY SONG DROP* · week ${p.week}`);
  lines.push('────────────────────');
  lines.push(`${p.emoji} *${p.song.title}*`);
  lines.push(`👤 ${p.song.artist} · ${p.song.year}`);
  lines.push(`🏷️ ${p.label}`);
  lines.push('────────────────────');
  lines.push(p.song.why);
  lines.push('────────────────────');
  lines.push(`▶️ ${links.youtube}`);
  lines.push(`🎧 ${links.spotify}`);
  if (opts.footer !== false) {
    lines.push('────────────────────');
    lines.push(`💡 *.song ${p.song.title}* sends the audio here`);
    lines.push('🔔 *.weekly on* gets this every week');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------ subscriptions */

function subscribe(jid, name) {
  const id = clean(jid, 80);
  if (!id) throw new Error('A chat id is needed to subscribe.');
  const state = read();
  const already = Boolean(state.subs[id]);
  if (!already && Object.keys(state.subs).length >= MAX_SUBS) {
    throw new Error(`This bot already follows ${MAX_SUBS} chats. Turn one off first.`);
  }
  state.subs[id] = { name: clean(name, MAX_NAME), at: state.subs[id] ? state.subs[id].at : Date.now() };
  write(state);
  return { jid: id, already };
}

function unsubscribe(jid) {
  const id = clean(jid, 80);
  const state = read();
  const had = Boolean(state.subs[id]);
  delete state.subs[id];
  delete state.sent[id];
  write(state);
  return had;
}

function isSubscribed(jid) {
  return Boolean(read().subs[clean(jid, 80)]);
}

function subscribers() {
  const state = read();
  return Object.entries(state.subs).map(([jid, row]) => ({ jid, ...row }));
}

/** Chats that have not had this week's drop yet. */
function due(date = new Date()) {
  const key = weekKey(date);
  const state = read();
  return Object.entries(state.subs)
    .filter(([jid]) => !state.sent[jid] || state.sent[jid].week !== key)
    .map(([jid, row]) => ({ jid, name: row.name, week: key }));
}

function markSent(jid, week, id) {
  const state = read();
  const key = clean(jid, 80);
  if (!state.subs[key]) return false;
  state.sent[key] = { week: clean(week, 20), id: clean(id, 80), at: Date.now() };
  write(state);
  return true;
}

/* --------------------------------------------------------------- scheduler */

let timer = null;
let currentSock = null;
let lastError = '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function socketOpen(sock) {
  try {
    if (!sock) return false;
    if (sock.ws && typeof sock.ws.readyState === 'number') return sock.ws.readyState === 1;
    return Boolean(sock.user);
  } catch (e) {
    return false;
  }
}

/**
 * Send this week's drop to every chat that has not had it yet.
 * Exposed so `.weekly send` can force it and so tests can drive it.
 * @returns {Promise<{week:string, sent:number, failed:number, skipped:number}>}
 */
async function deliver(sock, opts = {}) {
  const date = opts.date || new Date();
  const key = weekKey(date);
  const targets = opts.force ? subscribers().map((s) => ({ jid: s.jid, name: s.name })) : due(date);
  const out = { week: key, sent: 0, failed: 0, skipped: 0 };
  if (!sock || !targets.length) return out;

  const limit = Math.min(targets.length, opts.limit || MAX_PER_TICK);
  const p = pick('', date); // one pick for the whole pass: everybody gets the same song
  for (let i = 0; i < limit; i += 1) {
    const target = targets[i];
    try {
      await sock.sendMessage(target.jid, { text: card(p) });
      markSent(target.jid, key, p.song.title);
      out.sent += 1;
    } catch (e) {
      out.failed += 1;
      lastError = e && e.message ? e.message : String(e);
      console.error('[weekly] could not send to', target.jid, '-', lastError);
    }
    if (i < limit - 1) await sleep(opts.gap == null ? SEND_GAP_MS : opts.gap);
  }
  out.skipped = Math.max(0, targets.length - limit);
  return out;
}

/** One scheduler pass. Safe to call by hand; never throws. */
async function tick(sock) {
  try {
    if (!socketOpen(sock)) return { week: weekKey(), sent: 0, failed: 0, skipped: 0, idle: true };
    const pending = due();
    if (!pending.length) return { week: weekKey(), sent: 0, failed: 0, skipped: 0, idle: true };
    return await deliver(sock);
  } catch (e) {
    lastError = e && e.message ? e.message : String(e);
    console.error('[weekly] tick failed:', lastError);
    return { week: weekKey(), sent: 0, failed: 0, skipped: 0, error: lastError };
  }
}

/**
 * Start the weekly timer. Called from index.js once the socket is open; calling
 * it twice is harmless because the old timer is cleared first.
 */
function start(sock, opts = {}) {
  currentSock = sock;
  stop();
  const every = Math.max(60 * 1000, Number(opts.intervalMs) || TICK_MS);
  timer = setInterval(() => {
    tick(currentSock).catch(() => {});
  }, every);
  if (timer.unref) timer.unref(); // never keep the process alive on its own
  // one pass shortly after boot, so a bot that was offline on Monday still delivers
  setTimeout(() => { tick(currentSock).catch(() => {}); }, Math.max(5000, Number(opts.firstDelayMs) || 20000)).unref?.();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const state = read();
  return {
    week: weekKey(),
    subscribers: Object.keys(state.subs).length,
    maxSubscribers: MAX_SUBS,
    deliveredThisWeek: Object.values(state.sent).filter((r) => r && r.week === weekKey()).length,
    running: Boolean(timer),
    lastError,
  };
}

module.exports = {
  CATALOG,
  KEYS,
  ALIASES,
  MAX_SUBS,
  categories,
  resolveCategory,
  isoWeek,
  weekKey,
  pick,
  nextPick,
  card,
  searchLinks,
  subscribe,
  unsubscribe,
  isSubscribed,
  subscribers,
  due,
  markSent,
  deliver,
  tick,
  start,
  stop,
  status,
  read,
  file,
  clean,
};
