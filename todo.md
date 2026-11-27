# Ladybug Brain upgrade — todo

## Engine (lib/bot-shims/ladybug-brain.js)
- [x] Add language detection (Shona/Ndebele) + localized phrase packs
- [x] Add name & quantity entity extraction
- [x] Add zero-setup intents (small talk, quote, invoice, payment, cancel, reschedule, warranty, careers, emergency, social, repeat order, feedback)
- [x] Add session memory (visits, name, auto-captured order ref, topics)
- [x] Add escalation recap + synonym-boosted retrieval fallback
- [x] Update capabilities text and exports

## Mirror & wire
- [x] Copy engine to bots/ladybug/utils/ladybug-brain.js
- [x] Verify runtime bridge still compatible

## Tests & docs
- [x] Extend test/ladybug-brain.test.js with new-feature assertions
- [x] Run full brain test suite (228 pass; existing 156 stay green)
- [x] Update LADYBUG_BRAIN.md + README
- [x] Final verification (syntax, identical copies, full npm test)
