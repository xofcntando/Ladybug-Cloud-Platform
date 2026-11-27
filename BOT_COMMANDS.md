# 🐞 Ladybug Mini — chat commands

Everything below runs inside WhatsApp. The default prefix is `.` and the owner can change
it with `.setprefix`. Commands work the same in a group and in a direct chat unless the
table says otherwise.

## 🎨 `.img` — draw a picture from words

```
.img a ladybug on a green leaf, macro photo
.img a neon city at night --wide
.img a sticker of a smiling bee --square --seed=7
```

Aliases: `.image` `.imagine` `.draw` `.art` `.pic` `.gen` `.magic` `.aiimage` `.generate`

| Flag | What it does |
| --- | --- |
| `--square` | 1:1, 1024×1024 (default) |
| `--wide` | 16:9, 1344×768 |
| `--tall` | 9:16, 768×1344 |
| `--seed=N` | repeat the same picture |
| `--nologo` | ask the provider to drop its watermark |

The bot paints a placeholder, replaces it with the finished picture, and reacts ✅ when it
lands (❌ if every provider failed). Prompts are capped at 900 characters and downloads at
8 MB, and the bytes are checked by magic number — an HTML error page is never sent to a
chat as if it were a photo.

### Where the pictures come from

`.img` walks a short chain and stops at the first success:

1. **Your own endpoint** — set these on the bot's environment and nothing leaves your server:

   ```
   LADYBUG_IMG_URL=https://api.openai.com/v1/images/generations
   LADYBUG_IMG_KEY=sk-...
   LADYBUG_IMG_MODEL=dall-e-3
   ```

   Any OpenAI-compatible `/images/generations` endpoint works. A plain GET endpoint works
   too: `LADYBUG_IMG_URL=https://your-host/gen?prompt={prompt}&w={width}` (`{prompt}`,
   `{width}` and `{height}` are filled in).

2. **Pollinations** — key-free, no signup, so `.img` works out of the box. Anonymous
   callers get one image every 45 seconds per IP, so the command waits and retries once
   when it is asked to. On a shared hosting IP that wait is common; a free token from
   pollinations.ai, set as `LADYBUG_IMG_KEY` **without** `LADYBUG_IMG_URL`, removes the
   queue and the small credit watermark.

3. **PrinceTech Flux** — the endpoint the old `.imagine` used, kept as a last resort.

`LADYBUG_IMG_FREE=0` forbids the public services entirely: with no `LADYBUG_IMG_URL` the
command then answers that image generation is switched off. That is the setting to use if
your customers' prompts must never touch a third party.

## 🐞 `.bug` — report something broken

```
.bug .sticker crashes when the video is over 2 minutes
```
…or reply to the message that broke and send `.bug` on its own — the quoted text is
captured for you.

Aliases: `.reportbug` `.report` `.issue` `.broken`

The customer gets a reference like `BUG-3F2A`, and the report goes two places: a JSON file
next to the bot's data (`reports.json`) and the platform, where it appears in the owner's
Activity feed. The owner can also read it in chat with `.reports`.

## 💡 `.feature` — ask for something new

```
.feature a reminder command that pings me at 8am
```

Aliases: `.suggest` `.idea` `.request` `.featurerequest` `.wish` — references are tagged
`REQ-…`.

## 💬 `.feedback` — say how it is going

```
.feedback the new img command is fast
```

Aliases: `.rate` `.review` — references are tagged `FBK-…`.

## 📥 `.reports` — the owner's inbox (owner only)

```
.reports                 # everything, newest first
.reports bug             # only bugs
.reports feature         # only requests
.reports clear           # empty the inbox
.reports clear bug       # empty one kind
```

Aliases: `.bugs` `.requests` `.inbox`. Shows counts per kind, the reference, the text, who
sent it and from which group.

## 🧭 `.help` — the manual the menu promised

```
.help            # the full menu
.help img        # one command: description, usage, aliases, who may use it
```

Aliases: `.h` `.howto`. A typo gets a suggestion (`.help stikcer` → “Did you mean
`.sticker`?”).

## 📊 `.poll` — a real WhatsApp poll

```
.poll Pizza or burgers | Pizza | Burgers | Tacos
```

