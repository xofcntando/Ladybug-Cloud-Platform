# Messages survive a restart (MongoDB)

## 1. Find the gaps
- [x] Audit lib/chat-archive.js, lib/mongo-sync.js, lib/bots.js, lib/webconsole.js, server.js
- [x] Found: mirror was a one-shot 60s timer, restore only when the file was missing, no shutdown flush, 150/200 messages per chat, mtime-only cache

## 2. Fix the mirror
- [x] chat-archive: repeating 20s mirror loop per bot, only when the file changed
- [x] chat-archive: flushAll() to mirror every bot on shutdown
- [x] bots.js: start the loop on bot start, push once on exit, unschedule
- [x] app.js: shutdown waits 1.5s for bots to flush, then mirrors before closing Mongo

## 3. Fix the restore
- [x] chat-archive: restoreOne() — newest copy wins (missing OR older disk file)
- [x] chat-archive: ensure() — pull the cloud copy on demand before the console reads
- [x] webconsole: await ensure() in the offline chats/messages/channels paths
- [x] bots.js: keep a local copy when handing the cloud snapshot to the bot

## 4. Fix retention + cache
- [x] webBridge: PERSIST_PER_CHAT 150 -> 200 (matches MAX_PER_CHAT, so a restart loses nothing)
- [x] chat-archive: cache key on mtime+size (same-millisecond rewrites served stale data)

## 5. Verify
- [x] node --check on every changed file
- [x] test/chat-persistence.test.js: 12 checks against an in-memory MongoDB stub
- [x] End-to-end: bot stopped + saved file -> console API returns the messages, UI renders them
- [x] Unreachable MongoDB -> server still starts and serves 200
- [x] All suites green: 57 + 71 + 19 + 12 unit, 63 + 40 UI

## 6. Docs + ship
- [x] README persistence section updated
- [x] commit, push
