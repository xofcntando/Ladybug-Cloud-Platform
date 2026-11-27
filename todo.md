# Bot commands: .img, .bug, .feature + useful extras

## 1. Build the commands
- [x] `utils/imageGen.js` — provider chain (owner endpoint → key-free Pollinations → PrinceTech), size/timeout caps
- [x] `commands/ai/img.js` — `.img <prompt>` with aspect/size flags, replaces `magicstudio.js`
- [x] `utils/reports.js` — local report store + platform IPC event
- [x] `commands/general/report.js` — `.bug` and `.feature` (and `.feedback`)
- [x] `commands/ladybug/bug.js` — rename to `.ladybugfact` so `.bug` is free
- [x] `commands/general/help.js` — real `.help <command>` (menu promised it)
- [x] `commands/general/id.js`, `poll.js`, `wiki.js`, `define.js`
- [x] `commands/owner/reports.js` — `.reports` list/clear for the owner
- [x] `menu.js` — drop the `help` alias so `.help` reaches the new command

## 2. Platform side
- [x] `lib/wa-book.js` — `addReport` / `reportsView` / `markReport` / `clearReports`
- [x] `lib/bots.js` — handle the `report` IPC event → owner activity feed

## 3. Verify
- [x] `test/bot-commands.test.js` — unit tests for the new logic
- [x] `test/report-inbox.test.js` — platform inbox + activity feed
- [x] Wire into `npm test`, run the whole suite
- [x] Live check: real `.img` render through Pollinations (98 KB JPEG, 4.69 s)
- [x] Live check: `.define` and `.wiki` against the real APIs
- [x] Screenshots of the commands in action (`shots/commands-1.png`, `shots/commands-2.png`)

## 4. Document & ship
- [x] `BOT_COMMANDS.md` + README section
- [x] Commit and push to `main` (7b7fc30)