Aliases: `.vote` `.survey`. Up to 12 options, one choice per person. The part before the
first `|` is the question.

## 📖 `.define` — dictionary lookup

```
.define serendipity
```

Aliases: `.dict` `.meaning` `.dictionary`. Definitions come from Wiktionary, so they are
free, key-less and reachable from a plain server. Up to three senses with part of speech
and an example.

## 🌍 `.wiki` — a Wikipedia summary

```
.wiki Coccinellidae
```

Aliases: `.wikipedia` `.wik`. Handles ambiguous titles by saying so, and links the article
for the full read.

## 🪪 `.id` — the identifiers you need for support

```
.id
```

Aliases: `.jid` `.chatid` `.whoami`. Prints the chat JID, the chat type, your own JID and
number, the group name and member count, and the participant of the message you replied
to. This is what to paste when asking for help with a group.

## 🎵 `.weekly` — one song a week

```
.weekly                 this week's pick
.weekly love            this week's pick from the love list
.weekly zim             Zimbabwe 🇿🇼 — sungura, chimurenga, Zimdancehall
.weekly next            what lands next Monday
.weekly all             the eight categories
.weekly on              post a new song here every week
.weekly off             stop the weekly drop
.weekly status          who is following (owner)
.weekly send            deliver this week's song now (owner)
```

Aliases: `.songoftheweek` `.weeklysong` `.drop` `.sotw`

Eight categories ship with the bot — **love**, **zim**, **gospel**, **amapiano**, **afro**,
**reggae**, **hiphop**, **oldies** — each with a dozen real, well-known recordings and one
line about why it is worth four minutes. Nothing to configure: no API key, no playlist, no
cron entry.

The pick is driven by the **ISO week number**, so it is the same all week, it survives a
restart, and it moves on by itself every Monday. A call with no category rotates the
category too, so a chat that never passes an argument still gets variety instead of twelve
love songs in a row. Inside a category the list advances one song per week, with a
per-category offset so the eight lists do not all turn over together.

What arrives is a card: title, artist, year, the reason, and two search links (YouTube and
Spotify). Audio is deliberately not attached — `.song <title>` already downloads it, and a
weekly broadcast that depended on eight third-party download APIs would fail half the time.

`.weekly on` is what makes it *weekly*. The bot keeps a small subscriber list in
`weekly-songs.json` next to its data, and a timer started when the socket opens posts the
new pick to every chat that has not had it yet. A chat is marked as served per week, so a
restart cannot double-post; a chat that fails is retried on the next pass and reported in
`.weekly status`. In a group only an admin (or the owner) can switch it on or off.

The timer is started from `index.js` on `connection.open`, checks every 20 minutes, and
only acts while the socket is open. It never keeps the process alive on its own.

## 🐞 `.ladybugfact` — the old `.bug`

The random ladybug fact that used to live at `.bug` is now `.ladybugfact`
(aliases `.bugfact` `.ladybugfacts` `.fact`), so `.bug` could become the report command.

## For developers

Each command is a file under `bots/ladybug/commands/<category>/` exporting
`{ name, aliases, category, description, usage, ownerOnly?, adminOnly?, execute }` — or an
array of them, which is how `.bug`, `.feature` and `.feedback` share one file. Replies are
built with `utils/ladybugTheme.js` so every box has the same frame, icons and signature.

The image chain lives in `bots/ladybug/utils/imageGen.js` (`generate`, `parseArgs`,
`pollinationsUrl`, `customUrl`, `sniffImage`, `retryAfterMs`). The report store lives in
`bots/ladybug/utils/reports.js` and is mirrored on the platform by `lib/wa-book.js`
(`addReport`, `reportsView`, `markReport`, `clearReports`); `lib/bots.js` turns the
`{type:'wa', event:'report'}` IPC message into an activity-feed entry.

The weekly song drop lives in `bots/ladybug/utils/weeklySongs.js` (`pick`, `card`,
`subscribe`, `due`, `deliver`, `start`) and is mirrored on the platform by
`lib/bot-shims/weeklySongs.js`; `lib/installer.js` copies it into every bot and re-applies
the `index.js` start hook after an upstream download.

Tests: `node test/bot-commands.test.js`, `node test/report-inbox.test.js` and
`node test/weekly-songs.test.js`, all part of `npm test`.
