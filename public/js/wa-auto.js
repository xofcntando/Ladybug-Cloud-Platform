/* Ladybug Chat - automation switches: always online, auto-view status, auto-save status.
   Settings are saved on the platform per linked number and re-applied every time the bot starts.
   Loaded before app.js; app.js calls WAAUTO.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BOLT = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M11 21h-1l1-7H7.500c-.6 0-.6-.3-.4-.7L13 3h1l-1 7h3.500c.5 0 .6.3.5.7z"/></svg>';
  const ITEMS = [
    { key: 'online', title: 'Always online', text: 'Keeps this number showing as Online, even when nobody is using it.', warn: 'While this is on, WhatsApp may stop notifying your phone about new messages, and contacts always see you online.' },
    { key: 'viewStatus', title: 'Auto-view status', text: 'Views your contacts\u2019 new statuses a few seconds after they post them.', warn: 'The poster only sees the view if read receipts are on (Profile > Privacy).' },
    { key: 'saveStatus', title: 'Auto-save status', text: 'Sends every new status (photo, video, text) to your own chat so you keep it after 24 hours.', warn: 'Uses the bot\u2019s status saver. Saved items arrive in the "Message yourself" chat.' },
  ];

  function open() {
    const d = C.dialog('<h3>Automation</h3><div class="chat-empty">Loading…</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-auto-dialog');
    let st = null;
    const draw = () => {
      box.innerHTML = `<div class="wa-gal-head"><h3>Automation</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        ${st.running ? '' : '<p class="wa-note bad">The bot is stopped. Changes are saved and apply the next time it starts.</p>'}
        ${ITEMS.map((it) => {
          const off = it.key === 'saveStatus' && st.saveSupported === false;
          return `<div class="wa-auto-row ${off ? 'disabled' : ''}"><div><b>${it.title}</b><small>${esc(it.text)}</small>${st[it.key] ? `<small class="warn">${esc(it.warn)}</small>` : ''}${off ? '<small class="warn">This bot version has no status saver.</small>' : ''}</div>
            <label class="wa-switch"><input type="checkbox" data-k="${it.key}" ${st[it.key] ? 'checked' : ''} ${off ? 'disabled' : ''}><i></i></label></div>`;
        }).join('')}
        <div class="wa-dialog-act"><button class="wa-btn" data-x>Done</button></div>`;
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      box.querySelectorAll('input[data-k]').forEach((cb) => {
        cb.onchange = async () => {
          const k = cb.dataset.k, v = cb.checked;
          cb.disabled = true;
          try {
            const r = await C.api(C.base + '/automation', { method: 'POST', body: { [k]: v } });
            st[k] = v;
            if (r.saveSupported === false) st.saveSupported = false;
            C.toast(r.applied ? (ITEMS.find((i) => i.key === k).title + (v ? ' is on' : ' is off')) : 'Saved. It applies when the bot starts.');
          } catch (e) { cb.checked = !v; C.toast(e.message, 'err'); }
          draw();
        };
      });
    };
    C.api(C.base + '/automation').then((r) => { st = r; draw(); }).catch((e) => { box.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`; });
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waAutoBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waAutoBtn'; b.title = 'Automation (always online, auto status)'; b.innerHTML = BOLT;
      b.onclick = open;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
  }

  window.WAAUTO = { init, open };
})();
