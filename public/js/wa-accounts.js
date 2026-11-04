/* Ladybug Chat - multi-account manager.
   Link up to 12 WhatsApp numbers from inside the web client and switch between them
   from the left rail. Loaded before app.js; app.js calls WAACC.init(ctx) once the console is on screen.
   Linking uses the normal pairing-code flow (WhatsApp > Linked devices > Link with phone number). */
(function () {
  'use strict';

  const PALETTE = ['#00a884', '#e11d68', '#1da1f2', '#8b5cf6', '#f2711c', '#3fb56a', '#d4a017', '#ef4444', '#14b8a6', '#6366f1', '#ec4899', '#84cc16'];
  const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
  const fmtCode = (c) => { const x = String(c || '').replace(/[^A-Za-z0-9]/g, ''); return x.length === 8 ? x.slice(0, 4) + '-' + x.slice(4) : x; };

  let ctx = null;
  let st = { accounts: [], saved: [], max: 12 };
  let pair = { timer: null, job: null };

  const initial = (a) => String(a.name || a.waName || '#').trim().charAt(0).toUpperCase() || '#';
  const label = (a) => a.name + (a.number ? ' (+' + a.number + ')' : '');

  async function refresh() {
    try { st = await ctx.api('/api/web/accounts'); } catch (e) { /* keep the last list */ }
    paintRail();
    return st;
  }

  function go(id) { if (id && id !== ctx.bot.id) location.hash = '#/web?bot=' + encodeURIComponent(id); }

  /* ---------------------------------------------------------------- rail */
  function paintRail() {
    const box = document.getElementById('waAccounts');
    if (!box) return;
    const { esc } = ctx;
    const items = st.accounts.map((a) => {
      const on = a.id === ctx.bot.id;
      const live = a.running ? 'on' : 'off';
      return `<button class="wa-acc ${on ? 'cur' : ''}" data-acc="${esc(a.id)}" title="${esc(label(a))}${a.running ? '' : ' - offline'}" style="--acc:${hue(a.id)}"><span>${esc(initial(a))}</span><i class="wa-acc-dot ${live}"></i></button>`;
    }).join('');
    const full = st.accounts.length >= st.max;
    box.innerHTML = `${items}<button class="wa-acc add" id="waAccAdd" title="${full ? 'Account limit reached (' + st.max + ')' : 'Link another WhatsApp number'}" ${full ? 'disabled' : ''}>+</button><small class="wa-acc-count">${st.accounts.length}/${st.max}</small>`;
    box.querySelectorAll('[data-acc]').forEach((b) => { b.onclick = () => go(b.dataset.acc); });
    const add = document.getElementById('waAccAdd');
    if (add) add.onclick = () => openManager(true);
    const head = document.getElementById('waAccBtn');
    if (head) head.title = `WhatsApp accounts (${st.accounts.length}/${st.max})`;
  }

  /* ---------------------------------------------------------------- manager dialog */
  function stopPair() { clearInterval(pair.timer); pair.timer = null; }
  function cancelPair() {
    stopPair();
    if (pair.job) ctx.api('/api/session/pair/' + pair.job, { method: 'DELETE' }).catch(() => {});
    pair.job = null;
  }

  function openManager(focusLink) {
    const { esc, dialog, toast, api } = ctx;
    const d = dialog('<div class="wa-acc-dlg"></div>');
    const root = d.querySelector('.wa-acc-dlg');
    d.querySelector('.wa-dialog').classList.add('wa-acc-dialog');
    const close = () => { cancelPair(); d.remove(); };
    d.addEventListener('click', (e) => { if (e.target === d) cancelPair(); });

    async function draw() {
      await refresh();
      const full = st.accounts.length >= st.max;
      root.innerHTML = `
        <h3>WhatsApp accounts <small>${st.accounts.length} of ${st.max} linked</small></h3>
        <div class="wa-acc-list">
          ${st.accounts.map((a) => `
            <div class="wa-acc-row ${a.id === ctx.bot.id ? 'cur' : ''}">
              <span class="wa-acc-av" style="--acc:${hue(a.id)}">${esc(initial(a))}<i class="wa-acc-dot ${a.running ? 'on' : 'off'}"></i></span>
              <div class="wa-acc-info"><b>${esc(a.name)}</b><small>${a.number ? '+' + esc(a.number) : 'No number yet'} · ${a.running ? 'Online' : esc(a.suspendedReason || 'Offline')}</small></div>
              <div class="wa-acc-act">
                ${a.id === ctx.bot.id ? '<em>Open</em>' : `<button class="wa-btn" data-go="${esc(a.id)}">Switch</button>`}
                <button class="wa-btn ghost" data-rm="${esc(a.id)}" title="Unlink this number from the console">Remove</button>
              </div>
            </div>`).join('') || '<div class="chat-empty">No accounts yet.</div>'}
        </div>
        <h4 class="wa-sec">Link a new device</h4>
        <div id="waLinkBox">
          ${full ? `<p class="wa-acc-note">You have reached the limit of ${st.max} accounts. Remove one to link another number.</p>` : `
          <p class="wa-acc-note">Enter the number you want to link (with country code). WhatsApp will give you an 8-character code to type on that phone.</p>
          <div class="wa-acc-form">
            <input class="wa-dialog-input" id="waLinkPhone" inputmode="numeric" placeholder="e.g. 263771234567" autocomplete="off" />
            <input class="wa-dialog-input" id="waLinkName" maxlength="40" placeholder="Name (optional)" autocomplete="off" />
            <button class="wa-btn" id="waLinkGo">Get code</button>
          </div>`}
          <div id="waLinkOut"></div>
        </div>
        ${st.saved.length ? `<h4 class="wa-sec">Previously linked</h4><div class="wa-acc-list">${st.saved.map((s) => `
          <div class="wa-acc-row"><span class="wa-acc-av" style="--acc:${hue(s.id)}">${esc((s.label || s.waName || '+').charAt(0).toUpperCase())}</span>
          <div class="wa-acc-info"><b>${esc(s.label || s.waName || '+' + s.number)}</b><small>+${esc(s.number)} · saved session</small></div>
          <div class="wa-acc-act"><button class="wa-btn" data-restore="${esc(s.id)}" ${full ? 'disabled' : ''}>Restore</button></div></div>`).join('')}</div>` : ''}
        <div class="wa-dialog-act"><button class="wa-btn ghost" id="waAccClose">Close</button></div>`;

      root.querySelector('#waAccClose').onclick = close;
      root.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { close(); go(b.dataset.go); }; });
      root.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          const a = st.accounts.find((x) => x.id === b.dataset.rm);
          if (!a || !confirm(`Remove ${label(a)} from the console?\nThe bot stops. The number stays saved so you can restore it later.`)) return;
          try {
            await api('/api/bots/' + encodeURIComponent(a.id), { method: 'DELETE' });
            toast('Account removed', 'ok');
            if (a.id === ctx.bot.id) {
              const rest = st.accounts.filter((x) => x.id !== a.id);
              close();
              location.hash = rest.length ? '#/web?bot=' + rest[0].id : '#/dashboard';
              return;
            }
            draw();
          } catch (e) { toast(e.message, 'err'); }
        };
      });
      root.querySelectorAll('[data-restore]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await api('/api/web/accounts/restore', { method: 'POST', body: { deviceId: b.dataset.restore } });
            toast(r.start === 'started' ? 'Account restored and starting' : 'Restored: ' + r.start, r.start === 'started' ? 'ok' : 'err');
            close(); go(r.account.id);
          } catch (e) { b.disabled = false; toast(e.message, 'err'); }
        };
      });
      const go1 = root.querySelector('#waLinkGo');
      if (go1) {
        go1.onclick = startLink;
        root.querySelector('#waLinkPhone').addEventListener('keydown', (e) => { if (e.key === 'Enter') startLink(); });
        if (focusLink) root.querySelector('#waLinkPhone').focus();
      }
    }

    async function startLink() {
      const out = root.querySelector('#waLinkOut');
      const btn = root.querySelector('#waLinkGo');
      const phone = root.querySelector('#waLinkPhone').value.replace(/[^0-9]/g, '');
      const name = root.querySelector('#waLinkName').value.trim();
      if (phone.length < 7) { out.innerHTML = '<div class="pair-err">Enter a valid number with country code, digits only.</div>'; return; }
      cancelPair();
      btn.disabled = true; btn.textContent = 'Starting…';
      out.innerHTML = '<div class="pair-wait">Contacting WhatsApp…</div>';
      const reset = () => { btn.disabled = false; btn.textContent = 'Get code'; };
      try {
        const { job } = await api('/api/session/pair', { method: 'POST', body: { phone } });
        pair.job = job.id;
        show(job, out);
        pair.timer = setInterval(async () => {
          try {
            const r = await api('/api/session/pair/' + job.id);
            show(r.job, out);
            if (r.job.status === 'error') { stopPair(); reset(); }
            if (r.job.status === 'ready') {
              stopPair();
              out.innerHTML = '<div class="pair-wait">Linked. Setting up the account…</div>';
              try {
                const res = await api('/api/web/accounts/link', { method: 'POST', body: { jobId: job.id, name } });
                pair.job = null;
                toast(res.start === 'started' ? 'Device linked. Starting…' : 'Linked, but: ' + res.start, res.start === 'started' ? 'ok' : 'err');
                close(); go(res.account.id);
                if (res.account.id === ctx.bot.id) refresh();
              } catch (e) { out.innerHTML = `<div class="pair-err">${esc(e.message)}</div>`; reset(); }
            }
          } catch (e) { stopPair(); reset(); out.innerHTML = `<div class="pair-err">${esc(e.message)}</div>`; }
        }, 2000);
      } catch (e) { reset(); out.innerHTML = `<div class="pair-err">${esc(e.message)}</div>`; }
    }

    function show(job, out) {
      if (job.status === 'error') { out.innerHTML = `<div class="pair-err">${esc(job.message || 'Pairing failed')}</div>`; return; }
      if (job.status === 'code' && job.code) {
        out.innerHTML = `<div class="wa-acc-code"><div class="wa-acc-codebig">${esc(fmtCode(job.code))}</div>
          <ol><li>Open WhatsApp on <b>+${esc(job.phone)}</b></li><li>Settings, then <b>Linked devices</b>, then <b>Link a device</b></li><li>Choose <b>Link with phone number instead</b> and type this code</li></ol>
          <small>Waiting for you to enter the code. It expires in a few minutes.</small></div>`;
      } else out.innerHTML = `<div class="pair-wait">${esc(job.message || 'Starting…')}</div>`;
    }

    draw();
  }

  function init(c) {
    ctx = c;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waAccounts')) {
      const box = document.createElement('div');
      box.id = 'waAccounts';
      box.className = 'wa-accounts';
      const grow = rail.querySelector('.wa-rail-grow');
      rail.insertBefore(box, grow);
    }
    const icons = document.querySelector('.wa-side-icons');
    if (icons && !document.getElementById('waAccBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-icon-btn';
      b.id = 'waAccBtn';
      b.title = 'WhatsApp accounts';
      b.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.300 0-7 1.200-7 3.500V19h14v-2.500C15 14.200 10.300 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.200.8 2 1.900 2 3.400V19h6v-2.500c0-2.300-4.700-3.500-7-3.500z"/></svg>';
      b.onclick = () => openManager(false);
      icons.insertBefore(b, icons.firstChild);
    }
    refresh();
    clearInterval(init._t);
    init._t = setInterval(() => { if (document.getElementById('waAccounts')) refresh(); else clearInterval(init._t); }, 20000);
  }

  window.WAACC = { init, open: openManager };
})();
