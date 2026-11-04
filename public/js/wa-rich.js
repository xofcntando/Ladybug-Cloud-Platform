/* Ladybug Chat - rich messages.
   Reply quotes, emoji reactions, polls, locations, contact cards, link previews,
   attach menu (poll / location / contact), jump-to-latest button and swipe-to-reply.
   Loaded before app.js; app.js calls WARICH.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null; // console context from app.js
  const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
  const TYPE_NAME = { image: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', document: 'Document', sticker: 'Sticker', contact: 'Contact', location: 'Location', poll: 'Poll' };

  /* ---------------------------------------------------------------- bubble parts */
  function quoteHtml(m) {
    const q = m.quoted;
    if (!q) return '';
    const who = q.mine ? 'You' : (C.S.chat && C.S.chat.isGroup ? '+' + esc(q.sender) : esc((C.S.chat && C.S.chat.name) || '+' + q.sender));
    const body = q.text ? esc(q.text) : esc(TYPE_NAME[q.type] || 'Message');
    return `<div class="wa-quote ${q.mine ? 'mine' : ''}" data-jump="${esc(q.id)}"><b>${who}</b><span>${q.text ? '' : '<i>'}${body}${q.text ? '' : '</i>'}</span></div>`;
  }

  function locationHtml(m) {
    const l = m.location;
    if (!l) return '';
    const ll = `${l.lat.toFixed(6)},${l.lng.toFixed(6)}`;
    const osm = `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=16/${l.lat}/${l.lng}`;
    const gm = `https://www.google.com/maps?q=${ll}`;
    return `<div class="wa-card wa-loc"><div class="wa-loc-pin">📍</div><div class="wa-card-body"><b>${esc(l.name || (l.live ? 'Live location' : 'Location'))}</b>${l.address ? `<small>${esc(l.address)}</small>` : ''}<small>${esc(ll)}</small><div class="wa-card-links"><a href="${esc(osm)}" target="_blank" rel="noopener noreferrer">OpenStreetMap</a><a href="${esc(gm)}" target="_blank" rel="noopener noreferrer">Google Maps</a></div></div></div>`;
  }

  function contactHtml(m) {
    const list = m.contacts && m.contacts.length ? m.contacts : (m.contact ? [m.contact] : []);
    if (!list.length) return '';
    return list.map((c) => {
      const name = c.name || c.display || 'Contact';
      const ph = (c.phones || []).map((p) => `<small>${esc(p)}</small>`).join('');
      const first = (c.phones || [])[0];
      const act = first ? `<button class="wa-card-btn" data-chatnum="${esc(String(first).replace(/\D/g, ''))}">Message</button>` : '';
      return `<div class="wa-card wa-contact"><div class="wa-contact-av">${esc(name.charAt(0).toUpperCase())}</div><div class="wa-card-body"><b>${esc(name)}</b>${ph}${act}</div></div>`;
    }).join('');
  }

  function pollHtml(m) {
    const p = m.poll;
    if (!p) return '';
    return `<div class="wa-card wa-poll"><b>📊 ${esc(p.name)}</b><small>${p.multi ? 'Select one or more' : 'Select one'}</small>${p.options.map((o) => `<div class="wa-poll-opt"><span class="${p.multi ? 'sq' : 'ci'}"></span>${esc(o)}</div>`).join('')}<small class="wa-poll-foot">Votes are cast and counted in the WhatsApp app</small></div>`;
  }

  function linkHtml(m) {
    const k = m.link;
    const url = k && safeUrl(k.url);
    if (!url) return '';
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
    return `<a class="wa-card wa-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${k.thumb ? `<img src="${esc(k.thumb)}" alt="">` : ''}<div class="wa-card-body"><b>${esc(k.title || host)}</b>${k.desc ? `<small>${esc(k.desc)}</small>` : ''}<small class="host">${esc(host)}</small></div></a>`;
  }

  function reactionsHtml(m) {
    const r = m.reactions;
    if (!r) return '';
    const by = {};
    for (const [who, e] of Object.entries(r)) { (by[e] = by[e] || []).push(who); }
    const chips = Object.entries(by).map(([e, who]) => `<button class="wa-react ${who.includes('me') ? 'mine' : ''}" data-react="${esc(e)}" data-rid="${esc(m.id)}" title="${who.length} reaction${who.length > 1 ? 's' : ''}">${esc(e)}${who.length > 1 ? `<i>${who.length}</i>` : ''}</button>`).join('');
    return chips ? `<div class="wa-reacts">${chips}</div>` : '';
  }

  /** Everything the bubble needs beyond text and media. */
  function parts(m) {
    const rich = m.type === 'poll' ? pollHtml(m) : m.type === 'location' ? locationHtml(m) : m.type === 'contact' ? contactHtml(m) : '';
    return {
      top: (m.forwarded ? '<div class="wa-fwd-tag">↪ Forwarded</div>' : '') + quoteHtml(m),
      rich,
      isRich: !!rich,
      link: m.type === 'text' ? linkHtml(m) : '',
      reacts: reactionsHtml(m),
    };
  }

  /* ---------------------------------------------------------------- reactions */
  async function react(m, emoji) {
    const mine = (m.reactions && m.reactions.me) === emoji;
    const val = mine ? '' : emoji;
    try {
      await C.api(C.base + '/send', { method: 'POST', body: { jid: C.S.jid, quotedId: m.id, react: val } });
      m.reactions = m.reactions || {};
      if (val) m.reactions.me = val; else delete m.reactions.me;
      C.paintThread(false);
    } catch (e) { C.toast(e.message, 'err'); }
  }

  /** Quick emoji row on top of the message menu. */
  function addReactionRow(m) {
    const pop = document.querySelector('#waApp .wa-pop');
    if (!pop) return;
    const row = document.createElement('div');
    row.className = 'wa-react-row';
    row.innerHTML = QUICK.map((e) => `<button data-e="${e}" class="${(m.reactions && m.reactions.me) === e ? 'on' : ''}">${e}</button>`).join('');
    row.onclick = (ev) => { const b = ev.target.closest('button'); if (!b) return; ev.stopPropagation(); pop.remove(); react(m, b.dataset.e); };
    pop.insertBefore(row, pop.firstChild);
  }

  /* ---------------------------------------------------------------- attach menu + composers */
  function attachMenu(anchor, pickFile) {
    const r = anchor.getBoundingClientRect();
    C.popMenu(r.left, Math.max(8, r.top - 190), [
      { label: '📎 Photo or file', run: pickFile },
      { label: '📊 Poll', run: pollDialog },
      { label: '📍 Location', run: locationDialog },
      { label: '👤 Contact card', run: contactDialog },
    ]);
  }

  const done = (r) => { if (r && r.message) { if (!C.S.msgs.some((x) => x.id === r.message.id) && C.S.jid) C.S.msgs.push(r.message); C.paintThread(true); } };

  function pollDialog() {
    const d = C.dialog(`<h3>Create poll</h3>
      <input class="wa-dialog-input" id="wpQ" maxlength="200" placeholder="Question" autocomplete="off" />
      <div id="wpOpts" class="wa-poll-edit"></div>
      <button type="button" class="wa-btn ghost" id="wpAdd">+ Add option</button>
      <label class="wa-check"><input type="checkbox" id="wpMulti"> Allow multiple answers</label>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Send poll</button></div>`);
    const box = d.querySelector('#wpOpts');
    const add = () => { if (box.children.length >= 12) return; const i = document.createElement('input'); i.className = 'wa-dialog-input'; i.maxLength = 100; i.placeholder = 'Option ' + (box.children.length + 1); box.appendChild(i); };
    add(); add();
    d.querySelector('#wpAdd').onclick = add;
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('[data-ok]').onclick = async () => {
      const options = [...box.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
      try {
        done(await C.api(C.base + '/sendpoll', { method: 'POST', body: { jid: C.S.jid, name: d.querySelector('#wpQ').value, options, multi: d.querySelector('#wpMulti').checked } }));
        d.remove();
      } catch (e) { C.toast(e.message, 'err'); }
    };
    d.querySelector('#wpQ').focus();
  }

  function locationDialog() {
    const d = C.dialog(`<h3>Send location</h3>
      <p class="wa-acc-note">Share where this browser is right now, or type coordinates.</p>
      <button class="wa-btn" id="wlHere">📍 Use my current location</button>
      <div class="wa-acc-form" style="grid-template-columns:1fr 1fr">
        <input class="wa-dialog-input" id="wlLat" placeholder="Latitude, e.g. -17.8252" inputmode="decimal" />
        <input class="wa-dialog-input" id="wlLng" placeholder="Longitude, e.g. 31.0335" inputmode="decimal" />
      </div>
      <input class="wa-dialog-input" id="wlName" maxlength="100" placeholder="Place name (optional)" style="margin-top:8px" />
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Send</button></div>`);
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('#wlHere').onclick = () => {
      if (!navigator.geolocation) return C.toast('This browser cannot share a location', 'err');
      navigator.geolocation.getCurrentPosition(
        (p) => { d.querySelector('#wlLat').value = p.coords.latitude.toFixed(6); d.querySelector('#wlLng').value = p.coords.longitude.toFixed(6); },
        () => C.toast('Location permission denied. Type the coordinates instead.', 'err'),
        { enableHighAccuracy: true, timeout: 12000 });
    };
    d.querySelector('[data-ok]').onclick = async () => {
      try {
        done(await C.api(C.base + '/sendlocation', { method: 'POST', body: { jid: C.S.jid, lat: d.querySelector('#wlLat').value, lng: d.querySelector('#wlLng').value, name: d.querySelector('#wlName').value.trim() } }));
        d.remove();
      } catch (e) { C.toast(e.message, 'err'); }
    };
  }

  function contactDialog() {
    const d = C.dialog(`<h3>Send contact card</h3>
      <input class="wa-dialog-input" id="wcName" maxlength="60" placeholder="Name" autocomplete="off" />
      <input class="wa-dialog-input" id="wcPhone" inputmode="tel" placeholder="Number with country code" autocomplete="off" style="margin-top:8px" />
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Send</button></div>`);
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('[data-ok]').onclick = async () => {
      try {
        done(await C.api(C.base + '/sendcontact', { method: 'POST', body: { jid: C.S.jid, name: d.querySelector('#wcName').value, phone: d.querySelector('#wcPhone').value } }));
        d.remove();
      } catch (e) { C.toast(e.message, 'err'); }
    };
    d.querySelector('#wcName').focus();
  }

  /* ---------------------------------------------------------------- thread behaviour */
  let away = 0; // messages that arrived while scrolled up

  function jumpTo(id) {
    const el = document.querySelector(`#waThread .wa-msg[data-id="${CSS.escape(id)}"]`);
    if (!el) return C.toast('That message is not loaded in this chat', 'err');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }

  function updateFab() {
    const t = document.getElementById('waThread');
    const fab = document.getElementById('waFab');
    if (!t || !fab) return;
    const gap = t.scrollHeight - t.scrollTop - t.clientHeight;
    fab.hidden = gap < 260;
    if (gap < 80) away = 0;
    const n = fab.querySelector('i');
    n.textContent = away > 99 ? '99+' : String(away);
    n.hidden = !away;
  }

  /** Called by app.js after a live message lands in the open chat. */
  function noteIncoming(fromMe) {
    const t = document.getElementById('waThread');
    if (!t || fromMe) return;
    if (t.scrollHeight - t.scrollTop - t.clientHeight > 160) away += 1;
    updateFab();
  }

  function bindThread(t) {
    // jump to quoted message, chips, contact "Message" buttons (delegated, so repaints need no rebinding)
    t.addEventListener('click', async (e) => {
      const q = e.target.closest('[data-jump]');
      if (q) return jumpTo(q.dataset.jump);
      const chip = e.target.closest('[data-react]');
      if (chip) {
        const m = C.S.msgs.find((x) => x.id === chip.dataset.rid);
        if (m && (m.reactions || {}).me === chip.dataset.react) react(m, chip.dataset.react);
        return;
      }
      const cn = e.target.closest('[data-chatnum]');
      if (cn) {
        try {
          const r = await C.api(C.base + '/lookup', { method: 'POST', body: { phone: cn.dataset.chatnum } });
          if (!r.exists) return C.toast('That number is not on WhatsApp', 'err');
          await C.loadChats(); C.openChat(r.jid);
        } catch (er) { C.toast(er.message, 'err'); }
      }
    });
    t.addEventListener('scroll', updateFab, { passive: true });

    // swipe right on a bubble to reply (touch screens)
    let sx = 0, sy = 0, el = null, dx = 0, locked = false;
    t.addEventListener('touchstart', (e) => {
      const m = e.target.closest('.wa-msg[data-id]');
      if (!m || e.touches.length !== 1) return;
      el = m; sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; locked = false;
    }, { passive: true });
    t.addEventListener('touchmove', (e) => {
      if (!el) return;
      const x = e.touches[0].clientX - sx, y = e.touches[0].clientY - sy;
      if (!locked && Math.abs(y) > Math.abs(x) && Math.abs(y) > 8) { el.style.transform = ''; el = null; return; }
      if (x > 8) locked = true;
      dx = Math.max(0, Math.min(x, 90));
      el.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    const end = () => {
      if (!el) return;
      const id = el.dataset.id;
      el.style.transition = 'transform .15s';
      el.style.transform = '';
      const node = el; setTimeout(() => { node.style.transition = ''; }, 200);
      if (dx > 60) { const m = C.S.msgs.find((x) => x.id === id); if (m && !m.deleted) { if (navigator.vibrate) navigator.vibrate(12); C.setReply(m); } }
      el = null; dx = 0;
    };
    t.addEventListener('touchend', end, { passive: true });
    t.addEventListener('touchcancel', end, { passive: true });
  }

  function init(ctx) {
    C = ctx;
    away = 0;
    const main = document.getElementById('waMain');
    const t = document.getElementById('waThread');
    if (main && t && !document.getElementById('waFab')) {
      const fab = document.createElement('button');
      fab.id = 'waFab'; fab.className = 'wa-fab'; fab.hidden = true; fab.title = 'Jump to latest';
      fab.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg><i hidden></i>';
      fab.onclick = () => { t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' }); away = 0; updateFab(); };
      t.parentNode.insertBefore(fab, t.nextSibling);
      bindThread(t);
    }
    // reset the counter when another chat opens
    new MutationObserver(updateFab).observe(t, { childList: true });
  }

  window.WARICH = { init, parts, addReactionRow, attachMenu, noteIncoming, updateFab, esc };
})();
