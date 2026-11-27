/* Ladybug Cloud - human takeover.
 *
 * The built-in brain answers every chat it can. The moment the owner answers a chat
 * themselves - from their phone or from this console - the bot stands down in *that* chat
 * only, so the two of them never talk over each other. Every pause expires on its own,
 * because the failure that actually hurts is a forgotten pause leaving a customer on read.
 *
 * The pause itself is enforced by the bot (utils/webBridge.js); this file is the console
 * side: the "bot paused" pill in the chat header, and a panel to resume chats or change how
 * long a pause lasts. Loaded before app.js; app.js calls WAPAUSE.init(ctx).
 */
(function () {
  let C = null;
  let state = { paused: [], hours: 8 };
  let timer = null;
  let busy = false;

  const ICON = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5h3v14H8zm5 0h3v14h-3z"/></svg>';

  function esc(s) { return C ? C.esc(s) : String(s == null ? '' : s); }

  /** Chat name for a jid, falling back to the bare number. */
  function nameOf(jid) {
    const c = C && C.S && C.S.chats ? C.S.chats.find((x) => x.jid === jid) : null;
    if (c && c.name) return c.name;
    return String(jid || '').split('@')[0];
  }

  function isPaused(jid) {
    return state.paused.some((p) => p.jid === jid);
  }

  function leftText(p) {
    if (!p.until) return 'until you resume it';
    if (p.leftMin <= 0) return 'expiring now';
    if (p.leftMin < 60) return p.leftMin + ' min left';
    const h = Math.round(p.leftMin / 60);
    return h + (h === 1 ? ' hour left' : ' hours left');
  }

  async function load() {
    const r = await C.api(C.base + '/paused');
    state.paused = Array.isArray(r.paused) ? r.paused : [];
    state.hours = typeof r.hours === 'number' ? r.hours : 8;
    return state;
  }

  async function post(body) {
    return C.api(C.base + '/pause', { method: 'POST', body });
  }

  async function pause(jid) {
    if (busy) return;
    busy = true;
    try {
      const r = await post({ jid });
      state.paused = Array.isArray(r.paused) ? r.paused : state.paused;
      state.hours = typeof r.hours === 'number' ? r.hours : state.hours;
      C.toast('Bot paused in this chat' + (r.applied ? '' : ' (takes effect when the bot starts)'));
      if (C.paintTop) C.paintTop();
      return r;
    } catch (e) {
      C.toast(e.message || 'Could not pause the bot');
    } finally { busy = false; }
  }

  async function resume(jid) {
    if (busy) return;
    busy = true;
    try {
      const r = await post({ jid, resume: true });
      state.paused = Array.isArray(r.paused) ? r.paused : state.paused.filter((p) => p.jid !== jid);
      C.toast('Bot is answering this chat again');
      if (C.paintTop) C.paintTop();
      return r;
    } catch (e) {
      C.toast(e.message || 'Could not resume the bot');
    } finally { busy = false; }
  }

  async function resumeAll() {
    if (busy) return;
    busy = true;
    try {
      const r = await post({ all: true });
      state.paused = [];
      C.toast('Bot is answering every chat again');
      if (C.paintTop) C.paintTop();
      return r;
    } catch (e) {
      C.toast(e.message || 'Could not resume');
    } finally { busy = false; }
  }

  async function setHours(h) {
    try {
      const r = await post({ hours: h });
      state.hours = r.hours;
      C.toast('New pauses last ' + (r.hours ? r.hours + ' hours' : 'until you resume them'));
      return r;
    } catch (e) { C.toast(e.message || 'Could not save'); }
  }

  /* ---- the pill in the chat header ---- */
  function decorateTop(top) {
    if (!top || !C || !C.S || !C.S.jid) return;
    const jid = C.S.jid;
    const old = top.querySelector('#waPausePill');
    if (!isPaused(jid)) { if (old) old.remove(); return; }
    if (old) return;
    const find = top.querySelector('#waFindBtn');
    if (!find) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'waPausePill';
    b.className = 'wa-pause-pill';
    b.title = 'The bot is not answering this chat. Click to let it answer again.';
    b.innerHTML = '<span class="wa-pause-dot"></span>Bot paused';
    b.onclick = () => resume(jid);
    find.parentNode.insertBefore(b, find);
  }

  /* ---- the panel ---- */
  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }

  function panel() {
    const rows = state.paused.length
      ? state.paused.map((p) => `<div class="wa-pause-row" data-row="${esc(p.jid)}">
          <div class="wa-pause-who"><b>${esc(nameOf(p.jid))}</b><span>${esc(leftText(p))} &middot; ${esc(p.reason === 'console' ? 'you replied here' : p.reason === 'owner' ? 'you replied on your phone' : 'paused by hand')}</span></div>
          <button type="button" class="wa-btn ghost" data-resume="${esc(p.jid)}">Resume</button>
        </div>`).join('')
      : '<p class="wa-note">No chats are paused. The bot is answering everything it can.</p>';

    const openJid = C.S && C.S.jid;
    const canPause = openJid && !isPaused(openJid);

    return `<div class="wa-pause">
      <div class="wa-pause-head">
        <div class="wa-pause-title">${ICON}<div><b>Human takeover</b><span>The bot stands down in a chat the moment you reply to it.</span></div></div>
        <button type="button" class="wa-icon-btn" data-x title="Close">&times;</button>
      </div>
      <div class="wa-pause-body">
        <div class="wa-pause-card">
          <div class="wa-pause-card-head">Paused chats <span class="wa-pause-count">${state.paused.length}</span></div>
          ${rows}
          ${state.paused.length ? '<div class="wa-pause-foot"><button type="button" class="wa-btn" data-all>Resume all</button></div>' : ''}
        </div>

        <div class="wa-pause-card">
          <div class="wa-pause-card-head">When you take over</div>
          <label class="wa-pause-field">
            <span>A pause lasts</span>
            <select id="waPauseHours">
              ${[1, 2, 4, 8, 24, 72, 0].map((h) => `<option value="${h}"${h === state.hours ? ' selected' : ''}>${h === 0 ? 'until I resume it' : h + (h === 1 ? ' hour' : ' hours')}</option>`).join('')}
            </select>
          </label>
          <p class="wa-note">Every pause expires by itself, so a chat you forget about can never leave a customer waiting forever. Complaints and anyone asking for a human are still handed to you straight away.</p>
        </div>

        ${canPause ? `<div class="wa-pause-card">
          <div class="wa-pause-card-head">This chat</div>
          <p class="wa-note">Stop the bot answering <b>${esc(nameOf(openJid))}</b> without replying yourself.</p>
          <div class="wa-pause-foot"><button type="button" class="wa-btn ghost" data-pause="${esc(openJid)}">Pause the bot here</button></div>
        </div>` : ''}
      </div>
    </div>`;
  }

  function wire(d) {
    d.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => d.remove()));
    d.querySelectorAll('[data-resume]').forEach((b) => {
      b.onclick = async () => {
        await resume(b.dataset.resume);
        const back = dlg(panel());
        wire(back);
      };
    });
    const all = d.querySelector('[data-all]');
    if (all) all.onclick = async () => { await resumeAll(); const back = dlg(panel()); wire(back); };
    const pz = d.querySelector('[data-pause]');
    if (pz) pz.onclick = async () => { await pause(pz.dataset.pause); const back = dlg(panel()); wire(back); };
    const sel = d.querySelector('#waPauseHours');
    if (sel) sel.onchange = () => setHours(Number(sel.value));
    d.addEventListener('click', (e) => { if (e.target === d) d.remove(); });
  }

  async function open() {
    try { await load(); } catch (e) { C.toast(e.message || 'Could not load paused chats'); }
    const d = dlg(panel());
    wire(d);
    return d;
  }

  function init(ctx) {
    C = ctx;
    load().catch(() => {});
    // Keep the header pill honest without a stream hook: a pause made on the phone is
    // reported by the bot, and this picks it up within a few seconds.
    clearInterval(timer);
    timer = setInterval(() => {
      load().then(() => { if (C.paintTop) C.paintTop(); }).catch(() => {});
    }, 20000);
    if (timer.unref) timer.unref();
  }

  window.WAPAUSE = { init, open, decorateTop, isPaused, pause, resume, resumeAll, load };
})();
