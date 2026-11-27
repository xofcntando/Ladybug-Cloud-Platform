# WhatsApp console: AI assistant (A) + chatbot flow builder (D)

## 1. Flow engine
- [x] lib/bot-shims/flow-engine.js — dependency-free normalise/pick/render/start/advance/alive
- [x] Caps: 20 flows, 8 steps, 6 options, 500 chars, 30-min session TTL
- [x] Terminal steps (no options) close the session

## 2. Flow storage + bot runtime
- [x] lib/wa-book.js — flows in auto settings, cleanFlows validation (keyword or any required)
- [x] webBridge — maybeFlow() before keyword rules, per-chat sessions, cooldown, autoGet returns flows
- [x] installer copies flow-engine.js next to webBridge.js; bots/ladybug/utils updated

## 3. AI backend
- [x] lib/wa-ai.js — masked key storage, https/SSRF guards, chat + transcribe, 45s timeout
- [x] suggestReplies / summarize / rewrite with fixed prompts
- [x] lib/webconsole.js ai() handler, 20 calls/min per bot
- [x] app.js routes: GET/POST /api/ai/settings, POST /api/bots/:id/web/ai

## 4. Frontend
- [x] public/js/wa-ai.js — rail button, provider panel, reply/summary/rewrite, voice transcribe pill
- [x] public/js/wa-flows.js — list + editor (steps, options, targets, preview)
- [x] index.html, app.js init + palette, appmode.js tiles (18 tools), sw.js v10, style.css

## 5. Verify
- [x] node --check on every changed file
- [x] test/wa-ai-flows.test.js — 75 assertions, all pass
- [x] npm test — all suites green
- [x] Live server smoke: /, /js/wa-ai.js, /js/wa-flows.js, /css/style.css = 200; register/login; /api/ai/settings; https-only rejection

## 6. Docs + delivery
- [x] AI_AND_FLOWS.md + README section
- [x] Patch + ZIP built in /workspace/delivery
- [x] Pushed to GitHub main as 1cdd9a6 (token used only for the push, never written to .git/config)

---

# Ladybug Brain: built-in auto-responder (no API key)

## 1. Engine
- [x] lib/bot-shims/ladybug-brain.js — pure, dependency-free understand → retrieve → reason → decide → answer
- [x] 22 intents with weighted cues + phrase patterns; entity, sentiment, urgency and shouting detection
- [x] BM25-lite retrieval with term coverage (tiny-corpus safe); time-aware opening hours
- [x] Weigh step (intent answer vs knowledge-base hit), slot filling, ambiguity clarification, honest fallback
- [x] Escalation policy for complaints / anger / human requests; gap records for every miss

## 2. Storage + bot runtime
- [x] lib/wa-book.js — cleanBrain (refuses an empty profile), addGap / gapsView / clearGaps (dedupe, cap 120)
- [x] webBridge — maybeBrain(), per-chat rate limit + cooldown, brain-gap IPC, autoGet returns brain
- [x] lib/bots.js persists brain-gap events; installer ships ladybug-brain.js next to the bridge
- [x] bots/ladybug/utils/ladybug-brain.js synced

## 3. Backend
- [x] lib/webconsole.js — brain(), brainTest() (20/min), brainGapsClear()
- [x] app.js routes: GET /api/bots/:id/web/brain, POST …/brain/test, POST …/brain/gaps/clear

## 4. Frontend
- [x] public/js/wa-brain.js — profile editor, hours, prices, FAQs, hand-off, Try it box with reasoning trace, gap→FAQ
- [x] index.html, app.js init + palette, appmode.js tile (19 tools), sw.js v11, style.css

## 5. Verify
- [x] node --check on every changed file
- [x] test/ladybug-brain.test.js — 150 assertions, all pass
- [x] app-shell.test.js updated to 19 tools + WABRAIN module
- [x] npm test — 384 assertions across 6 suites, all green
- [x] Live server smoke: brain GET/test/save/clear, 401 unauth, 404 missing bot, empty-profile rejection, FAQ retrieval fix confirmed

## 6. Docs
- [x] LADYBUG_BRAIN.md + README section
- [ ] Commit and push to GitHub main
