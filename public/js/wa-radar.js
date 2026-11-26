/* Ladybug Chat - Response Radar.
   WhatsApp tells you nothing about who is waiting on you. This reads the conversation history and
   answers three questions: which chats are waiting on a reply from you (and for how long), which chats
   are waiting on the other person, and how long each side typically takes to answer.

   Read-only arithmetic over the messages the console already holds - it never sends anything, and the
   numbers are medians so one very late night does not distort them.

   Loaded before app.js; app.js calls WRADAR.init(ctx). */
(function () {
  'use strict';

  let C = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const RANGES = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']];
  let range = 30;
  let cache = null;

  /** 95 -> "1m 35s", 9000 -> "2h 30m", 200000 -> "2d 7h" */
  function human(sec) {
    if (sec == null) return '—';
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 >= 30 ? ' ' + (s % 60) + 's' : '');
    if (s < 86400) return Math.floor(s / 3600) + 'h' + (Math.floor((s % 3600) / 60) ? ' ' + Math.floor((s % 3600) / 60) + 'm' : '');
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return d + 'd' + (h ? ' ' + h + 'h' : '');
  }

  /** A colour band so a long wait is obvious at a glance. */
  function heat(sec) {
    if (sec > 3 * 86400) return 'hot';
    if (sec > 86400) return 'warm';
    return 'cool';
  }

  /** Five-segment signal meter - filled segments track the heat band. */
  function meter(sec) {
    const band = heat(sec);
    const n = band === 'hot' ? 5 : band === 'warm' ? 3 : 1;
    let out = '<span class="wa-rad-meter ' + band + '">';
    for (let i = 0; i < 5; i++) out += '<i class="' + (i < n ? 'on' : '') + '"></i>';
    return out + '</span>';
  }

  function row(r, kind) {
    const chat = C.S.chats.find((x) => x.jid === r.jid);
    const av = C.avatarHtml(chat || { name: r.name, jid: r.jid, isGroup: r.isGroup });
    const reply = kind === 'me' ? r.theirReply : r.myReply;
    return `<div class="wa-rad-row" data-j="${esc(r.jid)}">
      ${av}
      <span class="wa-rad-main">
        <b>${esc(r.name)}</b>
        <small class="wa-sub">${esc(r.lastText || (r.isGroup ? 'Group message' : 'Message'))}</small>
      </span>
      <span class="wa-rad-nums">
        <em class="wa-rad-wait ${heat(r.waiting)}">${human(r.waiting)}</em>
        ${meter(r.waiting)}
        <small class="wa-sub">${reply != null ? 'replies in ' + human(reply) : 'no history'}</small>
      </span>
    </div>`;
  }

  /** The radar scope: rings, a rotating sweep and a few blips. It is decoration, but it is our decoration. */
  function scope() {
    return `<span class="wa-rad-scope" aria-hidden="true">
        <span class="wa-rad-ring r1"></span><span class="wa-rad-ring r2"></span><span class="wa-rad-ring r3"></span>
        <span class="wa-rad-sweep"></span>
        <span class="wa-rad-blip b1"></span><span class="wa-rad-blip b2"></span><span class="wa-rad-blip b3"></span>
        <span class="wa-rad-core"></span>
      </span>`;
  }

  function draw(d) {
    const t = d.totals || {};
    const onMe = d.waitingOnMe || [];
    const onThem = d.waitingOnThem || [];
    if (d.offline) return '<div class="chat-empty">The bot is offline, so there is no live history to read. Start it and try again.</div>';

    const hero = `<div class="wa-rad-hero">
        ${scope()}
        <span class="wa-rad-hero-txt">
          <em>Ladybug exclusive</em>
          <b>${t.onMe || 0} waiting on you</b>
          <small>${t.stale ? `${t.stale} of them over a day old` : 'Nothing older than a day'}</small>
        </span>
      </div>`;

    const stats = `<div class="wa-rad-stats">
        <div class="wa-rad-stat" data-accent="cyan"><b>${t.onMe || 0}</b><small>waiting on you</small></div>
        <div class="wa-rad-stat ${t.stale ? 'warn' : ''}" data-accent="amber"><b>${t.stale || 0}</b><small>over a day</small></div>
        <div class="wa-rad-stat" data-accent="violet"><b>${human(t.myReply)}</b><small>your usual reply</small></div>
        <div class="wa-rad-stat" data-accent="mint"><b>${human(t.theirReply)}</b><small>their usual reply</small></div>
      </div>`;

    const note = (t.mySamples || t.theirSamples)
      ? `<p class="wa-note">Based on ${t.mySamples || 0} of their messages you answered and ${t.theirSamples || 0} of yours they answered. Medians, so one slow night does not skew it.</p>`
      : '';

    return `${hero}${stats}${note}
      <h4 class="wa-sec">Waiting on you <i>${onMe.length}</i></h4>
      ${onMe.length ? onMe.map((r) => row(r, 'me')).join('') : '<div class="chat-empty">Nothing is waiting on you. Inbox clear.</div>'}
      <h4 class="wa-sec">Waiting on them <i>${onThem.length}</i></h4>
      ${onThem.length ? onThem.map((r) => row(r, 'them')).join('') : '<div class="chat-empty">You have not left anyone hanging.</div>'}`;
  }

  async function open() {
    const d = C.dialog(`<div class="wa-con-head"><h3>Response Radar</h3>
        <select id="waRadRange" class="wa-rad-sel">${RANGES.map(([v, t]) => `<option value="${v}" ${v === range ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="wa-rad-body" id="waRadBody"><div class="chat-empty">Reading conversations…</div></div>
      <p class="wa-note">Response Radar is a Ladybug feature — WhatsApp has no equivalent. It reads only the history this console already holds.</p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Close</button></div>`);
    const body = d.querySelector('#waRadBody');
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('#waRadRange').onchange = async (e) => { range = Number(e.target.value); cache = null; await load(body); };

    const wire = () => {
      body.querySelectorAll('[data-j]').forEach((el) => {
        el.onclick = () => { d.remove(); C.openChat(el.dataset.j); };
      });
    };
    await load(body);
    wire();
  }

  async function load(body) {
    try {
      if (!cache || cache.days !== range) {
        body.innerHTML = '<div class="chat-empty">Reading conversations…</div>';
        cache = await C.api(C.base + '/radar?days=' + range);
      }
      body.innerHTML = draw(cache);
      body.querySelectorAll('[data-j]').forEach((el) => {
        el.onclick = () => { C.openChat(el.dataset.j); const back = document.querySelector('.wa-dialog-back'); if (back) back.remove(); };
      });
    } catch (e) {
      body.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`;
    }
  }

  /** Small "N waiting" pill in the chat list header, so the number is visible without opening the panel. */
  async function badge() {
    const host = document.querySelector('#waRadBadge');
    if (!host) return;
    try {
      const d = await C.api(C.base + '/radar?days=' + range);
      const n = (d.totals && d.totals.onMe) || 0;
      const stale = (d.totals && d.totals.stale) || 0;
      host.textContent = n ? String(n) : '';
      host.hidden = !n;
      host.title = n ? `${n} chat${n === 1 ? '' : 's'} waiting on you${stale ? `, ${stale} over a day` : ''}` : 'Nothing waiting';
      host.classList.toggle('stale', stale > 0);
    } catch (e) { host.hidden = true; }
  }

  function init(ctx) { C = ctx; }

  window.WRADAR = { init, open, badge, human };
})();
