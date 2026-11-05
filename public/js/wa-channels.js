/* Ladybug Chat - Channels (WhatsApp newsletters).
   Follow a channel by its link, read its posts (views and reactions), post to channels you own or admin,
   create a channel, mute or unfollow. The channel list is kept by this console (WhatsApp does not let a
   linked device list the channels a phone follows). Loaded before app.js; app.js calls WACHAN.init(ctx). */
(function () {
  'use strict';

  let C = null;
  let channels = [];
  let newCount = 0;
  let listDialog = null; // { d, draw }
  let openView = null; // { jid, redraw(channel), push(post) }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 10v4a1 1 0 0 0 1 1h2l5 4V5L6 9H4a1 1 0 0 0-1 1zm13.500 2a4.500 4.500 0 0 0-2.500-4v8a4.500 4.500 0 0 0 2.500-4zM14 3.200v2.100a7 7 0 0 1 0 13.400v2.100a9 9 0 0 0 0-17.600z"/></svg>';
  const TICK = '<span class="wa-chan-tick" title="Verified channel">✔</span>';
  const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n || 0));
  const when = (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000), n = new Date();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === n.toDateString() ? t : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + t;
  };
  const readFile = (f) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('Could not read the file')); fr.readAsDataURL(f); });

  function avatar(c, size) {
    const letter = esc(((c.name || '?').trim()[0] || '?').toUpperCase());
    const img = c.picture ? `<img src="${esc(c.picture)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()" style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover">` : '';
    return `<div class="wa-avatar" style="${size ? `width:${size}px;height:${size}px;` : ''}position:relative"><span>${letter}</span>${img}</div>`;
  }

  function badge() {
    const b = document.getElementById('waChanBtn');
    if (!b) return;
    let dot = b.querySelector('.wa-rail-dot');
    if (newCount) { if (!dot) { dot = document.createElement('i'); dot.className = 'wa-rail-dot'; b.appendChild(dot); } dot.textContent = newCount > 9 ? '9+' : String(newCount); }
    else if (dot) dot.remove();
  }

  async function load() {
    try {
      const r = await C.api(C.base + '/channels');
      channels = r.channels || [];
      return r;
    } catch (e) { return { channels, error: e }; }
  }

  /* ---------------------------------------------------------------- channel list */
  async function openList() {
    newCount = 0; badge();
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-stat-dialog');
    let offline = false;
    const draw = () => {
      box.innerHTML = `<div class="wa-gal-head"><h3>Channels</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        ${offline ? '<p class="wa-note">Bot is offline. Showing your saved channels. Start the bot to follow, read new posts or publish.</p>' : ''}
        <div class="wa-chan-add"><input class="wa-dialog-input" id="waChanLink" placeholder="Paste a channel link (whatsapp.com/channel/…)" autocomplete="off" /><button class="wa-btn" data-add>Follow</button></div>
        <p class="wa-note" id="waChanNote"></p>
        ${channels.length ? channels.map((c) => `<div class="wa-stat-row" data-j="${esc(c.jid)}">${avatar(c)}<span><b>${esc(c.name)}${c.verified ? TICK : ''}</b><small>${esc(c.lastText || c.description || 'No posts yet').slice(0, 70)}</small></span><small class="wa-chan-time">${esc(when(c.lastTs))}</small></div>`).join('')
          : '<div class="chat-empty">You are not following any channels here yet.<br><small>Paste a channel link above, or create your own.</small></div>'}
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-new>Create channel</button></div>`;
      box.querySelector('[data-x]').onclick = () => { listDialog = null; d.remove(); };
      box.querySelector('[data-new]').onclick = () => { d.remove(); listDialog = null; create(); };
      const link = box.querySelector('#waChanLink'), note = box.querySelector('#waChanNote'), add = box.querySelector('[data-add]');
      const go = async () => {
        const v = link.value.trim();
        if (!v) return;
        add.disabled = true; note.classList.remove('bad'); note.textContent = 'Looking up the channel…';
        try {
          const r = await C.api(C.base + '/channels/add', { method: 'POST', body: { link: v } });
          C.toast(r.added ? `Following ${r.channel.name}` : `${r.channel.name} is already in your list`);
          await load();
          d.remove(); listDialog = null; view(r.channel.jid, r.channel);
        } catch (e) { note.textContent = e.message; note.classList.add('bad'); add.disabled = false; }
      };
      add.onclick = go;
      link.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
      box.querySelectorAll('.wa-stat-row[data-j]').forEach((el) => { el.onclick = () => { d.remove(); listDialog = null; view(el.dataset.j); }; });
    };
    listDialog = { d, draw };
    draw();
    const r = await load();
    offline = !!r.offline;
    if (document.body.contains(d)) draw();
  }

  /* ---------------------------------------------------------------- one channel */
  async function view(jid, first) {
    let ch = first || channels.find((c) => c.jid === jid) || { jid, name: 'Channel', posts: [] };
    let offline = false, busy = false, picked = null;
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-stat-dialog', 'wa-chan-view');
    const posts = () => (ch.posts || []).slice().sort((a, b) => a.ts - b.ts);
    const draw = () => {
      const list = posts();
      box.innerHTML = `<div class="wa-gal-head"><button class="wa-icon-btn" data-back title="Back">←</button><h3>${esc(ch.name)}${ch.verified ? TICK : ''}</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <div class="wa-chan-top">${avatar(ch, 56)}<span><b>${esc(compact(ch.subscribers))} followers</b><small>${esc(ch.role === 'OWNER' ? 'You own this channel' : ch.role === 'ADMIN' ? 'You are an admin' : ch.role === 'GUEST' ? 'Not following' : 'Following')}</small></span></div>
        ${ch.description ? `<p class="wa-chan-desc">${esc(ch.description)}</p>` : ''}
        ${offline ? '<p class="wa-note">Bot is offline. Showing saved posts.</p>' : ''}
        <div class="wa-chan-posts" id="waChanPosts">${list.length ? list.map(postHtml).join('') : '<div class="chat-empty">No posts to show yet.<br><small>Posts that arrive while this number is online are saved here.</small></div>'}</div>
        ${ch.canPost && !offline ? `<div class="wa-chan-compose">${picked ? `<div class="wa-chan-pick">📎 ${esc(picked.name)} <a href="#" data-unpick>✕</a></div>` : ''}<textarea id="waChanText" rows="2" maxlength="4096" placeholder="${picked ? 'Add a caption' : 'Post to your followers'}"></textarea><div class="wa-chan-bar"><label class="wa-btn ghost">Photo / video<input type="file" id="waChanFile" accept="image/jpeg,image/png,image/webp,video/mp4" hidden></label><span class="wa-note" id="waChanNote"></span><button class="wa-btn" data-post>Post</button></div><p class="wa-note">Every follower sees this. At most 10 posts an hour.</p></div>` : ''}
        <div class="wa-dialog-act">
          <button class="wa-btn ghost" data-refresh>Refresh</button>
          ${ch.link ? '<button class="wa-btn ghost" data-copy>Copy link</button>' : ''}
          ${ch.role !== 'GUEST' ? `<button class="wa-btn ghost" data-mute>${ch.muted ? 'Unmute' : 'Mute'}</button>` : ''}
          <button class="wa-btn ghost danger" data-leave>${ch.role === 'OWNER' ? 'Remove from list' : 'Unfollow'}</button>
        </div>`;
      const q = (s) => box.querySelector(s);
      q('[data-x]').onclick = () => { openView = null; d.remove(); };
      q('[data-back]').onclick = () => { openView = null; d.remove(); openList(); };
      q('[data-refresh]').onclick = () => refresh(true);
      const copy = q('[data-copy]'); if (copy) copy.onclick = () => { navigator.clipboard.writeText(ch.link).then(() => C.toast('Channel link copied'), () => C.toast(ch.link)); };
      const mute = q('[data-mute]'); if (mute) mute.onclick = async () => { try { const r = await C.api(C.base + '/channels/mute', { method: 'POST', body: { jid, mute: !ch.muted } }); ch.muted = r.muted; draw(); } catch (e) { C.toast(e.message, 'err'); } };
      q('[data-leave]').onclick = async () => {
        if (!confirm(ch.role === 'OWNER' ? 'Remove this channel from the console? The channel itself stays on WhatsApp.' : `Unfollow ${ch.name}?`)) return;
        try { await C.api(C.base + '/channels/unfollow', { method: 'POST', body: { jid } }); channels = channels.filter((c) => c.jid !== jid); openView = null; d.remove(); openList(); } catch (e) { C.toast(e.message, 'err'); }
      };
      const file = q('#waChanFile');
      if (file) file.onchange = () => {
        const f = file.files[0]; file.value = '';
        if (!f) return;
        if (f.size > 8 * 1024 * 1024) return C.toast('That file is over 8 MB', 'err');
        if (!/^(image\/(jpeg|png|webp)|video\/mp4)$/.test(f.type)) return C.toast('Use a JPG, PNG, WebP or MP4 file', 'err');
        const t = q('#waChanText').value; picked = f; draw(); q('#waChanText').value = t;
      };
      const un = q('[data-unpick]'); if (un) un.onclick = (e) => { e.preventDefault(); const t = q('#waChanText').value; picked = null; draw(); q('#waChanText').value = t; };
      const post = q('[data-post]'); if (post) post.onclick = send;
      const pe = q('#waChanPosts'); if (pe) pe.scrollTop = pe.scrollHeight;
    };
    function postHtml(p) {
      const rx = (p.reactions || []).map((r) => `${esc(r.code)} ${esc(r.count)}`).join('  ');
      return `<div class="wa-chan-post${p.fromMe ? ' mine' : ''}" data-id="${esc(p.id)}">${p.thumb ? `<img class="wa-chan-img" src="${esc(p.thumb)}" alt="">` : p.type && p.type !== 'text' ? `<div class="wa-chan-media">${esc(p.type)}</div>` : ''}${p.text ? `<div class="wa-chan-text">${esc(p.text)}</div>` : ''}<div class="wa-chan-meta">${rx ? `<span>${rx}</span>` : ''}${p.views != null ? `<span>👁 ${esc(compact(p.views))}</span>` : ''}<span>${esc(when(p.ts))}</span></div></div>`;
    }
    async function send() {
      if (busy) return;
      const text = box.querySelector('#waChanText').value.trim(), note = box.querySelector('#waChanNote'), btn = box.querySelector('[data-post]');
      if (!text && !picked) { note.textContent = 'Write something first.'; return; }
      busy = true; btn.disabled = true; btn.textContent = 'Posting…'; note.classList.remove('bad');
      try {
        const body = picked ? { jid, data: await readFile(picked), caption: text || undefined } : { jid, text };
        await C.api(C.base + '/channels/post', { method: 'POST', body });
        picked = null; busy = false; C.toast('Posted to your channel');
        await refresh(false);
      } catch (e) { busy = false; draw(); const n = box.querySelector('#waChanNote'); if (n) { n.textContent = e.message; n.classList.add('bad'); } }
    }
    async function refresh(spin) {
      const rb = box.querySelector('[data-refresh]');
      if (spin && rb) { rb.disabled = true; rb.textContent = 'Refreshing…'; }
      try {
        const r = await C.api(`${C.base}/channels/posts?jid=${encodeURIComponent(jid)}&limit=60`);
        ch = r.channel; offline = !!r.offline;
        const i = channels.findIndex((c) => c.jid === jid); if (i >= 0) channels[i] = { ...ch, posts: undefined };
      } catch (e) { C.toast(e.message, 'err'); }
      if (document.body.contains(d)) { const t = box.querySelector('#waChanText'), tv = t ? t.value : ''; draw(); const t2 = box.querySelector('#waChanText'); if (t2) t2.value = tv; }
    }
    openView = {
      jid,
      push(p, channel) {
        if (!ch.posts) ch.posts = [];
        if (!ch.posts.some((x) => x.id === p.id)) ch.posts.push(p);
        if (channel) ch = { ...channel, posts: ch.posts };
        if (document.body.contains(d)) { const t = box.querySelector('#waChanText'), tv = t ? t.value : ''; draw(); const t2 = box.querySelector('#waChanText'); if (t2) t2.value = tv; }
      },
    };
    draw();
    await refresh(false);
  }

  /* ---------------------------------------------------------------- create */
  function create() {
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    box.innerHTML = `<div class="wa-gal-head"><h3>Create channel</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
      <label class="wa-field"><span>Name</span><input class="wa-dialog-input" id="waChanName" maxlength="25" placeholder="e.g. Ntandomods Updates" /></label>
      <label class="wa-field"><span>Description (optional)</span><textarea class="wa-dialog-input" id="waChanDesc" rows="3" maxlength="500" placeholder="What will you share here?"></textarea></label>
      <p class="wa-note" id="waChanNote">WhatsApp decides which numbers can create channels. At most 3 a day.</p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Create</button></div>`;
    box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
    const ok = box.querySelector('[data-ok]'), note = box.querySelector('#waChanNote');
    ok.onclick = async () => {
      const name = box.querySelector('#waChanName').value.trim();
      if (name.length < 2) { note.textContent = 'Give the channel a name.'; note.classList.add('bad'); return; }
      ok.disabled = true; ok.textContent = 'Creating…'; note.classList.remove('bad');
      try {
        const r = await C.api(C.base + '/channels/create', { method: 'POST', body: { name, description: box.querySelector('#waChanDesc').value.trim() } });
        await load(); d.remove(); C.toast('Channel created'); view(r.channel.jid, r.channel);
      } catch (e) { note.textContent = e.message; note.classList.add('bad'); ok.disabled = false; ok.textContent = 'Try again'; }
    };
  }

  /* ---------------------------------------------------------------- live updates */
  function bindStream(es) {
    es.addEventListener('channelPost', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        const i = channels.findIndex((c) => c.jid === d.jid);
        if (i >= 0 && d.channel) channels[i] = d.channel;
        if (openView && openView.jid === d.jid) openView.push(d.post, d.channel);
        else if (!d.post.fromMe) { newCount++; badge(); }
        if (listDialog && document.body.contains(listDialog.d)) listDialog.draw();
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('channelRemoved', (ev) => { try { const j = JSON.parse(ev.data).jid; channels = channels.filter((c) => c.jid !== j); } catch (e) { /* ignore */ } });
  }

  function init(ctx) {
    C = ctx; channels = []; newCount = 0;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waChanBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waChanBtn'; b.title = 'Channels'; b.innerHTML = ICON;
      b.onclick = openList;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
    load();
  }

  window.WACHAN = { init, bindStream, open: openList };
})();
