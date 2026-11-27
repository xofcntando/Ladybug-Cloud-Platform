# Ladybug Brain — media handling + human takeover

## A. Human takeover / pause (feature 1)
- [x] Read webBridge.js message flow + how owner-sent messages are detected
- [x] Add per-chat pause store in wa-book.js (pause, resume, isPaused, list, TTL)
- [x] Bot side: skip auto-reply when chat paused; emit pause events
- [x] Auto-pause when the owner sends a message in that chat
- [x] API endpoints: pause / resume / list paused
- [x] Console UI: paused pill in the chat header + takeover panel
- [x] Tests for pause store + gating
- [x] Docs

## B. Voice notes & photos (feature 3)
- [x] Read how webBridge classifies media + what text it gets
- [x] Brain: detect non-text, reply politely instead of silence
- [x] Optional transcription hook (env-configurable), graceful when absent
- [x] Image: acknowledge + ask for text / hand off
- [x] Tests
- [x] Docs

## C. Ship
- [x] npm test green (514 assertions, 7 suites)
- [x] sw.js bump (v14)
- [x] Commit + push
- [x] Screenshots
