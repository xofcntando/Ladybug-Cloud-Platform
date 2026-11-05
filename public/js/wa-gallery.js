/* Ladybug Chat - media, docs and links gallery.
   One place per chat for every photo / video, document / audio file and link. Opens from the chat header,
   the chat menu and the contact / group info drawer. Built from the messages the bot has seen
   (the last 200 per chat), so it grows as the bot stays online. Loaded before app.js. */
(function () {
  'use strict';

  let C = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.500 13.500l2.500 3 3.500-4.500 4.500 6H5l3.500-4.500z"/></svg>';
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
  const fmtSize = (n) => (!n ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const cache = new Map(); // `${jid}|${id}` -> { mime, data, name }
  const monthOf = (ts) => new Date(ts * 1000).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const dayOf = (ts) => new Date(ts * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const KIND_ICON = { document: '📄', audio: '🎵', voice: '🎤' };

  async function fetchFull(jid, id) {
    const key = jid + '|' + id;
    if (cache.has(key)) return cache.get(key);
    const r = await C.api(`${C.base}/media?jid=${encodeURIComponent(jid)}&id=${encodeURIComponent(id)}`);
    cache.set(key, r);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return r;
  }
  function download(r, fallback) {
    const a = document.createElement('a');
    a.href = r.data; a.download = r.name || fallback || 'file';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function viewer(r, item) {
    const lb = document.createElement('div');
    lb.className = 'wa-lightbox';
    const body = /^video\//.test(r.mime) ? `<video src="${r.data}" controls autoplay playsinline style="max-width:92vw;max-height:88vh;border-radius:6px"></video>` : `<img src="${r.data}" alt="">`;
    lb.innerHTML = `${body}<a class="wa-lightbox-dl" href="${r.data}" download="${esc(r.name || item.type + '-' + item.id.slice(0, 6))}" title="Save">⬇</a>`;
    lb.onclick = (e) => { if (e.target === lb) lb.remove(); };
    document.getElementById('waApp').appendChild(lb);
  }

  function open(jid, startKind) {
    jid = jid || C.S.jid;
    if (!jid) return C.toast('Open a chat first', 'err');
    const chat = C.S.chats.find((c) => c.jid === jid) || C.S.chat;
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-gal-dialog');
    let kind = startKind || 'media';
    let counts = { media: 0, docs: 0, links: 0 };
    const render = (data) => {
      const items = data ? data.items : [];
      if (data) counts = data.counts;
      let body;
      if (!data) body = '<div class="chat-empty">Loading…</div>';
      else if (!items.length) body = `<div class="chat-empty">${kind === 'media' ? 'No photos or videos' : kind === 'docs' ? 'No documents or audio files' : 'No links'} yet in this chat.<br><small>Only messages the bot has seen since it started are listed.</small></div>`;
      else if (kind === 'media') {
        let last = ''; let html = '';
        for (const m of items) {
          const mo = monthOf(m.ts);
          if (mo !== last) { html += `${last ? '</div>' : ''}<h4 class="wa-gal-month">${esc(mo)}</h4><div class="wa-gal-grid">`; last = mo; }
          html += `<button class="wa-gal-tile" data-id="${esc(m.id)}" data-type="${esc(m.type)}" title="${esc(dayOf(m.ts))}${m.text ? ' · ' + esc(m.text) : ''}">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy">` : `<span class="wa-gal-ph">${m.type === 'video' ? '🎬' : '🖼'}</span>`}${m.type === 'video' ? `<i class="wa-gal-play">▶${m.media && m.media.seconds ? ' ' + Math.floor(m.media.seconds / 60) + ':' + String(m.media.seconds % 60).padStart(2, '0') : ''}</i>` : ''}</button>`;
        }
        body = html + '</div>';
      } else if (kind === 'docs') {
        body = items.map((m) => `<button class="wa-gal-row" data-id="${esc(m.id)}" data-type="${esc(m.type)}"><span class="wa-gal-ico">${KIND_ICON[m.type] || '📄'}</span><span class="wa-gal-meta"><b>${esc((m.media && m.media.name) || m.text || (m.type === 'voice' ? 'Voice message' : m.type === 'audio' ? 'Audio' : 'Document'))}</b><small>${esc([fmtSize(m.media && m.media.size), m.fromMe ? 'You' : '+' + m.sender, dayOf(m.ts)].filter(Boolean).join(' · '))}</small></span><span class="wa-gal-dl" title="Download">⬇</span></button>`).join('');
      } else {
        body = items.map((l) => { const u = safeUrl(l.url); let host = ''; try { host = new URL(u).hostname.replace(/^www\./, ''); } catch (e) { host = ''; } return `<a class="wa-gal-row link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${l.thumb ? `<img class="wa-gal-lthumb" src="${esc(l.thumb)}" alt="">` : '<span class="wa-gal-ico">🔗</span>'}<span class="wa-gal-meta"><b>${esc(l.title || host || u)}</b><small>${esc(l.desc || u)}</small><small>${esc([host, l.fromMe ? 'You' : '+' + l.sender, dayOf(l.ts)].filter(Boolean).join(' · '))}</small></span></a>`; }).join('');
      }
      box.innerHTML = `<div class="wa-gal-head"><h3>${esc(chat ? chat.name : 'Chat')} · Media, docs and links</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <div class="wa-gal-tabs"><button data-k="media" class="${kind === 'media' ? 'on' : ''}">Media <i>${counts.media}</i></button><button data-k="docs" class="${kind === 'docs' ? 'on' : ''}">Docs <i>${counts.docs}</i></button><button data-k="links" class="${kind === 'links' ? 'on' : ''}">Links <i>${counts.links}</i></button></div>
        <div class="wa-gal-body">${body}</div>`;
      box.querySelector('[data-x]').onclick = () => d.remove();
      box.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { if (b.dataset.k !== kind) { kind = b.dataset.k; go(); } }; });
      box.querySelectorAll('[data-id]').forEach((el) => {
        el.onclick = async () => {
          if (el.dataset.busy) return;
          const item = items.find((x) => x.id === el.dataset.id);
          el.dataset.busy = '1'; el.classList.add('busy');
          try {
            const r = await fetchFull(jid, item.id);
            if (kind === 'media') viewer(r, item); else download(r, item.text || item.type);
          } catch (e) { C.toast(e.message, 'err'); }
          delete el.dataset.busy; el.classList.remove('busy');
        };
      });
    };
    const go = async () => {
      render(null);
      try { render(await C.api(`${C.base}/gallery?jid=${encodeURIComponent(jid)}&kind=${kind}`)); }
      catch (e) { box.querySelector('.wa-gal-body').innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`; }
    };
    go();
  }

  /** Adds the gallery button to the chat header (called by app.js after the header is painted). */
  function decorateTop(top) {
    if (!top || top.querySelector('#waGalBtn')) return;
    const find = top.querySelector('#waFindBtn');
    if (!find) return;
    const b = document.createElement('button');
    b.className = 'wa-icon-btn'; b.id = 'waGalBtn'; b.title = 'Media, docs and links'; b.innerHTML = ICON;
    b.onclick = () => open(C.S.jid);
    find.parentNode.insertBefore(b, find);
  }

  function init(ctx) { C = ctx; }
  window.WAGAL = { init, open, decorateTop };
})();
