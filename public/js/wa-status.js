/* Ladybug Chat - Status (stories).
   See what your contacts posted in the last 24 hours (photos, videos, text), step through them in a full-screen
   viewer, post your own text / photo / video status and delete it again. Kept in memory on the bot only.
   Loaded before app.js; app.js calls WASTAT.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  let groups = [];
  let audienceN = 0;
  let loading = false;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm4.500 1.200-.8 1.900A8 8 0 0 1 19 8.300l1.900-.8a10 10 0 0 0-4.400-4.300zM21.800 10l-2 .2a8 8 0 0 1 0 1.700l2 .2c.1-.7.2-1.400.2-2.100 0-.6 0-1.300-.2-2z"/></svg>';
  const BG = ['#1f7a5c', '#0f6a8a', '#7b3fa0', '#b8326b', '#c2561f', '#2e3b4e', '#8a6d1f', '#3d6b2f'];
  const FONT_CSS = {
    0: 'system-ui,sans-serif', 1: 'Georgia,serif', 2: '"Brush Script MT","Segoe Script",cursive', 6: 'system-ui,sans-serif;font-weight:800',
    7: 'Georgia,serif;font-style:italic', 8: '"Palatino Linotype",Georgia,serif;font-weight:800', 9: 'Impact,"Arial Black",sans-serif', 10: '"Courier New",monospace;font-weight:700',
  };
  const FONT_NAME = { 0: 'Default', 1: 'Serif', 2: 'Script', 6: 'Bold', 7: 'Breeze', 8: 'Display', 9: 'Heavy', 10: 'Typewriter' };
  const mediaCache = new Map();

  const when = (ts) => {
    const d = new Date(ts * 1000), n = new Date();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === n.toDateString() ? 'Today, ' + t : 'Yesterday, ' + t;
  };
  const unseenTotal = () => groups.reduce((n, g) => n + (g.mine ? 0 : g.unseen), 0);

  function badge() {
    const b = document.getElementById('waStatusBtn');
    if (!b) return;
    const n = groups.filter((g) => !g.mine && g.unseen > 0).length;
    let dot = b.querySelector('.wa-rail-dot');
    if (n) { if (!dot) { dot = document.createElement('i'); dot.className = 'wa-rail-dot'; b.appendChild(dot); } dot.textContent = n > 9 ? '9+' : String(n); }
    else if (dot) dot.remove();
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const r = await C.api(C.base + '/status');
      groups = r.groups || []; audienceN = r.audience || 0;
    } catch (e) { /* bot offline: keep what we have */ }
    loading = false;
    badge();
  }

  const avatarFor = (g) => C.avatarHtml({ name: g.name, jid: g.jid, avatar: g.avatar, isGroup: false });
  const ring = (g, inner) => `<div class="wa-ring ${g.unseen > 0 && !g.mine ? 'new' : 'seen'}">${inner}</div>`;

  /* ---------------------------------------------------------------- the Status list */
  async function openList() {
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-stat-dialog');
    const draw = () => {
      const mine = groups.find((g) => g.mine);
      const recent = groups.filter((g) => !g.mine && g.unseen > 0);
      const viewed = groups.filter((g) => !g.mine && g.unseen === 0);
      const row = (g) => `<div class="wa-stat-row" data-p="${esc(g.poster)}">${ring(g, avatarFor(g))}<span><b>${esc(g.name)}</b><small>${g.items.length} update${g.items.length === 1 ? '' : 's'} · ${esc(when(g.latest))}</small></span></div>`;
      box.innerHTML = `<div class="wa-gal-head"><h3>Status</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <div class="wa-stat-row mine" data-p="${mine ? 'me' : ''}" ${mine ? '' : 'data-new="1"'}><div class="wa-ring seen"><div class="wa-avatar"><span>＋</span></div></div><span><b>My status</b><small>${mine ? mine.items.length + ' update' + (mine.items.length === 1 ? '' : 's') + ' · ' + esc(when(mine.latest)) : 'Share a photo, video or text with your contacts'}</small></span><button class="wa-pill" data-new>Add</button></div>
        ${recent.length ? `<h4 class="wa-stat-h">Recent updates</h4>${recent.map(row).join('')}` : ''}
        ${viewed.length ? `<h4 class="wa-stat-h">Viewed</h4>${viewed.map(row).join('')}` : ''}
        ${!recent.length && !viewed.length ? '<div class="chat-empty">No status updates from your contacts yet.<br><small>Updates posted while this number is online show up here for 24 hours.</small></div>' : ''}`;
      box.querySelector('[data-x]').onclick = () => d.remove();
      box.querySelector('[data-new]').onclick = (e) => { e.stopPropagation(); d.remove(); compose(); };
      box.querySelectorAll('.wa-stat-row[data-p]').forEach((el) => {
        el.onclick = () => {
          const g = groups.find((x) => x.poster === el.dataset.p);
          if (el.dataset.new && !g) { d.remove(); return compose(); }
          if (!g) return;
          d.remove(); view(g);
        };
      });
    };
    draw();
    await load();
    if (document.body.contains(d)) draw();
  }

  /* ---------------------------------------------------------------- full-screen viewer */
  async function loadMedia(item) {
    if (mediaCache.has(item.id)) return mediaCache.get(item.id);
    const r = await C.api(`${C.base}/status/media?id=${encodeURIComponent(item.id)}`);
    mediaCache.set(item.id, r);
    if (mediaCache.size > 10) mediaCache.delete(mediaCache.keys().next().value);
    return r;
  }

  function view(group, startAt) {
    const items = group.items;
    let i = Math.max(0, Math.min(items.length - 1, startAt != null ? startAt : Math.max(0, items.findIndex((x) => !x.seen))));
    let timer = null, raf = null, started = 0, dur = 5000, paused = false, gone = false;
    const ov = document.createElement('div');
    ov.className = 'wa-story';
    document.getElementById('waApp').appendChild(ov);

    const close = () => { gone = true; clearTimeout(timer); cancelAnimationFrame(raf); ov.remove(); document.removeEventListener('keydown', keys, true); badge(); };
    const keys = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === ' ') { e.preventDefault(); toggle(); }
    };
    document.addEventListener('keydown', keys, true);
    const next = () => { if (i < items.length - 1) { i++; show(); } else close(); };
    const prev = () => { if (i > 0) { i--; show(); } else show(); };
    const toggle = () => {
      const v = ov.querySelector('video');
      paused = !paused;
      if (v) paused ? v.pause() : v.play().catch(() => {});
      if (paused) { clearTimeout(timer); cancelAnimationFrame(raf); dur -= Date.now() - started; } else run(dur);
    };
    function run(ms) {
      dur = ms; started = Date.now();
      clearTimeout(timer); cancelAnimationFrame(raf);
      const bar = ov.querySelector('.wa-story-bars i:nth-child(' + (i + 1) + ') b');
      const baseW = bar ? parseFloat(bar.style.width) || 0 : 0;
      const tick = () => { if (gone || !bar) return; bar.style.width = Math.min(100, baseW + ((Date.now() - started) / ms) * (100 - baseW)) + '%'; raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      timer = setTimeout(next, ms);
    }

    async function show() {
      if (gone) return;
      clearTimeout(timer); cancelAnimationFrame(raf); paused = false;
      const it = items[i];
      ov.innerHTML = `<div class="wa-story-card">
        <div class="wa-story-bars">${items.map((_, k) => `<i><b style="width:${k < i ? 100 : 0}%"></b></i>`).join('')}</div>
        <div class="wa-story-head">${avatarFor(group)}<span><b>${esc(group.name)}</b><small>${esc(when(it.ts))}</small></span>
          ${it.type !== 'text' ? '<button class="wa-icon-btn" data-save title="Save to this device">⬇</button>' : ''}${group.mine ? '<button class="wa-icon-btn" data-del title="Delete this status">🗑</button>' : ''}<button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <div class="wa-story-stage" id="waStoryStage"></div>
        <button class="wa-story-nav l" data-prev aria-label="Previous"></button><button class="wa-story-nav r" data-next aria-label="Next"></button>
      </div>`;
      ov.querySelector('[data-x]').onclick = close;
      ov.querySelector('[data-prev]').onclick = prev;
      ov.querySelector('[data-next]').onclick = next;
      ov.onclick = (e) => { if (e.target === ov) close(); };
      const sv = ov.querySelector('[data-save]');
      if (sv) sv.onclick = async () => {
        try {
          const m = await loadMedia(it);
          const a = document.createElement('a');
          a.href = m.data; a.download = 'status-' + group.poster + '-' + it.id.slice(0, 8) + '.' + (/video/.test(m.mime) ? 'mp4' : /audio/.test(m.mime) ? 'ogg' : /png/.test(m.mime) ? 'png' : /webp/.test(m.mime) ? 'webp' : 'jpg');
          document.body.appendChild(a); a.click(); a.remove();
        } catch (e) { C.toast(e.message, 'err'); }
      };
      const del = ov.querySelector('[data-del]');
      if (del) del.onclick = async () => {
        if (!confirm('Delete this status for everyone?')) return;
        clearTimeout(timer); cancelAnimationFrame(raf);
        try {
          await C.api(C.base + '/status/delete', { method: 'POST', body: { id: it.id } });
          items.splice(i, 1);
          groups = groups.map((g) => g).filter((g) => g.items.length);
          C.toast('Status deleted');
          if (!items.length) return close();
          i = Math.min(i, items.length - 1); show();
        } catch (e) { C.toast(e.message, 'err'); run(Math.max(1500, dur)); }
      };
      const stage = ov.querySelector('#waStoryStage');
      if (!it.seen && !group.mine) {
        it.seen = true; group.unseen = Math.max(0, group.unseen - 1); badge();
        C.api(C.base + '/status/seen', { method: 'POST', body: { ids: [it.id] } }).catch(() => { it.seen = false; group.unseen += 1; badge(); });
      }
      if (it.type === 'text') {
        stage.style.background = it.bg || BG[0];
        stage.innerHTML = `<p class="wa-story-text" style="font-family:${FONT_CSS[it.font] || FONT_CSS[0]}">${esc(it.text).replace(/\n/g, '<br>')}</p>`;
        return run(Math.min(15000, 4000 + it.text.length * 55));
      }
      stage.style.background = '#000';
      stage.innerHTML = `${it.thumb ? `<img class="wa-story-media blur" src="${esc(it.thumb)}" alt="">` : ''}<div class="wa-story-load">Loading…</div>`;
      try {
        const m = await loadMedia(it);
        if (gone || items[i] !== it) return;
        if (/^video\//.test(m.mime)) {
          stage.innerHTML = `<video class="wa-story-media" src="${m.data}" autoplay playsinline></video>${it.text ? `<div class="wa-story-cap">${esc(it.text)}</div>` : ''}`;
          const v = stage.querySelector('video');
          v.onloadedmetadata = () => run(Math.min(60000, Math.max(2000, (v.duration || 8) * 1000)));
          v.onerror = () => { stage.innerHTML = '<div class="wa-story-load">Could not play this video</div>'; run(3000); };
        } else if (/^audio\//.test(m.mime)) {
          stage.innerHTML = `<div class="wa-story-load">🎤<br><audio src="${m.data}" controls autoplay></audio></div>`; run(30000);
        } else {
          stage.innerHTML = `<img class="wa-story-media" src="${m.data}" alt="">${it.text ? `<div class="wa-story-cap">${esc(it.text)}</div>` : ''}`;
          run(6000);
        }
      } catch (e) {
        if (gone || items[i] !== it) return;
        stage.innerHTML = `<div class="wa-story-load">${esc(e.message)}</div>`;
        run(3500);
      }
    }
    show();
  }

  /* ---------------------------------------------------------------- post a status */
  async function compose() {
    let kind = 'text', bg = BG[0], font = 0, file = null, audienceMode = 'all';
    const picked = new Set();
    const dmChats = () => C.S.chats.filter((c) => !c.isGroup && /@s\.whatsapp\.net$/.test(c.jid));
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-stat-dialog', 'compose');
    await load();
    const draw = () => {
      const n = audienceMode === 'all' ? audienceN : picked.size;
      box.innerHTML = `<div class="wa-gal-head"><h3>New status</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <div class="wa-gal-tabs"><button data-k="text" class="${kind === 'text' ? 'on' : ''}">Text</button><button data-k="media" class="${kind === 'media' ? 'on' : ''}">Photo / video</button></div>
        ${kind === 'text' ? `<div class="wa-stat-prev" id="waPrev" style="background:${esc(bg)}"><textarea id="waStText" maxlength="700" placeholder="Type a status" style="font-family:${FONT_CSS[font]}"></textarea></div>
          <div class="wa-sw-row">${BG.map((c) => `<button type="button" class="wa-sw ${c === bg ? 'on' : ''}" data-bg="${c}" style="background:${c}"></button>`).join('')}</div>
          <label class="wa-field inline"><span>Font</span><select id="waStFont" class="wa-dialog-input">${Object.keys(FONT_NAME).map((k) => `<option value="${k}" ${Number(k) === font ? 'selected' : ''}>${FONT_NAME[k]}</option>`).join('')}</select></label>`
        : `<label class="wa-drop" id="waStDrop">${file ? (/^video/.test(file.type) ? `<video src="${file.url}" controls muted></video>` : `<img src="${file.url}" alt="">`) : '<span>Choose a photo or a short video (max 8 MB)</span>'}<input type="file" id="waStFile" accept="image/jpeg,image/png,image/webp,video/mp4" hidden></label>
          <input class="wa-dialog-input" id="waStCap" maxlength="700" placeholder="Add a caption (optional)" />`}
        <div class="wa-stat-aud"><label><input type="radio" name="aud" value="all" ${audienceMode === 'all' ? 'checked' : ''}> All my contacts and chats <small>(${audienceN})</small></label>
          <label><input type="radio" name="aud" value="pick" ${audienceMode === 'pick' ? 'checked' : ''}> Only share with…</label></div>
        ${audienceMode === 'pick' ? `<div class="wa-fwd-list short">${dmChats().map((c) => `<label class="wa-lbl-item"><input type="checkbox" data-j="${esc(c.jid)}" ${picked.has(c.jid) ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('') || '<div class="chat-empty">No chats yet</div>'}</div>` : ''}
        <p class="wa-note" id="waStNote">Statuses disappear after 24 hours. At most 10 a hour.</p>
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-post ${n ? '' : 'disabled'}>Post to ${n} contact${n === 1 ? '' : 's'}</button></div>`;
      const keepText = box.querySelector('#waStText');
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { if (file) URL.revokeObjectURL(file.url); d.remove(); }; });
      box.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { kind = b.dataset.k; draw(); }; });
      box.querySelectorAll('[data-bg]').forEach((b) => { b.onclick = () => { bg = b.dataset.bg; const t = keepText ? keepText.value : ''; draw(); box.querySelector('#waStText').value = t; }; });
      const fs = box.querySelector('#waStFont'); if (fs) fs.onchange = () => { font = Number(fs.value); const t = keepText.value; draw(); box.querySelector('#waStText').value = t; };
      const ff = box.querySelector('#waStFile');
      if (ff) ff.onchange = () => {
        const f = ff.files[0]; if (!f) return;
        if (f.size > 8 * 1024 * 1024) return C.toast('That file is over 8 MB', 'err');
        if (!/^(image\/(jpeg|png|webp)|video\/mp4)$/.test(f.type)) return C.toast('Use a JPG, PNG, WebP or MP4 file', 'err');
        if (file) URL.revokeObjectURL(file.url);
        file = { blob: f, type: f.type, name: f.name, url: URL.createObjectURL(f) }; draw();
      };
      box.querySelectorAll('input[name="aud"]').forEach((r) => { r.onchange = () => { audienceMode = r.value; const t = keepText ? keepText.value : ''; draw(); const nt = box.querySelector('#waStText'); if (nt) nt.value = t; }; });
      box.querySelectorAll('input[data-j]').forEach((cb) => { cb.onchange = () => { cb.checked ? picked.add(cb.dataset.j) : picked.delete(cb.dataset.j); const b = box.querySelector('[data-post]'); b.disabled = !picked.size; b.textContent = `Post to ${picked.size} contact${picked.size === 1 ? '' : 's'}`; }; });
      box.querySelector('[data-post]').onclick = post;
    };
    async function post() {
      const btn = box.querySelector('[data-post]'), note = box.querySelector('#waStNote');
      const body = { kind, audience: audienceMode === 'pick' ? [...picked] : undefined };
      if (kind === 'text') {
        body.text = box.querySelector('#waStText').value.trim(); body.bg = bg; body.font = font;
        if (!body.text) { note.textContent = 'Write something first.'; return; }
      } else {
        if (!file) { note.textContent = 'Choose a photo or video first.'; return; }
        body.caption = box.querySelector('#waStCap').value.trim();
        body.name = file.name;
        body.data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('Could not read the file')); fr.readAsDataURL(file.blob); });
      }
      btn.disabled = true; btn.textContent = 'Posting…'; note.classList.remove('bad');
      try {
        const r = await C.api(C.base + '/status/post', { method: 'POST', body });
        if (file) URL.revokeObjectURL(file.url);
        d.remove();
        C.toast(`Status posted to ${r.sharedWith} contact${r.sharedWith === 1 ? '' : 's'}`);
        await load();
      } catch (e) { note.textContent = e.message; note.classList.add('bad'); btn.disabled = false; btn.textContent = 'Try again'; }
    }
    draw();
  }

  /* ---------------------------------------------------------------- live updates */
  function bindStream(es) {
    es.addEventListener('statusNew', () => { load(); });
    es.addEventListener('statusDeleted', (ev) => {
      try {
        const id = JSON.parse(ev.data).id;
        for (const g of groups) g.items = g.items.filter((x) => x.id !== id);
        groups = groups.filter((g) => g.items.length);
        badge();
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('connection', (ev) => { try { if (JSON.parse(ev.data).state === 'open') load(); } catch (e) { /* ignore */ } });
  }

  function init(ctx) {
    C = ctx; groups = [];
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waStatusBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waStatusBtn'; b.title = 'Status'; b.innerHTML = ICON;
      b.onclick = openList;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
    load();
  }

  window.WASTAT = { init, bindStream, open: openList, compose, unseen: unseenTotal };
})();
