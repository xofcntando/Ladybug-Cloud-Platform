# `.weekly` — one song a week, out of the box

## Catalog & rotation (`lib/bot-shims/weeklySongs.js` → mirror to `bots/ladybug/utils/`)
- [x] Eight categories with a dozen real recordings each: love, Zimbabwe, gospel, amapiano, afrobeats, reggae, hip-hop, oldies
- [x] One line per song saying why it is worth four minutes
- [x] ISO-week rotation: same song all week, moves on every Monday, survives restarts
- [x] Default category rotates weekly; per-category offset so the lists do not turn over together
- [x] Category aliases and unique prefixes (`love`, `zimba`, `amap`, `r&b`, `zimbabwe`)

## The card
- [x] Title, artist, year, category, reason, YouTube + Spotify search links
- [x] Points at `.song <title>` for the audio instead of depending on the download APIs
- [x] Fits one WhatsApp message, never prints `undefined`

## Weekly delivery
- [x] `weekly-songs.json` in the bot data folder: subscribers + per-week sent marks, capped, written through a temp file
- [x] `due()` / `markSent()` so a restart cannot double-post
- [x] `deliver()` sends one pick per pass, survives a broken chat, reports failures
- [x] `start()` timer from `index.js` on `connection.open`, checks every 20 min, only acts while the socket is open, unref'd
- [x] Group switches need an admin or the owner

## Command (`commands/general/weekly.js`)
- [x] `.weekly`, `.weekly <category>`, `.weekly next`, `.weekly all`
- [x] `.weekly on` / `.weekly off`
- [x] `.weekly status` / `.weekly send` (owner)
- [x] Themed replies, category menu, helpful error for an unknown category

## Installer
- [x] `ensureWeeklySongs()` copies the shim into every bot and re-applies the `index.js` hook after an upstream download

## Docs, tests, ship
- [x] `test/weekly-songs.test.js` (573 assertions) wired into `npm test`
- [x] BOT_COMMANDS.md section + README bullet
- [x] `npm test` green, module mirrored byte-identically, committed and pushed to `main`
