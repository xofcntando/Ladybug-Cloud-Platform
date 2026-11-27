# Ladybug Brain — learn from owner-handled chats

## Engine (lib/bot-shims/ladybug-brain.js → mirror to bots/ladybug/utils/)
- [x] Accept `profile.learned` in normalizeProfile (cap, clean, ids)
- [x] Index learned pairs as retrieval docs
- [x] Answer from a learned pair (intent `learned`, slightly lower confidence)
- [x] Record learned count in the trace; export MAX_LEARNED

## Store (lib/wa-book.js)
- [x] brainLearned list: addLearned (dedupe + hits), learnedView, learnedFor, setLearnedStatus, clearLearned, brainFor
- [x] setAuto always merges the learned store into the brain profile
- [x] Export the new functions

## Runtime (lib/bot-shims/webBridge.js + lib/bots.js)
- [x] Track the last inbound customer message per chat (TTL, cap)
- [x] ownerTookOver emits `brain-learn` with the question/answer pair (echo + brain-on guards)
- [x] bots.js handles `brain-learn`, stores it and pushes the updated brain to the live bot

## Console (lib/webconsole.js, app.js, public/js/wa-brain.js)
- [x] brain GET returns learned rows; test uses them
- [x] approve / dismiss / clear handlers + routes
- [x] "Learned from your chats" card with Make FAQ / Dismiss / Clear

## Docs, tests, ship
- [x] Engine tests (learned retrieval, cap, dismiss)
- [x] Store tests (dedupe, hits, status, clear, survives restart)
- [x] LADYBUG_BRAIN.md + README.md
- [x] npm test green, mirror engine, commit, push to main
