/* Ladybug Chat - chatbot flow engine (pure, no dependencies).
   ------------------------------------------------------------------
   A flow is a short scripted conversation: a trigger, then one or more steps. Each step
   can offer numbered options that jump to another step, so a flow behaves like a small
   decision tree ("1) Prices  2) Support  3) Talk to a human").

   This module is deliberately free of Baileys, Express and the platform store, because it
   runs in two places:
     - inside the bot process (utils/webBridge.js requires it as ./flow-engine), and
     - in the unit tests (test/wa-ai-flows.test.js requires it directly).

   Nothing here sends a message. It only decides what to say next, which keeps the WhatsApp
   side of things in one place and makes the logic testable without a phone. */

'use strict';

const MAX_FLOWS = 20;
const MAX_STEPS = 8;
const MAX_OPTIONS = 6;
const MAX_TEXT = 500;
const MAX_LABEL = 40;
const MAX_MATCH = 80;
const MAX_NAME = 60;
const SESSION_TTL_MS = 30 * 60_000; // a half-finished flow is forgotten after 30 quiet minutes

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(CONTROL, '').trim().slice(0, max);
}

function newId() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
}

/** 'next' | 'end' | 0-based step index. Anything else falls back to 'next'. */
function cleanGo(v, stepCount) {
  if (v === 'end') return 'end';
  if (v === 'next' || v == null || v === '') return 'next';
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return 'next';
  return n >= stepCount ? 'end' : n;
}

function normalizeStep(raw, stepCount) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text, MAX_TEXT);
  const options = [];
  if (Array.isArray(raw.options)) {
    for (const o of raw.options.slice(0, MAX_OPTIONS)) {
      if (!o || typeof o !== 'object') continue;
      const label = cleanText(o.label, MAX_LABEL);
      if (!label) continue;
      options.push({ label, go: cleanGo(o.go, stepCount) });
    }
  }
  // A step with no text and no options is useless; drop it rather than send an empty bubble.
  if (!text && !options.length) return null;
  return { text, options };
}

/** Validates and normalises a whole flow list. Never throws: bad entries are dropped. */
function normalize(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const f of list.slice(0, MAX_FLOWS)) {
    if (!f || typeof f !== 'object') continue;
    const name = cleanText(f.name, MAX_NAME) || 'Untitled flow';
    const match = cleanText(f.match, MAX_MATCH);
    const rawSteps = Array.isArray(f.steps) ? f.steps.slice(0, MAX_STEPS) : [];
    if (!rawSteps.length) continue;
    // Two passes: the step count is needed before options can be clamped to a valid target.
    const count = rawSteps.length;
    const steps = [];
    for (const s of rawSteps) {
      const step = normalizeStep(s, count);
      if (step) steps.push(step);
    }
    if (!steps.length) continue;
    if (!match && f.any !== true) continue; // a flow needs a trigger
    const key = (match || '*').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: /^[a-f0-9]{6,24}$/i.test(String(f.id || '')) ? String(f.id) : newId(),
      name,
      enabled: f.enabled !== false,
      match,
      exact: f.exact === true,
      any: f.any === true,
      cooldownMin: Math.max(0, Math.min(1440, Math.round(Number(f.cooldownMin) || 0))),
      steps,
    });
  }
  return out;
}

/** Which flow, if any, should answer this message. Explicit keywords win over "any message". */
function pick(flows, text) {
  const body = String(text == null ? '' : text).trim();
  if (!body || !Array.isArray(flows) || !flows.length) return null;
  const low = body.toLowerCase();
  let anyFlow = null;
  for (const f of flows) {
    if (!f || f.enabled === false) continue;
    if (f.any) { if (!anyFlow) anyFlow = f; continue; }
    if (!f.match) continue;
    const needle = String(f.match).toLowerCase();
    if (f.exact ? low === needle : low.includes(needle)) return f;
  }
  return anyFlow;
}

/** Renders one step as the text that actually goes out, with numbered options appended. */
function render(step) {
  if (!step) return '';
  const head = step.text || '';
  if (!step.options || !step.options.length) return head;
  const list = step.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
  return head ? `${head}\n\n${list}` : list;
}

function start(flow, now) {
  if (!flow || !flow.steps || !flow.steps.length) return null;
  return { flowId: flow.id, step: 0, at: now || Date.now() };
}

/** True when the session is still fresh enough to continue. */
function alive(session, now) {
  return !!(session && session.flowId && Number.isFinite(session.step) && (now || Date.now()) - session.at < SESSION_TTL_MS);
}

/**
 * Works out the next step from what the person typed.
 * Accepts "2", "2)" or the option label ("Prices"). Returns { reply, session, matched }.
 * `session` is null when the flow has finished, so the caller can forget it.
 */
function advance(flow, session, text, now) {
  const ts = now || Date.now();
  if (!flow || !session || !alive(session, ts)) return { reply: '', session: null, matched: false };
  const step = flow.steps[session.step];
  if (!step) return { reply: '', session: null, matched: false };

  const body = String(text == null ? '' : text).trim();
  const low = body.toLowerCase();
  const num = /^(\d{1,2})\s*[).:-]?$/.exec(body);
  let chosen = null;

  if (num) {
    const i = Number(num[1]) - 1;
    if (i >= 0 && i < step.options.length) chosen = step.options[i];
  }
  if (!chosen) {
    for (const o of step.options) {
      const label = o.label.toLowerCase();
      if (low === label || low.startsWith(label)) { chosen = o; break; }
    }
  }
  if (!chosen) return { reply: '', session, matched: false };

  const target = chosen.go === 'end' ? null : chosen.go === 'next' ? session.step + 1 : chosen.go;
  if (target == null || target >= flow.steps.length) return { reply: '', session: null, matched: true };

  const nextStep = flow.steps[target];
  // A step with no options is terminal: send it, then close the session so the chat is free again.
  const keep = nextStep.options.length > 0;
  return { reply: render(nextStep), session: keep ? { flowId: flow.id, step: target, at: ts } : null, matched: true };
}

module.exports = {
  MAX_FLOWS, MAX_STEPS, MAX_OPTIONS, MAX_TEXT, MAX_LABEL, MAX_MATCH, SESSION_TTL_MS,
  normalize, pick, render, start, advance, alive, cleanText, newId,
};
