/* Ladybug Chat - advanced features that stock WhatsApp Web does not have.
   ---------------------------------------------------------------------
   1. Anti-delete   : messages other people deleted for everyone, with the original text kept.
   2. Analytics     : conversation volume, hour/weekday heatmap, media mix, reply time.
   3. Broadcast     : send one message to many chats, paced so the number stays safe.
   4. Undo send     : a few seconds to take back a message after sending it.
   5. Translate     : translate an incoming message inline.

   Loaded before app.js; app.js calls WAPRO.init(ctx) once the console is on screen. */
(function () {
  'use strict';

  let C = null; // console context handed over by app.js
  let ES = null; // temporary live stream while the anti-delete panel is open

  /* Only one advanced panel at a time: the console's own dialogs stack, and four of them
     on top of each other is a mess. Close whatever is open before showing a new one. */
  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    shield: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2 4 5v6.1c0 4.9 3.4 9.5 8 10.9 4.6-1.4 8-6 8-10.9V5zm-1.2 14.2-3.5-3.5 1.4-1.4 2.1 2.1 4.6-4.6 1.4 1.4z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 20h16v2H4zM6 10h3v8H6zm5-6h3v14h-3zm5 4h3v10h-3z"/></svg>',
    megaphone: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 10v4a1 1 0 0 0 1 1h2l4 4V5L6 9H4a1 1 0 0 0-1 1m12-3.5v11a5.5 5.5 0 0 0 0-11M17 3v18a9 9 0 0 0 0-18"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12.5 8c-2.6 0-5 1-6.8 2.6L3 8v7h7l-2.9-2.9A7.5 7.5 0 0 1 12.5 10a7.5 7.5 0 0 1 7.4 6.3l2-.4A9.5 9.5 0 0 0 12.5 8"/></svg>',
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const when = (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const dur = (s) => {
    if (s == null) return '-';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  };

  /* ------------------------------------------------------------------ 1. anti-delete */

  function deletedDialog() {
    const d = dlg('<h3>Deleted messages</h3><div class="chat-empty">Loading...</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-gal-dialog', 'wap-wide');

    const rowHtml = (m) => `<div class="wap-del" data-jid="${esc(m.jid)}">
      <div class="wap-del-top"><b>${esc(m.chatName || m.jid)}</b><small>${esc(m.senderName || (m.fromMe ? 'You' : '+' + String(m.sender || '').replace(/\D/g, '')))} &middot; sent ${esc(when(m.ts))} &middot; deleted ${esc(when(m.deletedAt))}</small></div>
      <div class="wap-del-body">${m.media ? `<span class="wap-tag">${esc(m.media.mime ? m.media.mime.split('/')[0] : 'media')}</span>` : ''}${m.text ? esc(m.text) : '<i class="wap-muted">' + esc(m.type || 'message') + (m.media && m.media.name ? ' - ' + esc(m.media.name) : '') + '</i>'}</div>
      ${m.quoted && m.quoted.text ? `<div class="wap-quote">replying to: ${esc(m.quoted.text)}</div>` : ''}
    </div>`;

    const draw = (r) => {
      const items = (r && r.items) || [];
      box.innerHTML = `<div class="wa-gal-head"><h3>Deleted messages <i class="wap-count">${items.length}</i></h3><button class="wa-icon-btn" data-x title="Close">&#10005;</button></div>
        <p class="wa-note">Messages other people removed with "delete for everyone". The text was kept by this bot before WhatsApp erased it. Nothing is written to disk.</p>
        <div class="wa-gal-body">${items.length ? items.map(rowHtml).join('') : '<div class="chat-empty">Nothing recovered yet. Deleted messages appear here as they happen.</div>'}</div>
        <div class="wa-dialog-act">${items.length ? '<button class="wa-btn ghost" data-clear>Clear all</button>' : ''}<button class="wa-btn" data-x>Done</button></div>`;

      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { closeStream(); d.remove(); }; });
      const clr = box.querySelector('[data-clear]');
      if (clr) clr.onclick = async () => {
        if (!confirm('Clear every recovered message? This cannot be undone.')) return;
        try { await C.api(C.base + '/deleted/clear', { method: 'POST', body: {} }); C.toast('Cleared'); draw({ items: [] }); }
        catch (e) { C.toast(e.message, 'err'); }
      };
      box.querySelectorAll('[data-jid]').forEach((el) => {
        el.onclick = () => { closeStream(); d.remove(); C.openChat(el.dataset.jid); };
      });
    };

    const load = () => C.api(C.base + '/deleted?limit=300').then(draw).catch((e) => {
      box.innerHTML = `<div class="wa-gal-head"><h3>Deleted messages</h3><button class="wa-icon-btn" data-x>&#10005;</button></div><div class="chat-empty">${esc(e.message)}</div>`;
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { closeStream(); d.remove(); }; });
    });

    // live: new deletions show up while the panel is open
    closeStream();
    try {
      ES = new EventSource(C.base + '/stream');
      ES.addEventListener('deleted', load);
    } catch (e) { /* stream is optional */ }

    load();
  }

  function closeStream() { if (ES) { try { ES.close(); } catch (e) { /* gone */ } ES = null; } }

  /* ------------------------------------------------------------------ 2. analytics */

  function analyticsDialog() {
    const d = dlg('<h3>Analytics</h3><div class="chat-empty">Loading...</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-gal-dialog', 'wap-wide');
    let span = 7;

    const bars = (timeline) => {
      const max = Math.max(1, ...timeline.map((t) => t.total));
      return `<div class="wap-bars">${timeline.map((t) => {
        const h = Math.round((t.total / max) * 100);
        const outH = t.total ? Math.round((t.out / t.total) * h) : 0;
        return `<div class="wap-bar" title="${esc(t.day)}: ${t.total} messages"><i style="height:${h}%"><b style="height:${outH}%"></b></i><span>${esc(t.day.slice(8))}</span></div>`;
      }).join('')}</div>`;
    };

    const heat = (hours) => {
      const max = Math.max(1, ...hours);
      return `<div class="wap-heat">${hours.map((v, h) => {
        const a = v ? 0.15 + (v / max) * 0.85 : 0;
        return `<div class="wap-cell" style="background:rgba(0,168,132,${a.toFixed(2)})" title="${pad2(h)}:00 - ${v} messages"><span>${pad2(h)}</span></div>`;
      }).join('')}</div>`;
    };

    const week = (wd) => {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const max = Math.max(1, ...wd);
      return `<div class="wap-week">${wd.map((v, i) => `<div class="wap-wrow"><span>${names[i]}</span><i><b style="width:${Math.round((v / max) * 100)}%"></b></i><em>${v}</em></div>`).join('')}</div>`;
    };

    const media = (m) => {
      const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
      return `<div class="wap-media">${Object.entries(m).filter(([, v]) => v).map(([k, v]) => `<div class="wap-mrow"><span>${esc(k)}</span><i><b style="width:${Math.round((v / total) * 100)}%"></b></i><em>${v}</em></div>`).join('') || '<div class="wap-muted">No media in this period</div>'}</div>`;
    };

    const draw = (r) => {
      box.innerHTML = `<div class="wa-gal-head"><h3>Analytics</h3><button class="wa-icon-btn" data-x title="Close">&#10005;</button></div>
        <div class="wa-gal-tabs">${[7, 30, 90].map((n) => `<button data-span="${n}" class="${n === span ? 'on' : ''}">${n} days</button>`).join('')}</div>
        <div class="wa-gal-body">
          <div class="wap-kpis">
            <div class="wap-kpi"><b>${r.total}</b><span>messages</span></div>
            <div class="wap-kpi"><b>${r.incoming}</b><span>received</span></div>
            <div class="wap-kpi"><b>${r.outgoing}</b><span>sent</span></div>
            <div class="wap-kpi"><b>${r.chats}</b><span>chats (${r.groups} groups)</span></div>
            <div class="wap-kpi"><b>${dur(r.avgReplySec)}</b><span>avg reply</span></div>
            <div class="wap-kpi"><b>${r.peakHour == null ? '-' : pad2(r.peakHour) + ':00'}</b><span>busiest hour</span></div>
          </div>
          <h4 class="wap-h4">Volume <small>sent vs received per day</small></h4>
          ${bars(r.timeline)}
          <h4 class="wap-h4">By hour of day <small>local time</small></h4>
          ${heat(r.hours)}
          <h4 class="wap-h4">By weekday</h4>
          ${week(r.weekdays)}
          <h4 class="wap-h4">Media mix</h4>
          ${media(r.media)}
          <h4 class="wap-h4">Most active chats</h4>
          <div class="wap-top">${r.top.map((t) => `<div class="wap-trow"><b>${esc(t.name)}</b><small>${t.total} messages &middot; ${t.in} in / ${t.out} out</small></div>`).join('') || '<div class="wap-muted">No messages in this period</div>'}</div>
          <p class="wa-note">Computed inside the bot process from the messages it still holds in memory. Nothing is uploaded anywhere.</p>
        </div>
        <div class="wa-dialog-act"><button class="wa-btn" data-x>Done</button></div>`;

      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      box.querySelectorAll('[data-span]').forEach((b) => {
        b.onclick = () => { span = Number(b.dataset.span); load(); };
      });
    };

    const load = () => C.api(C.base + '/analytics?days=' + span).then(draw).catch((e) => {
      box.innerHTML = `<div class="wa-gal-head"><h3>Analytics</h3><button class="wa-icon-btn" data-x>&#10005;</button></div><div class="chat-empty">${esc(e.message)}</div>`;
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
    });

    load();
  }

  /* ------------------------------------------------------------------ 3. broadcast */

  function broadcastDialog() {
    const d = dlg(`<h3>Broadcast</h3>
      <p class="wa-note">Send one message to several chats. Messages go out one at a time, spaced out, because sending too fast is the most common reason WhatsApp restricts a number.</p>
      <input class="wa-dialog-input" id="wapBcQ" placeholder="Search chats">
      <div class="wa-fwd-list" id="wapBcList"></div>
      <textarea id="wapBcText" rows="3" maxlength="4096" placeholder="Message to send"></textarea>
      <div class="wap-bcrow"><label>Gap between messages <select id="wapBcGap"><option value="4">4 seconds (safest)</option><option value="8">8 seconds</option><option value="15">15 seconds</option></select></label></div>
      <div class="wap-progress" id="wapBcProg" hidden><i></i><span></span></div>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-go>Send</button></div>`);
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wap-wide');

    const picked = new Set();
    let stop = false, running = false;

    const list = () => {
      const q = (box.querySelector('#wapBcQ').value || '').toLowerCase();
      const chats = C.S.chats.filter((c) => !q || String(c.name || '').toLowerCase().includes(q)).slice(0, 80);
      box.querySelector('#wapBcList').innerHTML = chats.map((c) => `<label class="wap-pick"><input type="checkbox" data-jid="${esc(c.jid)}" ${picked.has(c.jid) ? 'checked' : ''}><span>${esc(c.name || c.jid)}</span>${c.isGroup ? '<i class="wap-tag">group</i>' : ''}</label>`).join('') || '<div class="chat-empty">No chats</div>';
      box.querySelectorAll('[data-jid]').forEach((cb) => {
        cb.onchange = () => { if (cb.checked) picked.add(cb.dataset.jid); else picked.delete(cb.dataset.jid); };
      });
    };
    list();
    box.querySelector('#wapBcQ').oninput = list;
    box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { stop = true; if (!running) d.remove(); }; });

    box.querySelector('[data-go]').onclick = async () => {
      if (running) return;
      const text = box.querySelector('#wapBcText').value.trim();
      if (!text) return C.toast('Type a message first', 'err');
      if (!picked.size) return C.toast('Pick at least one chat', 'err');
      if (!confirm(`Send this message to ${picked.size} chat(s)?`)) return;

      running = true; stop = false;
      const gap = Number(box.querySelector('#wapBcGap').value) * 1000;
      const prog = box.querySelector('#wapBcProg');
      const bar = prog.querySelector('i'), lbl = prog.querySelector('span');
      prog.hidden = false;
      const targets = [...picked];
      let ok = 0, failed = 0;

      for (let i = 0; i < targets.length; i++) {
        if (stop) break;
        const jid = targets[i];
        lbl.textContent = `${i + 1} of ${targets.length} - sending`;
        bar.style.width = Math.round((i / targets.length) * 100) + '%';
        try { await C.api(C.base + '/send', { method: 'POST', body: { jid, text } }); ok++; }
        catch (e) { failed++; }
        bar.style.width = Math.round(((i + 1) / targets.length) * 100) + '%';
        if (i < targets.length - 1 && !stop) await new Promise((r) => setTimeout(r, gap));
      }

      running = false;
      lbl.textContent = `${stop ? 'Stopped' : 'Done'} - ${ok} sent${failed ? ', ' + failed + ' failed' : ''}`;
      C.toast(`Broadcast: ${ok} sent${failed ? ', ' + failed + ' failed' : ''}`);
      setTimeout(() => { if (!running) d.remove(); }, 1200);
    };
  }

  /* ------------------------------------------------------------------ 4. undo send */

  let undoTimer = null;

  function undoOffer(jid, id, text) {
    const old = document.getElementById('wapUndo');
    if (old) old.remove();
    clearTimeout(undoTimer);

    const bar = document.createElement('div');
    bar.id = 'wapUndo';
    bar.className = 'wap-undo';
    bar.innerHTML = `<span>Message sent</span><button data-u>${ICON.undo} Undo</button>`;
    (C.$('#waApp') || document.body).appendChild(bar);

    const close = () => { clearTimeout(undoTimer); bar.remove(); };
    bar.querySelector('[data-u]').onclick = async () => {
      close();
      try {
        await C.api(C.base + '/delete', { method: 'POST', body: { jid, id } });
        const m = C.S.msgs.find((x) => x.id === id);
        if (m) { m.deleted = true; m.text = ''; }
        C.paintThread(false);
        C.toast('Message deleted for everyone');
      } catch (e) { C.toast(e.message, 'err'); }
    };
    undoTimer = setTimeout(close, 7000);
  }

  /** Replace the composer submit so we learn the id of what we just sent (needed for undo). */
  function hookSend() {
    const form = C.$('#waForm');
    if (!form || form.dataset.wapHook) return;
    form.dataset.wapHook = '1';
    form.onsubmit = async (e) => {
      e.preventDefault();
      const ta = C.$('#waText');
      const raw = ta.value.trim();
      if (!raw || !C.S.jid) return;
      const prep = window.WAX ? WAX.prepareSend(raw) : { text: raw };
      const jid = C.S.jid;
      ta.disabled = true;
      try {
        const r = await C.api(C.base + '/send', {
          method: 'POST',
          body: { jid, text: prep.text, mentions: prep.mentions, quotedId: C.S.replyTo ? C.S.replyTo.id : undefined },
        });
        ta.value = '';
        C.setReply(null);
        if (r && r.id) undoOffer(jid, r.id, prep.text);
      } catch (er) { C.toast(er.message, 'err'); }
      ta.disabled = false; ta.focus();
    };
  }

  /* ------------------------------------------------------------------ 5. translate */

  function translateBubble(m) {
    const d = dlg(`<h3>Translate</h3><div class="wap-tr-src">${esc(m.text)}</div>
      <div class="wap-bcrow"><label>To <select id="wapTrTo">
        <option value="en">English</option><option value="sw">Swahili</option><option value="fr">French</option>
        <option value="es">Spanish</option><option value="pt">Portuguese</option><option value="ar">Arabic</option>
        <option value="hi">Hindi</option><option value="zh-CN">Chinese</option><option value="de">German</option>
      </select></label></div>
      <div class="wap-tr-out" id="wapTrOut"><div class="chat-empty">Translating...</div></div>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Close</button><button class="wa-btn" data-copy>Copy</button></div>`);
    const out = d.querySelector('#wapTrOut');
    const sel = d.querySelector('#wapTrTo');
    d.querySelector('[data-x]').onclick = () => d.remove();

    const run = async () => {
      out.innerHTML = '<div class="chat-empty">Translating...</div>';
      try {
        const r = await C.api(C.base + '/translate', { method: 'POST', body: { text: m.text, to: sel.value } });
        out.innerHTML = `<div class="wap-tr-text">${esc(r.text)}</div>${r.detected ? `<small class="wap-muted">detected: ${esc(r.detected)}</small>` : ''}`;
        d.querySelector('[data-copy]').onclick = () => {
          try { navigator.clipboard.writeText(r.text); C.toast('Copied'); } catch (e) { C.toast('Could not copy', 'err'); }
        };
      } catch (e) { out.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`; }
    };
    sel.onchange = run;
    run();
  }

  /** Add a small translate button to incoming text bubbles. */
  function decorateThread(root) {
    if (!root) return;
    root.querySelectorAll('.wa-msg.them').forEach((el) => {
      if (el.dataset.wapTr) return;
      const id = el.dataset.id || el.getAttribute('data-id');
      const m = C.S.msgs.find((x) => x.id === id);
      if (!m || !m.text || m.deleted || m.type !== 'text') return;
      el.dataset.wapTr = '1';
      const b = document.createElement('button');
      b.className = 'wap-tr-btn';
      b.title = 'Translate this message';
      b.textContent = 'A\u6587';
      b.onclick = (ev) => { ev.stopPropagation(); translateBubble(m); };
      el.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ wiring */

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    const grow = rail && rail.querySelector('.wa-rail-grow');
    if (rail && grow && !document.getElementById('wapDelBtn')) {
      const mk = (id, icon, title, fn) => {
        const b = document.createElement('button');
        b.className = 'wa-rail-btn'; b.id = id; b.title = title; b.innerHTML = icon; b.onclick = fn;
        rail.insertBefore(b, grow);
        return b;
      };
      mk('wapDelBtn', ICON.shield, 'Deleted messages (anti-delete)', deletedDialog);
      mk('wapAnBtn', ICON.chart, 'Analytics', analyticsDialog);
      mk('wapBcBtn', ICON.megaphone, 'Broadcast', broadcastDialog);
    }

    hookSend();

    // chain into the console's own thread hooks
    if (window.WAX) {
      const after = WAX.afterPaint;
      WAX.afterPaint = function (root) {
        try { if (typeof after === 'function') after(root); } catch (e) { /* keep going */ }
        try { decorateThread(root || C.$('#waThread')); } catch (e) { /* optional */ }
      };
      const before = WAX.beforeOpen;
      WAX.beforeOpen = function (jid) {
        closeStream();
        try { if (typeof before === 'function') before(jid); } catch (e) { /* keep going */ }
      };
    }

    window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/web')) closeStream(); });
  }

  window.WAPRO = { init, openDeleted: deletedDialog, openAnalytics: analyticsDialog, openBroadcast: broadcastDialog };
})();
