/* Ladybug Chat - Undo Send.
   WhatsApp has no way to pull a message back once it leaves. This holds every outgoing message for a
   few seconds first, shows it in the thread as a pending bubble with a countdown, and lets you cancel
   it - or send it immediately if you change your mind about waiting.

   The hold is entirely in the browser: nothing reaches the server until the timer runs out, so a
   cancelled message is never sent at all (rather than being sent and then deleted).

   Loaded before app.js; app.js calls WUNDO.init(ctx) and routes the composer through WUNDO.hold(). */
(function () {
  'use strict';

  let C = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const OPTIONS = [[0, 'Off — send immediately'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds']];
  const KEY = 'wa_undo_grace';

  const queue = []; // { uid, payload, reply, deadline, sent }
  let seq = 0;
  let ticker = null;

  const grace = () => {
    const v = parseInt(localStorage.getItem(KEY), 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(30, v)) : 5;
  };
  const setGrace = (n) => { try { localStorage.setItem(KEY, String(n)); } catch (e) { /* private mode */ } };

  /* ---------------------------------------------------------------- the queue */
  /** Returns true when the message was held (so the caller must not send it itself). */
  function hold(payload, reply) {
    const secs = grace();
    if (!secs) return false;
    const uid = 'p' + (++seq);
    const item = { uid, payload, reply, deadline: Date.now() + secs * 1000, sent: false };
    queue.push(item);
    startTicker();
    repaint();
    return true;
  }

  async function deliver(item) {
    if (item.sent) return;
    item.sent = true;
    try {
      await C.api(C.base + '/send', { method: 'POST', body: item.payload });
      C.toast('Sent');
    } catch (e) {
      // Put the text back in the composer so nothing is lost when the send fails.
      const ta = document.querySelector('#waText');
      if (ta && !ta.value.trim()) ta.value = item.payload.text || '';
      C.toast(e.message || 'Could not send', 'err');
    }
    drop(item.uid);
  }

  function drop(uid) {
    const i = queue.findIndex((x) => x.uid === uid);
    if (i >= 0) queue.splice(i, 1);
    if (!queue.length && ticker) { clearInterval(ticker); ticker = null; }
    repaint();
  }

  function cancel(uid) {
    const item = queue.find((x) => x.uid === uid);
    if (!item || item.sent) return;
    drop(uid);
    // Give the text back, so cancelling is never destructive.
    const ta = document.querySelector('#waText');
    if (ta && !ta.value.trim()) { ta.value = item.payload.text || ''; ta.focus(); }
    C.toast('Message cancelled — nothing was sent');
  }

  function sendNow(uid) {
    const item = queue.find((x) => x.uid === uid);
    if (item) deliver(item);
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      if (!queue.length) { clearInterval(ticker); ticker = null; return; }
      const now = Date.now();
      for (const item of queue.slice()) {
        if (!item.sent && now >= item.deadline) deliver(item);
      }
      paintCountdowns();
    }, 200);
  }

  /* ---------------------------------------------------------------- rendering */
  /** Pending bubbles live outside paintThread's innerHTML, so they are re-appended after every repaint. */
  function afterPaint(t) {
    if (!t || !queue.length) return;
    const mine = queue.filter((x) => x.payload.jid === C.S.jid);
    if (!mine.length) return;
    for (const item of mine) {
      const el = document.createElement('div');
      el.className = 'wa-msg me wa-pending';
      el.dataset.pending = item.uid;
      const left = Math.max(0, Math.ceil((item.deadline - Date.now()) / 1000));
      el.innerHTML = `<div class="wa-pend-head">
          <span class="wa-pend-dot"></span>Waiting ${left}s
        </div>
        ${item.reply ? `<div class="wa-pend-quote">${esc(String(item.reply.text || '').slice(0, 120))}</div>` : ''}
        <div class="wa-pend-text">${esc(item.payload.text || '')}</div>
        <div class="wa-pend-act">
          <button class="wa-pend-btn" data-now>Send now</button>
          <button class="wa-pend-btn danger" data-cancel>Cancel</button>
        </div>`;
      el.querySelector('[data-cancel]').onclick = (e) => { e.stopPropagation(); cancel(item.uid); };
      el.querySelector('[data-now]').onclick = (e) => { e.stopPropagation(); sendNow(item.uid); };
      t.appendChild(el);
    }
    t.scrollTop = t.scrollHeight;
  }

  /** Cheap in-place countdown update so the number ticks without a full repaint. */
  function paintCountdowns() {
    const nodes = document.querySelectorAll('.wa-pending[data-pending]');
    if (!nodes.length) return;
    const now = Date.now();
    nodes.forEach((el) => {
      const item = queue.find((x) => x.uid === el.dataset.pending);
      if (!item) { el.remove(); return; }
      const head = el.querySelector('.wa-pend-head');
      const left = Math.max(0, Math.ceil((item.deadline - now) / 1000));
      if (head) head.innerHTML = `<span class="wa-pend-dot"></span>Waiting ${left}s`;
    });
  }

  function repaint() {
    if (C && C.paintThread) C.paintThread(true);
  }

  /* ---------------------------------------------------------------- settings row */
  function decorateProfile(root) {
    if (!root || root.querySelector('#waUndoGrace')) return;
    const body = root.querySelector('.wa-prof-body');
    if (!body) return;
    const sec = document.createElement('div');
    sec.innerHTML = `<h4 class="wa-sec">Undo Send</h4>
      <label class="wa-set-row"><span>Hold outgoing messages</span>
        <select id="waUndoGrace">${OPTIONS.map(([v, t]) => `<option value="${v}" ${v === grace() ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
      <p class="wa-note" style="padding:0 24px">Messages wait here before they are sent, so you can pull one back. Nothing leaves your browser until the countdown ends.</p>`;
    const blocked = body.querySelector('.wa-sec');
    if (blocked) blocked.before(sec); else body.appendChild(sec);
    sec.querySelector('#waUndoGrace').onchange = (e) => {
      setGrace(Number(e.target.value));
      C.toast(Number(e.target.value) ? 'Messages will be held for ' + e.target.value + ' seconds' : 'Undo Send is off');
    };
  }

  function init(ctx) { C = ctx; }

  window.WUNDO = { init, hold, afterPaint, decorateProfile, grace, setGrace, pending: () => queue.length };
})();
