/* Ladybug Chat — auto-translate chats.
   Per-chat automatic translation of incoming messages, plus a one-click "translate this
   chat" action. Uses the platform's existing /translate endpoint (Google -> MyMemory
   ladder, cached for an hour), so the bot's number never talks to a translation service.
   Loaded before app.js; app.js calls WATR.init(ctx) once the console is on screen. */
(function () {
  'use strict';

  let C = null;
  let cfg = { to: 'en', auto: {} };
  let key = null;
  const cache = new Map(); // message id -> translated text
  const queue = [];
  let busy = false;

  const LANGS = [
    ['en', 'English'], ['sw', 'Swahili'], ['fr', 'French'], ['es', 'Spanish'], ['pt', 'Portuguese'],
    ['ar', 'Arabic'], ['hi', 'Hindi'], ['zh-CN', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
    ['de', 'German'], ['it', 'Italian'], ['ru', 'Russian'], ['tr', 'Turkish'], ['id', 'Indonesian'],
    ['nl', 'Dutch'], ['pl', 'Polish'], ['vi', 'Vietnamese'], ['th', 'Thai'], ['af', 'Afrikaans'],
  ];
  const LANG_NAME = Object.fromEntries(LANGS);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12.9 15.1 10 12.2l.1-.1a15 15 0 0 0 3.2-5.1H16V5h-6V3H8v2H2v2h9.6A13 13 0 0 1 9 11.4 13 13 0 0 1 6.6 9H4.5a15 15 0 0 0 3.1 3.2L3.2 16.6 4.6 18l4.4-4.4 2.7 2.7.2-1.2zM18.5 10h-2L13 21h2l.8-2.5h4.4L21 21h2l-4.5-11zm-2.1 6.5L18 12l1.6 4.5h-3.2z"/></svg>';

  function load() {
    try { cfg = Object.assign({ to: 'en', auto: {} }, JSON.parse(localStorage.getItem(key) || '{}')); } catch (e) { cfg = { to: 'en', auto: {} }; }
    if (!LANG_NAME[cfg.to]) cfg.to = 'en';
    if (!cfg.auto || typeof cfg.auto !== 'object') cfg.auto = {};
  }
  function save() { try { localStorage.setItem(key, JSON.stringify(cfg)); } catch (e) { /* storage blocked */ } }

  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }
  const chatName = (jid) => (C.S.chats.find((c) => c.jid === jid) || {}).name || String(jid || '').split('@')[0];

  /* ---------------------------------------------------------------- translation queue */
  function enqueue(m, el, force) {
    if (!m || !m.text || m.type !== 'text' || m.fromMe) return;
    if (cache.has(m.id)) return paint(m, el);
    if (el.dataset.watQueued === '1' || el.dataset.watDone === '1') return;
    if (!force && !cfg.auto[C.S.jid]) return;
    el.dataset.watQueued = '1';
    queue.push({ m, el, jid: C.S.jid });
    pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      if (!job.el.isConnected) continue;
      try {
        const r = await C.api(C.base + '/translate', { method: 'POST', body: { text: job.m.text.slice(0, 4000), to: cfg.to } });
        if (r && r.text) {
          cache.set(job.m.id, r.text);
          paint(job.m, job.el, r.text);
        }
      } catch (e) {
        job.el.dataset.watErr = '1';
      }
      job.el.dataset.watQueued = '0';
      await new Promise((res) => setTimeout(res, 260));
    }
    busy = false;
  }

  function paint(m, el, text) {
    if (!el || !el.isConnected) return;
    const tr = text || cache.get(m.id);
    if (!tr) return;
    let box = el.querySelector('.wat-tr');
    if (!box) {
      box = document.createElement('div');
      box.className = 'wat-tr';
      el.appendChild(box);
    }
    box.innerHTML = `<span class="wat-lang">${esc(LANG_NAME[cfg.to] || cfg.to)}</span>${esc(tr)}`;
    el.dataset.watDone = '1';
    el.classList.add('wat-has');
  }

  function decorateThread(root) {
    if (!root || !C || !C.S.jid) return;
    if (!cfg.auto[C.S.jid]) return;
    const list = root.querySelectorAll('.wa-msg.them[data-id]');
    let n = 0;
    for (const el of list) {
      if (n++ > 25) break; // only the visible tail, to stay gentle with the translator
      const m = C.S.msgs.find((x) => x.id === el.dataset.id);
      if (!m || !m.text || m.type !== 'text' || m.deleted) continue;
      if (el.dataset.watDone === '1' || el.dataset.watErr === '1') continue;
      enqueue(m, el, false);
    }
  }

  function translateChat() {
    const jid = C.S.jid;
    if (!jid) return C.toast('Open a chat first', 'err');
    const root = document.querySelector('#waThread');
    if (!root) return;
    let n = 0;
    root.querySelectorAll('.wa-msg.them[data-id]').forEach((el) => {
      const m = C.S.msgs.find((x) => x.id === el.dataset.id);
      if (!m || !m.text || m.type !== 'text' || m.deleted) return;
      el.dataset.watErr = '0';
      enqueue(m, el, true); n++;
    });
    C.toast(n ? `Translating ${n} message${n === 1 ? '' : 's'} to ${LANG_NAME[cfg.to] || cfg.to}…` : 'Nothing to translate here');
  }

  /* ---------------------------------------------------------------- panel */
  function openPanel() {
    const jid = C.S.jid;
    const d = dlg('<h3>Auto-translate</h3><div class="chat-empty">Loading…</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-gal-dialog', 'wat-wide');

    const draw = () => {
      const autoOn = !!(jid && cfg.auto[jid]);
      const autoChats = Object.keys(cfg.auto).filter((j) => cfg.auto[j]);
      box.innerHTML = `<div class="wa-gal-head"><h3>Auto-translate</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <p class="wa-note">Incoming messages are translated by the platform and shown under the original. The bot's number never contacts a translation service. Results are cached for an hour.</p>
        <label class="wac-label">Translate into</label>
        <select class="wa-dialog-input" id="watLang">${LANGS.map(([c, n]) => `<option value="${c}" ${c === cfg.to ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <label class="wat-switch"><input type="checkbox" id="watAuto" ${autoOn ? 'checked' : ''} ${jid ? '' : 'disabled'} /><span>Translate incoming messages automatically in <b>${esc(jid ? chatName(jid) : 'this chat')}</b></span></label>
        <div class="wat-actions"><button class="wa-btn" id="watNow" ${jid ? '' : 'disabled'}>Translate this chat now</button></div>
        <h4 class="wac-sub">Chats with auto-translate <i>${autoChats.length}</i></h4>
        <div class="wat-list">${autoChats.length ? autoChats.map((j) => `<div class="wat-row"><span>${esc(chatName(j))}</span><button class="wa-btn ghost" data-off="${esc(j)}">Turn off</button></div>`).join('') : '<div class="wad-empty">None yet. Turn it on for a chat you read in another language.</div>'}</div>
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Done</button></div>`;
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      box.querySelector('#watLang').onchange = (e) => {
        cfg.to = e.target.value; save();
        document.querySelectorAll('.wat-tr').forEach((n) => n.remove());
        document.querySelectorAll('.wa-msg[data-id]').forEach((n) => { n.dataset.watDone = '0'; n.dataset.watErr = '0'; });
        draw();
        if (jid && cfg.auto[jid]) { C.toast('Language set to ' + (LANG_NAME[cfg.to] || cfg.to)); decorateThread(document.querySelector('#waThread')); }
      };
      const auto = box.querySelector('#watAuto');
      if (auto) auto.onchange = () => {
        if (!jid) return;
        if (auto.checked) cfg.auto[jid] = true; else delete cfg.auto[jid];
        save(); draw();
        if (auto.checked) decorateThread(document.querySelector('#waThread'));
      };
      const now = box.querySelector('#watNow');
      if (now) now.onclick = () => { translateChat(); d.remove(); };
      box.querySelectorAll('[data-off]').forEach((b) => {
        b.onclick = () => { delete cfg.auto[b.dataset.off]; save(); draw(); };
      });
    };
    draw();
  }

  function init(ctx) {
    C = ctx;
    key = 'wa_tr_' + (ctx.bot && ctx.bot.id ? ctx.bot.id : 'anon');
    load();
    const rail = document.querySelector('.wa-rail');
    const grow = rail && rail.querySelector('.wa-rail-grow');
    if (rail && grow && !document.getElementById('watBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'watBtn'; b.title = 'Auto-translate chats'; b.innerHTML = ICON;
      b.onclick = openPanel;
      rail.insertBefore(b, grow);
    }
    if (window.WAX) {
      const after = WAX.afterPaint;
      WAX.afterPaint = function (root) {
        try { if (typeof after === 'function') after(root); } catch (e) { /* keep going */ }
        try { decorateThread(root || document.querySelector('#waThread')); } catch (e) { /* optional */ }
      };
    }
  }

  window.WATR = { init, open: openPanel, translateChat, decorateThread, getConfig: () => cfg };
})();
