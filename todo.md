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
