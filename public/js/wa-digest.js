/* Ladybug Chat — Chat Digest.
   A local summary of one conversation: topics, unanswered questions, requests and
   deadlines, decisions, links, highlights and activity. Computed by the platform from
   the bot's own message snapshot; no AI provider is called and no text leaves the server.
   Loaded before app.js; app.js calls WADIG.init(ctx) once the console is on screen. */
(function () {
  'use strict';

  let C = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2zm3 5h10v2H7V9zm0 4h7v2H7v-2z"/></svg>';
  const pad2 = (n) => String(n).padStart(2, '0');
  const when = (ts) => ts ? new Date(ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }

  function chatName(jid) {
    const c = C.S.chats.find((x) => x.jid === jid);
    return (c && c.name) || jid.split('@')[0];
  }

  function pickChat() {
    const d = dlg(`<h3>Chat Digest</h3>
      <p class="wa-note">Pick a chat to summarise. The digest is built on your server from this bot's own message history.</p>
      <div class="wa-fwd-list" id="wadPick">${C.S.chats.slice(0, 80).map((c) => `<div class="wa-fwd" data-j="${esc(c.jid)}"><span>${esc(c.name)}</span><small class="wad-muted">${esc(c.isGroup ? 'group' : '+' + String(c.jid).split('@')[0])}</small></div>`).join('') || '<div class="chat-empty">No chats yet.</div>'}</div>`);
    d.querySelectorAll('[data-j]').forEach((el) => { el.onclick = () => { d.remove(); open(el.dataset.j); }; });
  }

  function section(title, rows, empty) {
    if (!rows.length) return `<section class="wad-sec"><h4>${esc(title)}</h4><div class="wad-empty">${esc(empty || 'Nothing here.')}</div></section>`;
    return `<section class="wad-sec"><h4>${esc(title)} <i>${rows.length}</i></h4><div class="wad-rows">${rows.join('')}</div></section>`;
  }

  function line(item, badge) {
    return `<div class="wad-row" data-jump="${esc(item.jid || '')}">
      ${badge ? `<span class="wad-badge">${esc(badge)}</span>` : ''}
      <div class="wad-row-body"><div class="wad-row-text">${esc(item.text)}</div>
      <small class="wad-muted">${esc(item.who || '')}${item.who ? ' · ' : ''}${esc(when(item.ts))}</small></div></div>`;
  }

  function render(r, jid) {
    const t = r.totals || {};
    const name = (r.chat && r.chat.name) || chatName(jid);
    const maxH = Math.max(1, ...(r.activity.hours || [1]));
    const q = (r.questions || []).map((x) => line({ ...x, jid }, 'question'));
    const req = (r.requests || []).map((x) => line({ ...x, jid }, x.owner === 'you' ? 'you' : 'them'));
    const dec = (r.decisions || []).map((x) => line({ ...x, jid }, 'decision'));
    const links = (r.links || []).map((x) => `<div class="wad-row"><div class="wad-row-body"><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(x.url)}</a><small class="wad-muted">shared ${x.count}×</small></div></div>`);
    const hi = (r.highlights || []).map((x) => line({ ...x, jid }, 'highlight'));
    const people = (r.people || []).map((p) => `<span class="wad-person">${esc(p.name)} <i>${p.total}</i></span>`).join('');
    const kw = (r.keywords || []).map((k) => `<span class="wad-kw">${esc(k.word)} <i>${k.count}</i></span>`).join('') || '<span class="wad-muted">Not enough text to find topics.</span>';
    const media = Object.entries(r.media || {}).filter(([, n]) => n).map(([k, n]) => `<span class="wad-kw">${esc(k)} <i>${n}</i></span>`).join('');

    return `<div class="wa-gal-head"><h3>Chat Digest · ${esc(name)}</h3>
      <div class="wad-tools"><select id="wadDays" class="wad-select">${[7, 30, 90].map((d) => `<option value="${d}" ${d === r.span.days ? 'selected' : ''}>${d} days</option>`).join('')}</select>
      <button class="wa-icon-btn" data-x title="Close">✕</button></div></div>
      ${r.offline ? '<p class="wa-note">The bot is offline, so this digest uses the saved chat archive.</p>' : ''}
      <div class="wad-summary">${(r.summary || []).map((s) => `<p>${esc(s)}</p>`).join('')}</div>
      <div class="wad-stats">
        <div><b>${t.messages || 0}</b><span>messages</span></div>
        <div><b>${t.incoming || 0}</b><span>in</span></div>
        <div><b>${t.outgoing || 0}</b><span>out</span></div>
        <div><b>${(r.people || []).length}</b><span>people</span></div>
        <div><b>${(r.questions || []).length}</b><span>open questions</span></div>
        <div><b>${(r.links || []).length}</b><span>links</span></div>
      </div>
      <div class="wad-people">${people}</div>
      <section class="wad-sec"><h4>Topics</h4><div class="wad-kws">${kw}</div>${media ? `<div class="wad-kws wad-media">${media}</div>` : ''}</section>
      ${section('Waiting for a reply', q, 'No unanswered questions in this window.')}
      ${section('Requests and deadlines', req, 'No requests or deadlines found.')}
      ${section('Decisions and commitments', dec, 'No decisions recorded.')}
      ${section('Highlights', hi, 'Not enough long messages to pick highlights.')}
      ${section('Links shared', links, 'No links shared.')}
      <section class="wad-sec"><h4>When the chat happens</h4>
        <div class="wad-hours">${(r.activity.hours || []).map((v, h) => `<div class="wad-hour" title="${pad2(h)}:00 · ${v} messages"><i style="height:${Math.round((v / maxH) * 100)}%"></i><span>${h % 6 === 0 ? pad2(h) : ''}</span></div>`).join('')}</div>
        <div class="wad-muted wad-foot">${r.activity.busiestDay ? `Busiest day: ${esc(r.activity.busiestDay.day)} (${r.activity.busiestDay.count}). ` : ''}${r.activity.busiestHour != null ? `Busiest hour: ${pad2(r.activity.busiestHour)}:00. ` : ''}${r.truncated ? 'Based on the latest 200 messages. ' : ''}Computed on your server — nothing was sent to an AI service.</div>
      </section>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Done</button></div>`;
  }

  function open(jid) {
    jid = jid || C.S.jid;
    if (!jid) return pickChat();
    const d = dlg('<h3>Chat Digest</h3><div class="chat-empty">Reading the conversation…</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-gal-dialog', 'wad-wide');

    const load = async (days) => {
      box.innerHTML = '<div class="wa-gal-head"><h3>Chat Digest</h3><button class="wa-icon-btn" data-x>✕</button></div><div class="chat-empty">Reading the conversation…</div>';
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      try {
        const r = await C.api(C.base + '/digest?jid=' + encodeURIComponent(jid) + '&days=' + (days || 7));
        box.innerHTML = render(r, jid);
        box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
        box.querySelectorAll('[data-jump]').forEach((el) => {
          el.onclick = () => { const j = el.dataset.jump; if (j) { d.remove(); C.openChat(j); } };
        });
        const sel = box.querySelector('#wadDays');
        if (sel) sel.onchange = () => load(Number(sel.value));
      } catch (e) {
        box.innerHTML = `<div class="wa-gal-head"><h3>Chat Digest</h3><button class="wa-icon-btn" data-x>✕</button></div><div class="chat-empty">${esc(e.message)}</div>`;
        box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      }
    };
    load(7);
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    const grow = rail && rail.querySelector('.wa-rail-grow');
    if (rail && grow && !document.getElementById('wadBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'wadBtn'; b.title = 'Chat Digest — summarise this conversation'; b.innerHTML = ICON;
      b.onclick = () => open(C.S.jid);
      rail.insertBefore(b, grow);
    }
  }

  window.WADIG = { init, open, summarize: (jid, days) => C && C.api(C.base + '/digest?jid=' + encodeURIComponent(jid) + '&days=' + (days || 7)) };
})();
