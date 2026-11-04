/* Ladybug Chat - privacy pack (GB-style): Status viewer + poster, hidden chats, chat lock,
   console lock (PIN + auto-lock), ghost mode (no read receipts / no typing), notification masking.
   Anti-delete and anti view-once live in the bot bridge; this file only shows their results.
   Loaded after app.js. app.js calls WAP.init(ctx) once the console is on screen.
   Everything here is stored in this browser only (localStorage), per bot. */
(function () {
  'use strict';

  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let CTX = null;
  let KEY = 'wa_priv';
  let SEEN_KEY = 'wa_status_seen';
  const DEFAULTS = { pinHash: '', salt: '', hidden: [], locked: [], ghostRead: false, ghostTyping: false, statusReceipt: false, maskNotif: true, autoLockMin: 0 };
  let cfg = Object.assign({}, DEFAULTS);
  let seen = {};
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* storage blocked */ } };
  const saveSeen = () => {
    try {
      const keys = Object.keys(seen);
      if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete seen[k];
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch (e) { /* storage blocked */ }
  };

  /* ================================================================ PIN */
  const enc = (s) => new TextEncoder().encode(String(s));
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  async function hashPin(pin, salt) {
    if (window.crypto && crypto.subtle) {
      const k = await crypto.subtle.importKey('raw', enc(pin), 'PBKDF2', false, ['deriveBits']);
      return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc(salt), iterations: 120000, hash: 'SHA-256' }, k, 256));
    }
    let h = 2166136261; const t = salt + '|' + pin; // plain-http fallback: weak, but better than nothing
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'f' + (h >>> 0).toString(16);
  }
  const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));
  const hasPin = () => !!cfg.pinHash;
  let fails = 0, blockedUntil = 0;
  async function checkPin(pin) {
    if (Date.now() < blockedUntil) throw new Error('Too many wrong tries. Wait ' + Math.ceil((blockedUntil - Date.now()) / 1000) + ' s.');
    const ok = (await hashPin(pin, cfg.salt)) === cfg.pinHash;
    if (ok) { fails = 0; return true; }
    fails += 1;
    if (fails >= 5) { blockedUntil = Date.now() + 30000; fails = 0; }
    return false;
  }

  /* ================================================================ unlock state (memory only) */
  let unlockedAt = 0; // private chats stay open for UNLOCK_MS after the last activity
  const UNLOCK_MS = 3 * 60 * 1000;
  let lastActive = Date.now();
  let consoleLocked = false;
  const isUnlocked = () => Date.now() - unlockedAt < UNLOCK_MS;
  const touch = () => { lastActive = Date.now(); if (isUnlocked()) unlockedAt = Date.now(); };

  function ask(title, text, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const d = CTX.dialog(`<h3>${escH(title)}</h3><p class="wap-note">${text}</p>
        <input class="wa-dialog-input" id="wapPin" type="password" inputmode="numeric" autocomplete="off" placeholder="${opts.confirm ? 'New PIN (4 to 12 digits)' : 'PIN'}" maxlength="12">
        ${opts.confirm ? '<input class="wa-dialog-input" id="wapPin2" type="password" inputmode="numeric" autocomplete="off" placeholder="Repeat PIN" maxlength="12" style="margin-top:8px">' : ''}
        <div class="wap-err" id="wapErr"></div>
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>${escH(opts.ok || 'Unlock')}</button></div>`);
      const inp = d.querySelector('#wapPin'), inp2 = d.querySelector('#wapPin2'), err = d.querySelector('#wapErr');
      setTimeout(() => inp.focus(), 30);
      let done = false;
      const finish = (v) => { if (done) return; done = true; d.remove(); resolve(v); };
      d.addEventListener('click', (e) => { if (e.target === d) finish(null); });
      d.querySelector('[data-x]').onclick = () => finish(null);
      const go = async () => {
        const pin = inp.value;
        try { err.textContent = ''; const r = await opts.verify(pin, inp2 && inp2.value); if (r === true) finish(pin); else err.textContent = r || 'Wrong PIN'; }
        catch (e) { err.textContent = e.message; }
      };
      d.querySelector('[data-ok]').onclick = go;
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') finish(null); });
    });
  }

  async function createPin() {
    const pin = await ask('Create a PIN', 'This PIN protects hidden chats, locked chats and the console lock. It is saved only in this browser. If you clear your browser data or forget it, the lock resets and your hidden chats show again.', {
      confirm: true, ok: 'Save PIN',
      verify: async (a, b) => {
        if (!/^[0-9]{4,12}$/.test(a)) return 'Use 4 to 12 digits';
        if (a !== b) return 'The two PINs do not match';
        return true;
      },
    });
    if (!pin) return false;
    cfg.salt = newSalt();
    cfg.pinHash = await hashPin(pin, cfg.salt);
    save();
    unlockedAt = Date.now();
    CTX.toast('PIN saved');
    return true;
  }

  /** Resolve true when the user may see private chats (PIN already entered recently, or entered now). */
  async function requirePin(why) {
    if (!hasPin()) return createPin();
    if (isUnlocked()) { touch(); return true; }
    const ok = await ask('Enter your PIN', why || 'This chat is private.', { verify: async (p) => ((await checkPin(p)) ? true : 'Wrong PIN') });
    if (!ok) return false;
    unlockedAt = Date.now();
    return true;
  }

  /* ================================================================ chat flags */
  const isHidden = (jid) => cfg.hidden.includes(jid);
  const isLocked = (jid) => cfg.locked.includes(jid);
  const isPrivate = (jid) => isHidden(jid) || isLocked(jid);
  const flip = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); save(); return i < 0; };

  async function gate(jid) {
    if (!isPrivate(jid)) return true;
    if (consoleLocked) return false;
    return requirePin('Enter your PIN to open this private chat.');
  }

  function menuItems(jid) {
    const items = [];
    items.push({
      label: isLocked(jid) ? 'Unlock chat (remove PIN lock)' : 'Lock chat with PIN',
      run: async () => {
        if (isLocked(jid) && !(await requirePin())) return;
        if (!isLocked(jid) && !hasPin() && !(await createPin())) return;
        const on = flip(cfg.locked, jid);
        CTX.toast(on ? 'Chat locked. It needs your PIN to open.' : 'Chat unlocked');
        CTX.paintList();
      },
    });
    items.push({
      label: isHidden(jid) ? 'Unhide chat' : 'Hide chat',
      run: async () => {
        if (!isHidden(jid)) {
          if (!hasPin() && !(await createPin())) return;
          flip(cfg.hidden, jid);
          if (CTX.S.jid === jid) closeChat();
          CTX.toast('Chat hidden. Tap the lock icon above the chat list to see hidden chats.');
        } else {
          if (!(await requirePin())) return;
          flip(cfg.hidden, jid);
          CTX.toast('Chat is visible again');
        }
        CTX.paintList();
      },
    });
    return items;
  }

  function closeChat() {
    const S = CTX.S;
    S.jid = null; S.msgs = []; S.chat = null;
    const sh = CTX.$('#waShell'); if (sh) sh.classList.remove('chat-open');
    const mn = CTX.$('#waMain'); if (mn) mn.classList.remove('has-chat', 'info-open');
    const th = CTX.$('#waThread'); if (th) th.innerHTML = '';
  }

  /* what the chat list may show */
  const visibleChats = () => CTX.S.chats.filter((c) => !isHidden(c.jid));
  const preview = (c) => (isPrivate(c.jid) ? '🔒 Private chat' : null);
  const maskNotif = (jid) => cfg.maskNotif || isPrivate(jid);

  /* ================================================================ vault (hidden chats list) */
  function openVault() {
    requirePin('Enter your PIN to see hidden chats.').then((ok) => {
      if (!ok) return;
      CTX.S.tab = 'private';
      document.querySelectorAll('#waTabs [data-tab]').forEach((x) => x.classList.remove('on'));
      CTX.paintList();
      vaultBar(true);
    });
  }
  function vaultBar(show) {
    let bar = CTX.$('#wapVaultBar');
    if (!show) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'wapVaultBar';
      bar.className = 'wap-vaultbar';
      CTX.$('#waList').before(bar);
    }
    bar.innerHTML = `<b>🔒 Hidden chats</b><span>${cfg.hidden.length} hidden · ${cfg.locked.length} locked</span><button class="wa-btn ghost" id="wapVaultX">Lock and close</button>`;
    bar.querySelector('#wapVaultX').onclick = closeVault;
  }
  function closeVault() {
    unlockedAt = 0;
    vaultBar(false);
    if (CTX.S.tab === 'private') {
      CTX.S.tab = 'all';
      const b = document.querySelector('#waTabs [data-tab="all"]'); if (b) b.classList.add('on');
    }
    const cur = CTX.S.jid;
    if (cur && isPrivate(cur)) closeChat();
    CTX.paintList();
  }
  const privateList = () => CTX.S.chats.filter((c) => isHidden(c.jid));

  /* ================================================================ console lock */
  function lockConsole() {
    if (!hasPin()) { createPin().then((ok) => ok && lockConsole()); return; }
    if (consoleLocked) return;
    consoleLocked = true;
    unlockedAt = 0;
    closeVault();
    const o = document.createElement('div');
    o.className = 'wap-lock';
    o.innerHTML = `<div class="wap-lock-box"><div class="wap-lock-ico">🔒</div><h2>Console locked</h2><p>Enter your PIN to continue.</p>
      <input id="wapLockPin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" maxlength="12"><div class="wap-err" id="wapLockErr"></div>
      <button class="wa-btn" id="wapLockGo">Unlock</button></div>`;
    CTX.waApp.appendChild(o);
    const inp = o.querySelector('#wapLockPin'), err = o.querySelector('#wapLockErr');
    setTimeout(() => inp.focus(), 30);
    const go = async () => {
      try {
        if (await checkPin(inp.value)) { consoleLocked = false; o.remove(); touch(); }
        else { err.textContent = 'Wrong PIN'; inp.value = ''; }
      } catch (e) { err.textContent = e.message; }
    };
    o.querySelector('#wapLockGo').onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  function startIdleWatch() {
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach((ev) => document.addEventListener(ev, touch, { passive: true, capture: true }));
    const t = setInterval(() => {
      if (!document.getElementById('waApp')) return clearInterval(t);
      if (CTX.S.tab === 'private' && !isUnlocked()) closeVault();
      if (cfg.autoLockMin > 0 && hasPin() && !consoleLocked && Date.now() - lastActive > cfg.autoLockMin * 60000) lockConsole();
    }, 10000);
  }

  /* ================================================================ ghost mode */
  const ghost = { read: () => !!cfg.ghostRead, typing: () => !!cfg.ghostTyping };

  /* ================================================================ privacy dialog */
  function privacyDialog() {
    const d = CTX.dialog('');
    const box = d.firstElementChild;
    box.classList.add('wap-dialog');
    const chk = (id, on, label, help) => `<label class="wa-check wap-opt"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> <span>${label}${help ? `<small>${help}</small>` : ''}</span></label>`;
    function render() {
      box.innerHTML = `<div class="wa-look-head"><h3>Privacy and security</h3><button type="button" class="wa-icon-btn" id="wapX" title="Close">✕</button></div>
      <section><h4>Ghost mode</h4>
        ${chk('gRead', cfg.ghostRead, 'Hide blue ticks', 'Opening a chat here does not tell people you read it.')}
        ${chk('gType', cfg.ghostTyping, 'Hide "typing…"', 'People do not see that you are typing or recording.')}
        ${chk('gSeen', cfg.statusReceipt, 'Let people know I viewed their status', 'Off means you watch statuses anonymously.')}
      </section>
      <section><h4>Always on</h4>
        <div class="wap-on"><b>Anti-delete</b><small>Messages deleted for everyone stay in the chat, marked as recovered.</small></div>
        <div class="wap-on"><b>View once unlocker</b><small>View-once photos and videos stay open and can be saved.</small></div>
        <div class="wap-on"><b>Statuses kept 24 h</b><small>Everything stays in server memory only and is dropped on restart.</small></div>
      </section>
      <section><h4>Lock</h4>
        <div class="wa-set-row"><span>PIN</span><span>${hasPin() ? '<button class="wa-btn ghost" id="pinChange">Change</button> <button class="wa-btn ghost" id="pinOff">Remove</button>' : '<button class="wa-btn" id="pinNew">Create PIN</button>'}</span></div>
        <div class="wa-set-row"><span>Auto-lock the console</span><select id="alock">${[[0, 'Never'], [1, 'After 1 min idle'], [5, 'After 5 min idle'], [15, 'After 15 min idle'], [30, 'After 30 min idle']].map(([v, t]) => `<option value="${v}" ${cfg.autoLockMin === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        ${chk('mNotif', cfg.maskNotif, 'Hide message text in notifications', 'Notifications say "New message" only.')}
        <div class="wa-set-row"><span>${cfg.hidden.length} hidden · ${cfg.locked.length} locked chats</span><span><button class="wa-btn ghost" id="lockNow">Lock console now</button></span></div>
        <p class="wap-note">The lock lives in this browser only. It keeps casual snoopers out; it is not a replacement for a strong dashboard password, and clearing browser data removes it.</p>
      </section>`;
      const $$ = (s) => box.querySelector(s);
      $$('#wapX').onclick = () => d.remove();
      $$('#gRead').onchange = (e) => { cfg.ghostRead = e.target.checked; save(); };
      $$('#gType').onchange = (e) => { cfg.ghostTyping = e.target.checked; save(); };
      $$('#gSeen').onchange = (e) => { cfg.statusReceipt = e.target.checked; save(); };
      $$('#mNotif').onchange = (e) => { cfg.maskNotif = e.target.checked; save(); };
      $$('#alock').onchange = (e) => { if (!hasPin()) { e.target.value = 0; CTX.toast('Create a PIN first', 'err'); return; } cfg.autoLockMin = Number(e.target.value) || 0; save(); };
      $$('#lockNow').onclick = () => { d.remove(); lockConsole(); };
      const pn = $$('#pinNew'); if (pn) pn.onclick = async () => { if (await createPin()) render(); };
      const pc = $$('#pinChange'); if (pc) pc.onclick = async () => {
        if (!(await ask('Current PIN', 'Enter your current PIN first.', { verify: async (p) => ((await checkPin(p)) ? true : 'Wrong PIN') }))) return;
        if (await createPin()) render();
      };
      const po = $$('#pinOff'); if (po) po.onclick = async () => {
        if (!(await ask('Remove PIN', 'This also unhides and unlocks every private chat.', { ok: 'Remove', verify: async (p) => ((await checkPin(p)) ? true : 'Wrong PIN') }))) return;
        cfg.pinHash = ''; cfg.salt = ''; cfg.hidden = []; cfg.locked = []; cfg.autoLockMin = 0; save(); closeVault(); render(); CTX.paintList();
      };
    }
    render();
  }

  /* ================================================================ Status viewer */
  let ST = { list: [], at: 0, open: false, p: 0, i: 0, timer: null, media: {}, busy: false };
  const SEC = 6000;
  const EMPTY = '<div class="wap-st-empty"><div>◎</div><p>Pick a status to watch it.<br>Statuses disappear after 24 hours.</p></div>';
  const timeLabel = (ts) => {
    const m = Math.floor((Date.now() / 1000 - ts) / 60);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + ' h ago' : 'yesterday';
  };
  const unseenIn = (p) => p.items.filter((x) => !seen[x.id]).length;
  const unseenTotal = () => ST.list.reduce((n, p) => n + (p.fromMe ? 0 : unseenIn(p)), 0);

  async function loadStatuses() {
    try { const r = await CTX.api(CTX.base + '/statuses'); ST.list = r.statuses || []; ST.at = Date.now(); }
    catch (e) { /* bot offline */ }
    paintRailDot();
    if (ST.open) paintStatusList();
  }
  function paintRailDot() {
    const b = CTX.$('#wapStatusBtn'); if (!b) return;
    const n = unseenTotal();
    const dot = b.querySelector('.wap-dot');
    dot.textContent = n > 99 ? '99+' : n || '';
    dot.style.display = n ? 'grid' : 'none';
  }
  function onStatusNew(d) {
    loadStatusesSoon();
    if (d && !d.fromMe && !document.hidden && CTX.S && CTX.waApp && CTX.waApp.querySelector('#wapStatus') == null) { /* badge only, no sound for statuses */ }
  }
  let sT = null;
  function loadStatusesSoon() { clearTimeout(sT); sT = setTimeout(loadStatuses, 800); }

  function avatarFor(p) {
    const latest = p.items[p.items.length - 1];
    const letter = escH((p.name || '?').replace(/^\+/, '').charAt(0).toUpperCase());
    const bg = latest && latest.thumb ? `style="background-image:url('${latest.thumb}')"` : '';
    return `<span class="wap-ring ${unseenIn(p) && !p.fromMe ? 'new' : 'old'}"><span class="wap-ring-in" ${bg}>${latest && latest.thumb ? '' : letter}</span></span>`;
  }

  function openStatus() {
    if (CTX.waApp.querySelector('#wapStatus')) return;
    ST.open = true;
    const el = document.createElement('div');
    el.className = 'wap-status';
    el.id = 'wapStatus';
    el.innerHTML = `<aside class="wap-st-side">
        <header><b>Status</b><span><button class="wa-icon-btn" id="wapStPost" title="Post a status">＋</button><button class="wa-icon-btn" id="wapStX" title="Close">✕</button></span></header>
        <div class="wap-st-list" id="wapStList"><div class="chat-empty">Loading…</div></div>
        <footer>Viewing is anonymous. Nobody is told you looked${cfg.statusReceipt ? ' (you turned receipts on)' : ''}.</footer>
      </aside>
      <section class="wap-st-view" id="wapStView">${EMPTY}</section>`;
    CTX.waApp.appendChild(el);
    el.querySelector('#wapStX').onclick = closeStatus;
    el.querySelector('#wapStPost').onclick = postDialog;
    el.addEventListener('keydown', statusKeys);
    el.tabIndex = -1; el.focus();
    paintStatusList();
    loadStatuses();
  }
  function closeStatus() {
    ST.open = false;
    clearTimeout(ST.timer);
    const el = CTX.waApp.querySelector('#wapStatus'); if (el) el.remove();
    paintRailDot();
  }
  function statusKeys(e) {
    if (e.key === 'Escape') closeStatus();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  }

  function paintStatusList() {
    const box = CTX.$('#wapStList'); if (!box) return;
    if (!ST.list.length) { box.innerHTML = '<div class="chat-empty">No statuses yet. When your contacts post, they show up here for 24 hours.</div>'; return; }
    const mine = ST.list.filter((p) => p.fromMe), fresh = ST.list.filter((p) => !p.fromMe && unseenIn(p)), old = ST.list.filter((p) => !p.fromMe && !unseenIn(p));
    const row = (p) => `<div class="wap-st-row" data-p="${escH(p.jid)}">${avatarFor(p)}<div><b>${escH(p.name)}</b><small>${p.items.length} update${p.items.length === 1 ? '' : 's'} · ${timeLabel(p.latest)}</small></div></div>`;
    box.innerHTML = (mine.length ? '<h5>My status</h5>' + mine.map(row).join('') : '')
      + (fresh.length ? '<h5>Recent</h5>' + fresh.map(row).join('') : '')
      + (old.length ? '<h5>Viewed</h5>' + old.map(row).join('') : '');
    box.querySelectorAll('[data-p]').forEach((r) => {
      r.onclick = () => {
        const pi = ST.list.findIndex((p) => p.jid === r.dataset.p);
        const p = ST.list[pi];
        const first = Math.max(0, p.items.findIndex((x) => !seen[x.id]));
        show(pi, p.fromMe ? 0 : first);
      };
    });
  }

  function show(pi, ii) {
    clearTimeout(ST.timer);
    const p = ST.list[pi];
    if (!p || !p.items[ii]) return;
    ST.p = pi; ST.i = ii;
    const it = p.items[ii];
    const view = CTX.$('#wapStView'); if (!view) return;
    const bars = p.items.map((_, k) => `<i class="${k < ii ? 'done' : ''}"><b class="${k === ii ? 'run' : ''}"></b></i>`).join('');
    let body;
    if (it.type === 'text') body = `<div class="wap-st-text" style="background:${escH(it.bg || '#128c7e')}"><p>${escH(it.text)}</p></div>`;
    else body = `<div class="wap-st-media" id="wapStMedia">${it.thumb ? `<img class="blur" src="${it.thumb}" alt="">` : ''}<div class="wap-st-load">Loading…</div></div>`;
    view.innerHTML = `<div class="wap-st-card">
      <div class="wap-bars">${bars}</div>
      <div class="wap-st-head"><button class="wa-icon-btn wap-back" id="wapStBack" title="Back">←</button>${avatarFor(p)}<div><b>${escH(p.name)}</b><small>${timeLabel(it.ts)}</small></div>
        <span class="wap-st-act">${it.type !== 'text' ? '<button class="wa-icon-btn" id="wapStDl" title="Download">⬇</button>' : ''}<button class="wa-icon-btn" id="wapStSeen" title="Tell them you viewed this">👁</button>${p.fromMe ? '' : '<button class="wa-icon-btn" id="wapStChat" title="Open chat">💬</button>'}</span></div>
      ${body}
      ${it.type !== 'text' && it.text ? `<div class="wap-st-cap">${escH(it.text)}</div>` : ''}
      <button class="wap-nav prev" id="wapPrev">‹</button><button class="wap-nav next" id="wapNext">›</button>
    </div>`;
    view.querySelector('#wapStBack').onclick = () => { clearTimeout(ST.timer); view.innerHTML = EMPTY; };
    view.querySelector('#wapPrev').onclick = () => step(-1);
    view.querySelector('#wapNext').onclick = () => step(1);
    const chat = view.querySelector('#wapStChat'); if (chat) chat.onclick = () => { closeStatus(); CTX.openChat(p.jid); };
    view.querySelector('#wapStSeen').onclick = async () => {
      try { await CTX.api(CTX.base + '/status-seen', { method: 'POST', body: { poster: p.jid, id: it.id } }); CTX.toast('They can now see you viewed it'); }
      catch (e) { CTX.toast(e.message, 'err'); }
    };
    seen[it.id] = 1; saveSeen(); paintRailDot();
    if (cfg.statusReceipt && !p.fromMe) CTX.api(CTX.base + '/status-seen', { method: 'POST', body: { poster: p.jid, id: it.id } }).catch(() => {});
    const advance = (ms) => { const bar = view.querySelector('.wap-bars b.run'); if (bar) { bar.style.transition = `width ${ms}ms linear`; requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = '100%'; })); } ST.timer = setTimeout(() => step(1), ms); };
    if (it.type === 'text') return advance(SEC);
    loadStatusMedia(p, it).then((m) => {
      const box = view.querySelector('#wapStMedia'); if (!box || ST.p !== pi || ST.i !== ii) return;
      if (!m) { box.innerHTML = '<div class="wap-st-load">This status could not be opened (it may have expired).</div>'; return advance(2500); }
      const dl = view.querySelector('#wapStDl');
      if (dl) dl.onclick = () => { const a = document.createElement('a'); a.href = m.data; a.download = 'status-' + it.id.slice(0, 8) + (it.type === 'video' ? '.mp4' : '.jpg'); document.body.appendChild(a); a.click(); a.remove(); };
      if (it.type === 'video') {
        box.innerHTML = `<video src="${m.data}" autoplay playsinline controls></video>`;
        const v = box.querySelector('video');
        v.onloadedmetadata = () => advance(Math.min(60000, Math.max(3000, (v.duration || 10) * 1000)));
        v.onended = () => step(1);
      } else if (it.type === 'image') { box.innerHTML = `<img src="${m.data}" alt="status">`; advance(SEC); }
      else { box.innerHTML = `<audio src="${m.data}" controls autoplay></audio>`; advance(15000); }
    });
  }
  async function loadStatusMedia(p, it) {
    if (ST.media[it.id]) return ST.media[it.id];
    try { const m = await CTX.api(`${CTX.base}/status-media?poster=${encodeURIComponent(p.jid)}&id=${encodeURIComponent(it.id)}`); ST.media[it.id] = m; const keys = Object.keys(ST.media); if (keys.length > 12) delete ST.media[keys[0]]; return m; }
    catch (e) { return null; }
  }
  function step(dir) {
    const p = ST.list[ST.p]; if (!p) return;
    let ni = ST.i + dir, np = ST.p;
    if (ni >= p.items.length) {
      // next person that still has something unseen, else stop
      np = ST.list.findIndex((x, k) => k > ST.p && !x.fromMe && unseenIn(x));
      if (np < 0) { paintStatusList(); const v = CTX.$('#wapStView'); if (v) v.innerHTML = '<div class="wap-st-empty"><div>✓</div><p>You are all caught up.</p></div>'; return; }
      ni = Math.max(0, ST.list[np].items.findIndex((x) => !seen[x.id]));
    } else if (ni < 0) {
      if (ST.p === 0) return;
      np = ST.p - 1; ni = ST.list[np].items.length - 1;
    }
    paintStatusList();
    show(np, ni);
  }

  /* post a status */
  const BGS = ['#128c7e', '#1976d2', '#8e24aa', '#d81b60', '#f4511e', '#6d4c41', '#37474f', '#2e7d32'];
  function postDialog() {
    const d = CTX.dialog('');
    const box = d.firstElementChild;
    box.classList.add('wap-dialog');
    let bg = BGS[0], file = null;
    box.innerHTML = `<div class="wa-look-head"><h3>Post a status</h3><button class="wa-icon-btn" id="pX">✕</button></div>
      <div class="wap-post-prev" id="pPrev" style="background:${bg}"><textarea id="pText" maxlength="700" placeholder="Type a status"></textarea></div>
      <div class="wap-swatches" id="pSw">${BGS.map((c, k) => `<button type="button" data-c="${c}" style="background:${c}" class="${k === 0 ? 'on' : ''}"></button>`).join('')}</div>
      <div class="wap-file"><label class="wa-btn ghost">Photo or video<input type="file" id="pFile" accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp,video/quicktime" hidden></label><span id="pName"></span></div>
      <p class="wap-note">Your status goes to everyone this number has chatted with and stays 24 hours. Max ${10} posts per hour.</p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" id="pCancel">Cancel</button><button class="wa-btn" id="pGo">Post status</button></div>`;
    const $$ = (s) => box.querySelector(s);
    $$('#pX').onclick = $$('#pCancel').onclick = () => d.remove();
    $$('#pSw').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; bg = b.dataset.c; $$('#pPrev').style.background = bg; $$('#pSw').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    $$('#pFile').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 9 * 1048576) { CTX.toast('File is too big (max 9 MB)', 'err'); e.target.value = ''; return; }
      file = f; $$('#pName').textContent = f.name; $$('#pText').placeholder = 'Add a caption (optional)';
      $$('#pPrev').style.background = '#111';
    };
    $$('#pGo').onclick = async () => {
      const text = $$('#pText').value.trim();
      if (!file && !text) return CTX.toast('Write something or pick a file', 'err');
      const go = $$('#pGo'); go.disabled = true; go.textContent = 'Posting…';
      try {
        let body;
        if (file) {
          const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file); });
          body = { data, caption: text };
        } else body = { text, bg };
        const r = await CTX.api(CTX.base + '/status-post', { method: 'POST', body });
        CTX.toast('Status posted for ' + (r.recipients || 0) + ' contacts');
        d.remove(); loadStatuses();
      } catch (e) { CTX.toast(e.message, 'err'); go.disabled = false; go.textContent = 'Post status'; }
    };
  }

  /* ================================================================ init */
  const ICON_STATUS = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm0 4a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4V6zm8.500-3.500a1.500 1.500 0 1 0 0 3 1.500 1.500 0 0 0 0-3z"/></svg>';
  const ICON_SHIELD = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 1 3 5v6c0 5.500 3.800 10.700 9 12 5.200-1.300 9-6.500 9-12V5l-9-4zm0 10.990h7c-.5 4.100-3.300 7.800-7 8.900V12H5V6.300l7-3.100v8.790z"/></svg>';
  const ICON_LOCK = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6zm9 14H6V10h12v10z"/></svg>';

  function init(ctx) {
    CTX = ctx;
    KEY = 'wa_priv_' + ctx.bot.id;
    SEEN_KEY = 'wa_status_seen_' + ctx.bot.id;
    cfg = Object.assign({}, DEFAULTS, load(KEY, {}));
    for (const k of ['hidden', 'locked']) if (!Array.isArray(cfg[k])) cfg[k] = [];
    seen = load(SEEN_KEY, {});
    const app = ctx.waApp;
    const rail = app.querySelector('.wa-rail');
    const grow = rail && rail.querySelector('.wa-rail-grow');
    if (rail && !rail.querySelector('#wapStatusBtn')) {
      const mk = (id, title, svg) => { const b = document.createElement('button'); b.className = 'wa-rail-btn'; b.id = id; b.title = title; b.innerHTML = svg; return b; };
      const st = mk('wapStatusBtn', 'Status', ICON_STATUS + '<i class="wap-dot" style="display:none"></i>');
      const sh = mk('wapShieldBtn', 'Privacy and security (Ghost mode, PIN lock)', ICON_SHIELD);
      const lk = mk('wapLockBtn', 'Lock console (Ctrl+L)', ICON_LOCK);
      for (const b of [st, sh, lk]) rail.insertBefore(b, grow || null);
      st.onclick = openStatus;
      sh.onclick = privacyDialog;
      lk.onclick = lockConsole;
    }
    const icons = app.querySelector('.wa-side-icons');
    if (icons && !icons.querySelector('#wapVaultBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-icon-btn'; b.id = 'wapVaultBtn'; b.title = 'Hidden chats'; b.innerHTML = ICON_LOCK;
      b.onclick = () => (CTX.S.tab === 'private' ? closeVault() : openVault());
      icons.insertBefore(b, icons.firstChild);
    }
    document.querySelectorAll('#waTabs [data-tab]').forEach((b) => b.addEventListener('click', () => vaultBar(false)));
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l' && document.getElementById('waApp')) { e.preventDefault(); lockConsole(); }
    });
    startIdleWatch();
    loadStatuses();
    setInterval(() => { if (document.getElementById('waApp') && !document.hidden) loadStatuses(); }, 90000);
    if (cfg.autoLockMin > 0 && hasPin()) lockConsole(); // opening the console after a reload starts locked when auto-lock is on
  }

  window.WAP = { init, gate, menuItems, isHidden, isLocked, isPrivate, visibleChats, privateList, preview, maskNotif, ghost, onStatusNew, openStatus, lockConsole, openPrivacy: privacyDialog, locked: () => consoleLocked };
})();
