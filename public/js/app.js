/* Ladybug Cloud — frontend SPA */

const state = { user: null, bots: [], limit: 1, adminTab: 'overview', logTimer: null };

/* ---------------------------------------------------------------- utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind} show`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (res.status === 401 && state.user && !path.startsWith('/api/auth/')) {
    // account no longer exists server-side (e.g. data reset) - send to login cleanly
    state.user = null;
    location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

function fmtLeft(ms) {
  if (ms <= 0) return '0m';
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

/* ---------------------------------------------------------------- zig + unread helpers */
function zigFmt(usd, rate) {
  if (!rate) return '';
  return 'ZiG ' + (Math.round(usd * rate * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function refreshUnread() {
  if (!state.user) { state.unread = 0; state.adminUnread = 0; return; }
  try {
    const r = await api('/api/messages/unread');
    state.unread = r.unread || 0;
    state.adminUnread = r.adminUnread || 0;
    state.pendingPayments = r.pendingPayments || 0;
  } catch (e) { /* ignore */ }
  const n = $('#navMsgN');
  if (n) {
    const total = (state.unread || 0) + (state.adminUnread || 0) + (state.pendingPayments || 0);
    n.textContent = total; n.style.display = total ? '' : 'none';
  }
}

/* ---------------------------------------------------------------- wallet */
function walletHTML(b) {
  const c = b.config;
  const now = Date.now();
  let planTitle, planSub, pct = 0, tone = 'ok';
  if (b.mode === 'admin') {
    planTitle = 'Admin'; planSub = 'Unlimited hosting, no coins needed.'; pct = 100;
  } else if (b.mode === 'subscription') {
    planTitle = `Unlimited`;
    planSub = `Active for <b data-left="${b.subscriptionUntil}">${fmtLeft(b.subscriptionUntil - now)}</b>. Your bot runs without spending coins.`;
    pct = Math.min(100, ((b.subscriptionUntil - now) / (c.subscriptionDays * 86400000)) * 100);
  } else if (b.mode === 'trial') {
    planTitle = `Free trial`;
    planSub = `<b data-left="${b.trialEndsAt}">${fmtLeft(b.trialEndsAt - now)}</b> left. After that a bot costs ${c.botCoinCost} coins ${c.botPeriodDays === 1 ? 'per day' : 'per ' + c.botPeriodDays + ' days'}, or subscribe for $${c.priceUsd}/month.`;
    pct = Math.max(0, Math.min(100, ((b.trialEndsAt - now) / (c.trialDays * 86400000)) * 100));
  } else {
    planTitle = 'Daily coins';
    planSub = `Your bot costs <b>${c.botCoinCost} coins</b> ${c.botPeriodDays === 1 ? 'per day' : 'per ' + c.botPeriodDays + ' days'}. Claim ${c.claimCoins} free coins every day to keep it online, or subscribe for $${c.priceUsd}/month.`;
    pct = Math.min(100, ((b.totalCoins || b.coins) / c.botCoinCost) * 100); tone = (b.totalCoins || b.coins) >= c.botCoinCost ? 'ok' : 'warn';
  }
  const claimBtn = b.canClaim
    ? `<button class="btn btn-primary btn-claim" id="claimBtn">Claim ${c.claimCoins} free coins</button>`
    : `<button class="btn btn-claim" disabled id="claimBtn">Next claim in&nbsp;<span data-left="${b.nextClaimAt}">${fmtLeft(b.nextClaimAt - now)}</span></button>`;
  const sub = b.mode === 'subscription' || b.mode === 'admin' ? '' : (c.paymentUrl
    ? `<a class="btn" href="${esc(c.paymentUrl)}${c.paymentUrl.includes('?') ? '&' : '?'}client_reference_id=${encodeURIComponent(state.user.username)}" target="_blank" rel="noopener">Subscribe for $${c.priceUsd}/month</a>`
    : `<button class="btn" id="subBtn">Subscribe for $${c.priceUsd}/month${b.zigPerUsd ? ` <span class="zig-inline">(${zigFmt(c.priceUsd, b.zigPerUsd)})</span>` : ''}</button>`);
  const payRow = `<div class="pay-row"><a class="btn btn-sm btn-primary" href="#/pay?buy=coins100">Buy coins</a><a class="btn btn-sm" href="#/pay">Payment details &amp; ZiG prices</a><a class="btn btn-sm btn-ghost" href="#/support">Contact admin</a></div>`;

  // Auto-claim add-on ($2/month) — the server claims the daily coins for you.
  const ac = b.autoClaim || {};
  let autoClaim;
  if (ac.active) {
    autoClaim = `<div class="autoclaim on">
        <div class="autoclaim-top"><span class="dot-ok"></span><b>Auto-claim on</b>
          <span class="autoclaim-left">renews in <span data-left="${ac.until}">${fmtLeft(ac.until - now)}</span></span></div>
        <p>We claim your ${c.claimCoins} coins every ${c.claimCooldownHours || 24}h for you — you'll never lose a bot to a forgotten claim.</p>
      </div>`;
  } else if (ac.requested) {
    autoClaim = `<div class="autoclaim off pending">
        <div class="autoclaim-top"><b>Auto-claim</b><span class="autoclaim-left">pending</span></div>
        <p>Request received. The admin will switch it on for you \u2014 no payment needed until then.</p>
      </div>`;
  } else if (ac.redundant) {
    autoClaim = `<div class="autoclaim off">
        <div class="autoclaim-top"><b>Auto-claim</b><span class="autoclaim-left">not needed</span></div>
        <p>Your plan already runs without coins, so there is nothing to claim.</p>
      </div>`;
  } else {
    autoClaim = `<div class="autoclaim off">
        <div class="autoclaim-top"><b>Auto-claim</b><span class="autoclaim-left">$${ac.priceUsd}/month</span></div>
        <p>Never lose a bot to a forgotten claim. We claim your ${c.claimCoins} daily coins automatically.</p>
        <button class="btn btn-sm btn-autoclaim" id="autoClaimBtn">Turn on auto-claim</button>
      </div>`;
  }
  // Extra bot slot add-on ($1/month each) \u2014 stacks on the plan limit.
  const es = b.extraSlots || {};
  let slots;
  if (es.active) {
    slots = `<div class="autoclaim on">
        <div class="autoclaim-top"><span class="dot-ok"></span><b>${es.count} extra slot${es.count > 1 ? 's' : ''} on</b>
          <span class="autoclaim-left">renews in <span data-left="${es.until}">${fmtLeft(es.until - now)}</span></span></div>
        <p>You can run up to <b>${es.botLimit}</b> bot${es.botLimit > 1 ? 's' : ''} at once. Add another for $${es.priceUsd}/month.</p>
        <button class="btn btn-sm btn-autoclaim" id="slotBtn">Add another slot</button>
      </div>`;
  } else if (es.requested) {
    slots = `<div class="autoclaim off pending">
        <div class="autoclaim-top"><b>Extra bot slot</b><span class="autoclaim-left">pending</span></div>
        <p>Request received. The admin will switch it on for you \u2014 no payment needed until then.</p>
      </div>`;
  } else {
    slots = `<div class="autoclaim off">
        <div class="autoclaim-top"><b>Extra bot slot</b><span class="autoclaim-left">$${es.priceUsd}/month</span></div>
        <p>Running ${es.botLimit} bot${es.botLimit > 1 ? 's' : ''}? Add one more without jumping to Unlimited.</p>
        <button class="btn btn-sm btn-autoclaim" id="slotBtn">Add a bot slot</button>
      </div>`;
  }
  const log = (b.log || []).map((l) => `<div class="log-row"><span>${esc(l.reason)}</span><b class="${l.delta >= 0 ? 'plus' : 'minus'}">${l.delta >= 0 ? '+' : ''}${l.delta}</b></div>`).join('');
  return `
  <div class="wallet">
    <div class="wallet-plan">
      <div class="k">Plan</div>
      <div class="wallet-title">${planTitle}</div>
      <div class="wallet-sub">${planSub}</div>
      <div class="meter ${tone}"><span style="width:${pct}%"></span></div>
    </div>
    <div class="wallet-coins">
      <div class="k">Coins</div>
      <div class="coin-big"><i class="coin-dot"></i>${b.coins}<small>of ${c.maxCoins} max</small></div>
      ${b.bonusCoins ? `<div class="bonus-coins"><i class="coin-dot"></i><b>+${b.bonusCoins}</b> bought coins <small>never capped, used after your free coins</small></div>` : ''}
      <div class="wallet-actions">${claimBtn}${sub}</div>
      ${autoClaim}
      ${slots}
      ${payRow}
      ${log ? `<details class="coin-log"><summary>Recent activity</summary>${log}</details>` : ''}
    </div>
  </div>`;
}

async function loadWallet() {
  const el = $('#wallet');
  if (!el) return;
  try {
    const b = await api('/api/billing');
    state.billing = b;
    el.innerHTML = walletHTML(b);
    renderNavCoins();
    const cb = $('#claimBtn');
    if (cb && !cb.disabled) cb.onclick = async () => {
      cb.disabled = true; cb.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api('/api/coins/claim', { method: 'POST' });
        toast(`+${r.added} coins claimed`);
      } catch (e) { toast(e.message, 'err'); }
      loadWallet();
    };
    const sb = $('#subBtn');
    if (sb) sb.onclick = () => { location.hash = '#/pay'; };
    const ab = $('#autoClaimBtn');
    if (ab) ab.onclick = async () => {
      ab.disabled = true; ab.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api('/api/billing/autoclaim', { method: 'POST' });
        if (r.url) { window.open(r.url, '_blank', 'noopener'); toast('Finish the payment to switch it on.', 'ok'); }
        else { toast(r.message || 'Auto-claim requested.', 'ok'); if (r.manual) location.hash = '#/pay'; }
      } catch (e) { toast(e.message, 'err'); }
      loadWallet();
    };
    const slb = $('#slotBtn');
    if (slb) slb.onclick = async () => {
      slb.disabled = true; slb.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api('/api/billing/slots', { method: 'POST', body: { count: 1 } });
        if (r.url) { window.open(r.url, '_blank', 'noopener'); toast('Finish the payment to add the slot.', 'ok'); }
        else { toast(r.message || 'Slot requested.', 'ok'); if (r.manual) location.hash = '#/pay'; }
      } catch (e) { toast(e.message, 'err'); }
      loadWallet();
    };
  } catch (e) { /* ignore */ }
}

function renderNavCoins() {
  const n = $('#navCoinsN');
  if (n && state.billing) n.textContent = state.billing.totalCoins != null ? state.billing.totalCoins : state.billing.coins;
}

// live countdowns
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach((el) => {
    el.textContent = fmtLeft(Date.now() - Number(el.dataset.since));
  });
}, 1000);
setInterval(() => {
  document.querySelectorAll('[data-left]').forEach((el) => {
    el.textContent = fmtLeft(Number(el.dataset.left) - Date.now());
  });
}, 30000);

/* ---------------------------------------------------------------- router */
const routes = {
  '/': renderLanding,
  '/pricing': renderLanding,
  '/login': renderLogin,
  '/register': renderRegister,
  '/dashboard': renderDashboard,
  '/status': renderStatus,
  '/admin': renderAdmin,
  '/pay': renderPay,
  '/support': renderSupport,
  '/settings': renderSettings,
  '/storage': renderStorage,
};

async function navigate() {
  const hash = location.hash.replace('#', '') || '/';
  const path = hash.split('?')[0];
  const refM = /[?&]ref=([^&]+)/.exec(hash);
  if (refM) { try { localStorage.setItem('lb_ref', decodeURIComponent(refM[1]).slice(0, 40)); } catch (e) { /* ignore */ } }
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }

  // refresh session
  try {
    const r = await api('/api/auth/me');
    state.user = r.user;
  } catch (e) { state.user = null; }

  document.body.dataset.page = path;
  renderNav();
  refreshUnread();

  const fn = routes[path] || renderLanding;
  await fn();
  if (path === '/pricing' && $('#pricing')) $('#pricing').scrollIntoView();
  else window.scrollTo(0, 0);
}

function renderNav() {
  const el = $('#navLinks');
  if (state.user) {
    const coins = state.billing ? (state.billing.totalCoins != null ? state.billing.totalCoins : state.billing.coins) : state.user.coins || 0;
    el.innerHTML = `
      <a href="#/dashboard" class="nav-link hide-sm">Dashboard</a>
      <a href="#/storage" class="nav-link hide-sm">Storage</a>
      <a href="#/pay" class="nav-link hide-sm">Pay</a>
      <a href="#/support" class="nav-link hide-sm">Contact admin</a>
      <a href="#/settings" class="nav-link hide-sm">Settings</a>
      <a href="#/status" class="nav-link hide-sm">Status</a>
      ${state.user.isAdmin ? '<a href="#/admin" class="nav-link hide-sm">Admin</a>' : ''}
      <span class="nav-sep hide-sm"></span>
      <a href="#/support" class="msg-chip" title="Messages"><span aria-hidden="true">&#9993;</span><span class="msg-n" id="navMsgN" style="display:none">0</span></a>
      <a href="#/dashboard" class="coin-chip" id="navCoins" title="Your coins"><i class="coin-dot"></i><span id="navCoinsN">${coins}</span></a>
      <button class="btn btn-sm btn-ghost" id="logoutBtn" title="Signed in as ${esc(state.user.username)}">Log out</button>`;
    $('#logoutBtn').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' });
      state.billing = null;
      toast('Logged out');
      location.hash = '#/';
    };
  } else {
    el.innerHTML = `
      <a href="#/pricing" class="nav-link hide-sm">Pricing</a>
      <a href="#/status" class="nav-link hide-sm">Status</a>
      <a href="#/login" class="nav-link">Log in</a>
      <a href="#/register" class="btn btn-primary btn-sm">Start free trial</a>`;
  }
}

/* ---------------------------------------------------------------- landing */
async function renderLanding() {
  const price = 3;
  $('#view').innerHTML = `
  <section class="hero">
    <div class="hero-bg" aria-hidden="true">
      <div class="hero-grid-lines"></div>
      <div class="orb orb-1"></div>
      <div class="orb orb-2"></div>
      <div class="orb orb-3"></div>
    </div>
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <span class="hero-eyebrow reveal"><i class="dot"></i> Built for group admins &amp; creators</span>
        <h1 class="reveal">Your WhatsApp bot,<br><span class="grad">online in two minutes.</span></h1>
        <p class="lead reveal">Link your number, press start, and Ladybug Cloud keeps <b>Ladybug Mini</b> running around the clock. <b>7 days free</b> &mdash; then claim 20 coins a day, or pay $${price}/month and forget about it.</p>
        <div class="hero-cta reveal">
          <a href="#/register" class="btn btn-primary btn-lg">Start free &mdash; no card <span class="arrow">&rarr;</span></a>
          <a href="#/pricing" class="btn btn-lg btn-outline">See pricing</a>
        </div>
        <ul class="hero-ticks reveal">
          <li><span>&#9889;</span> Live in ~2 minutes</li>
          <li><span>&#128274;</span> Session stays private</li>
          <li><span>&#8734;</span> 24/7 uptime</li>
        </ul>
      </div>

      <div class="hero-visual reveal">
        <div class="phone">
          <div class="phone-notch"></div>
          <div class="phone-screen">
            <div class="wa-head">
              <div class="wa-back">&#8249;</div>
              <div class="wa-avatar">&#128027;</div>
              <div class="wa-id"><b>Ladybug Mini</b><span>online</span></div>
              <div class="wa-icons"><span>&#128247;</span><span>&#8942;</span></div>
            </div>
            <div class="wa-chat">
              <div class="wa-day">TODAY</div>
              <div class="wa-msg out">.menu<span class="wa-time">12:04 <i>&#10003;&#10003;</i></span></div>
              <div class="wa-msg in menu">
                <div class="wa-menu-title">&#128027; LADYBUG MINI</div>
                <div class="wa-menu-row"><span>Owner</span><em>.autostatus .setprefix</em></div>
                <div class="wa-menu-row"><span>Admin</span><em>.antilink .welcome .tagall</em></div>
                <div class="wa-menu-row"><span>Downloader</span><em>.play .ytmp4 .tiktok</em></div>
                <div class="wa-menu-row"><span>General</span><em>.ai .sticker .vv</em></div>
                <div class="wa-menu-foot">42 commands ready &middot; prefix .</div>
                <span class="wa-time">12:04</span>
              </div>
              <div class="wa-msg out">.sticker<span class="wa-time">12:05 <i>&#10003;&#10003;</i></span></div>
              <div class="wa-msg in">Sticker created <span class="wa-emoji">&#128027;</span><span class="wa-time">12:05</span></div>
              <div class="wa-typing"><i></i><i></i><i></i></div>
            </div>
          </div>
        </div>

        <div class="float-log" aria-hidden="true">
          <div class="fl-bar"><span class="fl-dots"><i></i><i></i><i></i></span><b>live log</b></div>
          <div class="fl-body" id="heroLog"></div>
        </div>

        <div class="float-status" aria-hidden="true">
          <span class="fs-dot"></span>
          <div><b>ladybug-mini</b><span>Running &middot; 3d 4h uptime</span></div>
        </div>
      </div>
    </div>

    <div class="wrap">
      <div class="trust-strip reveal">
        <span>Runs <b>Ladybug Mini</b></span><i></i>
        <span>No coding required</span><i></i>
        <span>One bot per account</span><i></i>
        <span>Backed up automatically</span>
      </div>
    </div>
  </section>

  <div class="marquee" aria-hidden="true">
    <div class="marquee-track">
      ${['.autostatus','.antilink','.welcome','.tagall','.play','.ytmp4','.tiktok','.ai','.sticker','.vv','.antispam','.broadcast','.setprefix','.lyrics','.translate','.antidelete','.instagram','.textmaker']
        .map(c => `<span>${c}</span>`).join('')}
      ${['.autostatus','.antilink','.welcome','.tagall','.play','.ytmp4','.tiktok','.ai','.sticker','.vv','.antispam','.broadcast','.setprefix','.lyrics','.translate','.antidelete','.instagram','.textmaker']
        .map(c => `<span>${c}</span>`).join('')}
    </div>
  </div>

  <section class="stats-band">
    <div class="wrap stats-band-inner">
      <div class="sb-item reveal"><b>~2 min</b><span>From sign-up to live</span></div>
      <div class="sb-item reveal"><b>24/7</b><span>Always-on hosting</span></div>
      <div class="sb-item reveal"><b>42+</b><span>Bot commands</span></div>
      <div class="sb-item reveal"><b>7 days</b><span>Free, no card</span></div>
    </div>
  </section>

  <section class="section" id="commands">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">Real bot commands</span>
        <h2>What your bot can do</h2>
        <p>Not marketing fluff &mdash; these are the command categories live on your Ladybug Mini bot. Sign up and start using them with your prefix.</p>
      </div>
      <div class="cmd-grid">
        <article class="cmd-card reveal" data-accent="amber">
          <div class="cmd-top"><div class="cmd-icon">&#128081;</div><span class="cmd-count">14+ cmds</span></div>
          <h3>Owner</h3>
          <p>Control your bot account &mdash; status, privacy, branding &amp; broadcasts.</p>
          <div class="chips"><span>.autostatus</span><span>.savestatus</span><span>.autoread</span><span>.antidelete</span><span>.setprefix</span><span>.broadcast</span><span class="more">+8 more</span></div>
        </article>
        <article class="cmd-card reveal" data-accent="sky">
          <div class="cmd-top"><div class="cmd-icon">&#128737;</div><span class="cmd-count">14+ cmds</span></div>
          <h3>Admin</h3>
          <p>Keep groups clean &mdash; anti-spam, links, bots, tags &amp; welcome flows.</p>
          <div class="chips"><span>.antilink</span><span>.antispam</span><span>.antibot</span><span>.welcome</span><span>.tagall</span><span>.warn</span><span class="more">+8 more</span></div>
        </article>
        <article class="cmd-card reveal" data-accent="violet">
          <div class="cmd-top"><div class="cmd-icon">&#11015;</div><span class="cmd-count">10+ cmds</span></div>
          <h3>Downloader</h3>
          <p>Pull media from the apps you already use &mdash; fast and simple.</p>
          <div class="chips"><span>.play</span><span>.ytmp4</span><span>.tiktok</span><span>.instagram</span><span>.facebook</span><span>.lyrics</span><span class="more">+4 more</span></div>
        </article>
        <article class="cmd-card reveal" data-accent="mint">
          <div class="cmd-top"><div class="cmd-icon">&#10024;</div><span class="cmd-count">14+ cmds</span></div>
          <h3>General</h3>
          <p>AI, stickers, view-once tools, text styles &amp; fun for every chat.</p>
          <div class="chips"><span>.ai</span><span>.sticker</span><span>.vv</span><span>.viewonce</span><span>.textmaker</span><span>.translate</span><span class="more">+8 more</span></div>
        </article>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">How it works</span>
        <h2>Online in three steps</h2>
        <p>No server, no terminal, no config files. Most people are live in minutes.</p>
      </div>
      <div class="step-row">
        <div class="step-card reveal">
          <div class="step-num">1</div>
          <span class="step-tag">Get session</span>
          <h3>Link your number</h3>
          <p>Enter your phone number and we show an 8-digit code. Type it into WhatsApp under <b>Linked devices</b> &mdash; or paste an existing session ID.</p>
        </div>
        <div class="step-card reveal">
          <div class="step-num">2</div>
          <span class="step-tag">Press start</span>
          <h3>Bot goes live</h3>
          <p>Your bot gets its own private process and connects in seconds. Watch the live log to see exactly what it is doing.</p>
        </div>
        <div class="step-card reveal">
          <div class="step-num">3</div>
          <span class="step-tag">Stay online</span>
          <h3>Keep it running</h3>
          <p>Claim 20 free coins each day &mdash; that covers a bot for 24 hours. Or subscribe and it runs without using coins.</p>
        </div>
        <div class="step-line" aria-hidden="true"></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">Built to stay online</span>
        <h2>Everything you need, nothing you don't</h2>
        <p>Reliability is the product. Ladybug Cloud handles the hard parts so your bot just works.</p>
      </div>
      <div class="bento">
        <div class="bento-card lg reveal">
          <div class="bento-head"><div class="feat-ic">&#128220;</div><div><h3>Live logs, streamed</h3><p>Your bot's console streams straight into the dashboard, so problems are easy to spot and fix.</p></div></div>
          <div class="term" aria-hidden="true">
            <div class="term-bar"><span class="term-dots"><i></i><i></i><i></i></span><b>ladybug-mini &mdash; console</b></div>
            <div class="term-body" id="bentoLog"></div>
          </div>
        </div>
        <div class="bento-card tall reveal">
          <div class="feat-ic">&#128241;</div>
          <h3>Pair in the browser</h3>
          <p>Generate a session without installing anything on your computer. No Node, no terminal, no config files.</p>
          <div class="pair-visual" aria-hidden="true">
            <div class="pv-code">8 4 2 1 9 3 6 7</div>
            <div class="pv-label">Pairing code &middot; expires in 60s</div>
          </div>
        </div>
        <div class="bento-card reveal"><div class="feat-ic">&#128260;</div><h3>Automatic restarts</h3><p>If the bot crashes, it comes back on its own with a growing delay between attempts.</p></div>
        <div class="bento-card reveal"><div class="feat-ic">&#128274;</div><h3>Private by default</h3><p>Every bot runs in its own process with its own session folder. Session IDs are never shown publicly.</p></div>
        <div class="bento-card reveal"><div class="feat-ic">&#9889;</div><h3>Always the latest bot</h3><p>The bot code is maintained centrally, so you never update anything yourself.</p></div>
        <div class="bento-card reveal"><div class="feat-ic">&#128200;</div><h3>Public status page</h3><p>See platform health and uptime at a glance on the <a href="#/status">status page</a>.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">Who it's for</span>
        <h2>Made for people who run chats</h2>
        <p>If you manage a community, a brand, or a busy group, your bot earns its keep every day.</p>
      </div>
      <div class="usecase-grid">
        <div class="usecase reveal"><span class="uc-emoji">&#128101;</span><h3>Group admins</h3><p>Anti-spam, welcome flows, tag-all and moderation that runs itself.</p></div>
        <div class="usecase reveal"><span class="uc-emoji">&#127908;</span><h3>Creators</h3><p>Auto-status, sticker packs and downloaders to keep fans engaged.</p></div>
        <div class="usecase reveal"><span class="uc-emoji">&#128722;</span><h3>Small businesses</h3><p>Fast replies, media downloads and AI answers without hiring.</p></div>
        <div class="usecase reveal"><span class="uc-emoji">&#129309;</span><h3>Resellers</h3><p>Spin up bots for clients from one clean dashboard.</p></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">Loved by operators</span>
        <h2>Less grind, more uptime</h2>
      </div>
      <div class="quote-grid">
        <figure class="quote reveal">
          <div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
          <blockquote>&ldquo;Deployed in under a minute. Autostatus and antidelete alone save me hours every week &mdash; it feels like a full-time assistant on WhatsApp.&rdquo;</blockquote>
          <figcaption><span class="ava">AM</span><div><b>Arjun M.</b><span>Community manager</span></div></figcaption>
        </figure>
        <figure class="quote reveal">
          <div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
          <blockquote>&ldquo;Group mods love antilink and antispam. We cut spam overnight, and the live logs make fixing anything trivial.&rdquo;</blockquote>
          <figcaption><span class="ava">PK</span><div><b>Priya K.</b><span>Group admin</span></div></figcaption>
        </figure>
        <figure class="quote reveal">
          <div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
          <blockquote>&ldquo;Sticker packs and the downloader are insanely useful. Pasted my session, hit start, and the bot was live &mdash; zero coding.&rdquo;</blockquote>
          <figcaption><span class="ava">DR</span><div><b>Dev R.</b><span>Creator</span></div></figcaption>
        </figure>
      </div>
    </div>
  </section>

  <section class="section" id="platform">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">Why Ladybug Cloud</span>
        <h2>Hosting that does the boring parts for you</h2>
        <p>Compare it with running a bot on your phone, a laptop, or a random free host.</p>
      </div>
      <div class="compare reveal" role="table" aria-label="Ladybug Cloud compared with other ways to host a bot">
        <div class="compare-row compare-head" role="row">
          <span role="columnheader"></span>
          <span role="columnheader" class="us">Ladybug Cloud</span>
          <span role="columnheader">Your phone or PC</span>
          <span role="columnheader">Free hosts</span>
        </div>
        <div class="compare-row" role="row"><span role="rowheader">Stays online 24/7</span><span class="us yes">Yes</span><span class="no">Only while it is on</span><span class="mid">Sleeps or limits hours</span></div>
        <div class="compare-row" role="row"><span role="rowheader">Restarts after a crash</span><span class="us yes">Automatic, with a watchdog</span><span class="no">You restart it</span><span class="mid">Sometimes</span></div>
        <div class="compare-row" role="row"><span role="rowheader">Survives server restarts</span><span class="us yes">Bots resume on boot</span><span class="no">No</span><span class="no">Often loses data</span></div>
        <div class="compare-row" role="row"><span role="rowheader">Live memory and CPU</span><span class="us yes">On every bot card</span><span class="no">Check it yourself</span><span class="no">No</span></div>
        <div class="compare-row" role="row"><span role="rowheader">Uptime history and crash alerts</span><span class="us yes">Built in</span><span class="no">No</span><span class="no">No</span></div>
        <div class="compare-row" role="row"><span role="rowheader">Setup</span><span class="us yes">About 2 minutes, in the browser</span><span class="mid">Install Node and a terminal</span><span class="mid">Deploy, configure, debug</span></div>
        <div class="compare-row" role="row"><span role="rowheader">Cost</span><span class="us yes">Free trial, then coins or $3/month</span><span class="mid">Your data and battery</span><span class="mid">Free, with limits</span></div>
      </div>
      <div class="live-strip reveal" id="liveStrip" aria-live="polite">
        <span class="fs-dot"></span><b id="liveState">Checking platform...</b>
        <span id="liveBots"></span><span id="liveUp"></span>
      </div>
    </div>
  </section>

  <section class="section" id="pricing">
    <div class="wrap">
      <div class="section-title center reveal">
        <span class="kicker">Pricing</span>
        <h2>Pricing that starts at zero</h2>
        <p>Try it free for a week. After that, pick whichever way suits you.</p>
      </div>
      <div class="pricing">
        <div class="plan reveal">
          <div class="plan-name">Free trial</div>
          <div class="plan-price">$0<small>for 7 days</small></div>
          <p class="plan-desc">Everything works from day one. No card required.</p>
          <ul><li>1 bot, hosted for you</li><li>Live logs and auto-restart</li><li>Browser pairing</li></ul>
          <a href="#/register" class="btn btn-block">Start free trial</a>
        </div>
        <div class="plan featured reveal">
          <div class="plan-glow" aria-hidden="true"></div>
          <div class="plan-name">Daily coins <span class="plan-tag">Most popular</span></div>
          <div class="plan-price">20<small>coins a day, free</small></div>
          <p class="plan-desc">Claim once a day. 20 coins keeps one bot online for 24 hours.</p>
          <ul><li>Claim every 24 hours</li><li>Balance holds up to 140 coins</li><li>If coins run out, the bot pauses and nothing is deleted</li></ul>
          <a href="#/register" class="btn btn-primary btn-block">Create free account</a>
        </div>
        <div class="plan reveal">
          <div class="plan-name">Unlimited</div>
          <div class="plan-price">$${price}<small>per month</small></div>
          <div class="plan-zig" data-zig="${price}"></div>
          <p class="plan-desc">For bots you never want to think about.</p>
          <ul><li>Runs 24/7 without coins</li><li>No daily claiming</li><li>Your coins stay in your balance</li></ul>
          <a href="#/register" class="btn btn-block">Get started</a>
        </div>
        <div class="plan reveal">
          <div class="plan-name">Auto-claim <span class="plan-tag alt">New</span></div>
          <div class="plan-price">$2<small>per month</small></div>
          <div class="plan-zig" data-zig="2"></div>
          <p class="plan-desc">Keep the free coins, stop remembering to claim them.</p>
          <ul><li>We claim your 20 coins every 24h</li><li>No more paused bots after a busy day</li><li>Cheaper than Unlimited — you keep paying in coins</li></ul>
          <a href="#/register" class="btn btn-block">Start free trial</a>
        </div>
        <div class="plan reveal">
          <div class="plan-name">Extra bot slot <span class="plan-tag addon">Add-on</span></div>
          <div class="plan-price">$1<small>per month</small></div>
          <div class="plan-zig" data-zig="1"></div>
          <p class="plan-desc">One more bot, without jumping to Unlimited.</p>
          <ul><li>+1 bot slot per purchase — stack as many as you need</li><li>Works on any plan, including the free trial</li><li>Cancel by simply not renewing</li></ul>
          <a href="#/register" class="btn btn-block">Start free trial</a>
        </div>
        <div class="plan reveal">
          <div class="plan-name">Coin packs <span class="plan-tag addon">Top-up</span></div>
          <div class="plan-price">$1<small>for 100 coins</small></div>
          <div class="plan-zig" data-zig="1" data-zig-suffix=""></div>
          <p class="plan-desc">Ran out of coins? Buy more and your bot is back online right away.</p>
          <ul><li>100 coins = 5 days for one bot</li><li>Need more? 300 coins for $2.50</li><li>Bought coins never hit the 140 cap and never expire</li></ul>
          <a href="#/register" class="btn btn-block">Start free trial</a>
        </div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap section-split">
      <div class="section-head reveal"><span class="kicker">FAQ</span><h2>Questions</h2><p>The short answers.</p></div>
      <div class="faq reveal">
        <details><summary>What happens when my trial ends?</summary><p>Your bot keeps running as long as you have coins or a subscription. Each day of hosting costs 20 coins, which is exactly what one daily claim gives you.</p></details>
        <details><summary>What if I forget to claim?</summary><p>If your balance cannot cover the next day, the bot pauses and shows a notice on your dashboard. Claim your coins and press Start to bring it back. Your settings and session stay saved.</p></details>
        <details><summary>What is auto-claim?</summary><p>A $2/month add-on that claims your free coins for you. You still pay for hosting in coins, but you never have to remember the daily tap — so a busy day can't pause your bot. If you already pay for Unlimited, auto-claim is pointless and the dashboard will tell you so.</p></details>
        <details><summary>How do I run two bots?</summary><p>Each extra bot slot is $1/month and stacks on whatever plan you are on, including the free trial. Buy as many as you need from your dashboard — they all renew together and quietly expire if you stop paying, so there is nothing to cancel.</p></details>
        <details><summary>How do referrals work?</summary><p>Share your personal link from your dashboard. Your friend gets 20 bonus coins when they sign up, and you get 40 bonus coins once their bot has been online for 10 minutes. You can earn up to 10 rewards a month, and bonus coins never expire. Signing up yourself with a second account does not count.</p></details>
        <details><summary>Can I buy more coins?</summary><p>Yes. Coin packs start at $1 for 100 coins (5 days of hosting for one bot). Bought coins never expire, are not limited by the 140-coin cap, and are only spent after your free daily coins run out.</p></details>
        <details><summary>Can I stack coins?</summary><p>Yes, up to 140. That is a week of hosting if you want to claim less often.</p></details>
        <details><summary>How do I pay the $${price} a month?</summary><p>Pay in USD or ZiG by bank transfer to the NSB accounts listed on the Pay page once you are signed in, then message the admin from your dashboard with your proof of payment. Once your payment is confirmed, your account switches to Unlimited.</p></details>
        <details><summary>Is it safe to use with my WhatsApp?</summary><p>The bot runs as a linked device, like WhatsApp Web. Your chats stay on WhatsApp and session IDs are never shown publicly. Still follow WhatsApp's rules: don't spam groups or blast random numbers.</p></details>
        <details><summary>Will I lose my account if the site restarts?</summary><p>No. Accounts, bots, coins and logins are backed up continuously and restored automatically.</p></details>
      </div>
    </div>
  </section>

  <section class="cta-band">
    <div class="wrap">
      <div class="cta-inner reveal">
        <div class="cta-orb" aria-hidden="true"></div>
        <div class="cta-copy">
          <h2>Get your bot online today.</h2>
          <p>Seven days free. No card. One bot per account.</p>
        </div>
        <a href="#/register" class="btn btn-lg">Start your free trial <span class="arrow">&rarr;</span></a>
      </div>
    </div>
  </section>

  <footer class="footer">
    <div class="wrap">
      <span><b>Ladybug Cloud</b> by Ntandomods</span>
      <span>Not affiliated with WhatsApp Inc. Use at your own risk.</span>
    </div>
  </footer>`;
  initLanding();
}

/* ---------------- landing interactions ---------------- */
function initLanding() {
  // ZiG prices (rate is set by the admin)
  api('/api/prices').then((p) => {
    $$('[data-zig]').forEach((el) => { el.textContent = `or ${zigFmt(parseFloat(el.dataset.zig), p.zigPerUsd)}${el.hasAttribute('data-zig-suffix') ? ' for 100 coins' : ' per month'}`; });
  }).catch(() => {});
  // live platform strip
  api('/api/status').then((st) => {
    const ok = st.installed !== false;
    if ($('#liveState')) {
      $('#liveState').textContent = ok ? 'All systems operational' : 'Bot code not installed yet';
      $('#liveBots').textContent = `${st.stats.running} of ${st.stats.bots} bots running`;
      $('#liveUp').textContent = `Platform up ${fmtUptime(st.uptime)}`;
    }
  }).catch(() => { if ($('#liveState')) $('#liveState').textContent = 'Status unavailable'; });
  // scroll reveal
  const items = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el, i) => { el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`; io.observe(el); });
  }

  // nav shadow on scroll
  if (!window._navScroll) {
    window._navScroll = true;
    const nav = document.querySelector('.nav');
    const onScroll = () => nav && nav.classList.toggle('scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // hero live log
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heroLines = [
    ['12:00', 'Starting ladybug-mini', ''],
    ['12:01', 'Session loaded', ''],
    ['12:02', 'Connecting to WhatsApp...', ''],
    ['12:03', 'Connected. 42 commands ready', 'g'],
    ['12:04', 'Listening for messages', ''],
  ];
  const heroLog = $('#heroLog');
  if (heroLog) {
    heroLog.innerHTML = '';
    let i = 0;
    const push = () => {
      if (!$('#heroLog')) return;
      const [t, txt, cls] = heroLines[i];
      heroLog.insertAdjacentHTML('beforeend',
        `<div class="fl-line"><span class="fl-t">${t}</span><span class="${cls}">${txt}</span></div>`);
      heroLog.scrollTop = heroLog.scrollHeight;
      i++;
      if (i < heroLines.length) setTimeout(push, reduce ? 0 : 700);
    };
    push();
  }

  // bento terminal loop
  const bento = $('#bentoLog');
  if (bento) {
    const seq = [
      ['12:04:02', 'bot ready · 42 commands', 'g'],
      ['12:04:09', 'message from +27 82 *** · .sticker', ''],
      ['12:04:11', 'sticker generated in 640ms', 'g'],
      ['12:04:26', 'group antilink triggered · removed', 'w'],
      ['12:04:31', 'auto-restart check · healthy', 'g'],
      ['12:04:44', 'listening for messages', ''],
    ];
    let k = 0;
    const tick = () => {
      if (!$('#bentoLog')) return;
      const [t, txt, cls] = seq[k % seq.length];
      bento.insertAdjacentHTML('beforeend',
        `<div class="term-line"><span class="term-t">${t}</span><span class="${cls}">${txt}</span></div>`);
      if (bento.children.length > 6) bento.firstElementChild.remove();
      k++;
      setTimeout(tick, reduce ? 400 : 1600);
    };
    tick();
  }
}


/* ---------------------------------------------------------------- auth */
function savedRef() {
  try { return localStorage.getItem('lb_ref') || ''; } catch (e) { return ''; }
}

function authForm(mode) {
  const isLogin = mode === 'login';
  return `
  <div class="auth-wrap">
    <div class="auth-card">
      <img src="/img/logo.png" alt="Ladybug" />
      <h2>${isLogin ? 'Welcome back' : 'Start your free trial'}</h2>
      <p class="sub">${isLogin ? 'Log in to manage your bot.' : '7 days of hosting for one bot. No card needed.'}</p>
      ${!isLogin && savedRef() ? `<div class="ref-banner">You were invited by <b>${esc(savedRef())}</b>. Sign up and get <b>20 bonus coins</b>.</div>` : ''}
      <div class="alert alert-error" id="err"></div>
      <form id="authForm">
        <div class="field">
          <label for="f-user">Username</label>
          <input class="input" id="f-user" name="username" autocomplete="username" required placeholder="yourname" />
        </div>
        ${isLogin ? '' : `<div class="field"><label for="f-mail">Email <span class="muted" style="font-weight:400">(optional)</span></label><input class="input" id="f-mail" name="email" type="email" placeholder="you@example.com" /></div>`}
        <div class="field">
          <label for="f-pass">Password</label>
          <input class="input" id="f-pass" name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required placeholder="${isLogin ? 'Your password' : 'At least 6 characters'}" />
        </div>
        <button class="btn btn-primary btn-block btn-lg" type="submit" style="margin-top:6px">${isLogin ? 'Log in' : 'Create account'}</button>
      </form>
      <p style="text-align:center;margin:22px 0 0;font-size:14px;color:var(--muted)">
        ${isLogin ? `New here? <a href="#/register" style="text-decoration:underline">Create an account</a>` : `Already registered? <a href="#/login" style="text-decoration:underline">Log in</a>`}
      </p>
    </div>
  </div>`;
}

async function renderLogin() {
  if (state.user) return (location.hash = '#/dashboard');
  $('#view').innerHTML = authForm('login');
  bindAuth('login');
}

async function renderRegister() {
  if (state.user) return (location.hash = '#/dashboard');
  $('#view').innerHTML = authForm('register');
  bindAuth('register');
}

function bindAuth(mode) {
  const form = $('#authForm');
  const err = $('#err');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Please wait...';
    err.className = 'alert alert-error';
    try {
      const fd = new FormData(form);
      const body = Object.fromEntries(fd.entries());
      if (mode === 'register' && savedRef()) body.ref = savedRef();
      await api(`/api/auth/${mode}`, { method: 'POST', body });
      if (mode === 'register') { try { localStorage.removeItem('lb_ref'); } catch (e) { /* ignore */ } }
      toast(mode === 'login' ? 'Welcome back!' : 'Account created!');
      location.hash = '#/dashboard';
    } catch (ex) {
      err.textContent = ex.message;
      err.className = 'alert alert-error show';
      btn.disabled = false;
      btn.textContent = mode === 'login' ? 'Log in' : 'Create account';
    }
  };
}

/* ---------------------------------------------------------------- dashboard */
async function renderDashboard() {
  if (!state.user) return (location.hash = '#/login');

  const data = await api('/api/bots');
  state.bots = data.bots;
  state.limit = data.limit;

  const running = state.bots.filter((b) => b.running).length;

  $('#view').innerHTML = `
  <div class="app">
    <div class="wrap">
      <div class="app-head">
        <div>
          <h1>Your bot</h1>
          <p>Start, stop and watch your Ladybug Mini.</p>
        </div>
        <button class="btn btn-primary" id="newBotBtn">New bot</button>
      </div>

      <div id="wallet"><div class="wallet skeleton"></div></div>
      <div id="referral"></div>

      <div class="stats-row">
        <div class="stat"><div class="k">Bots</div><div class="v">${state.bots.length}<span style="font-size:15px;color:var(--muted);font-weight:500"> of ${state.limit}</span></div></div>
        <div class="stat"><div class="k">Running</div><div class="v" style="color:var(--ok)">${running}</div></div>
        <div class="stat"><div class="k">Stopped</div><div class="v">${state.bots.length - running}</div></div>
        <div class="stat"><div class="k">Billing</div><div class="v" style="font-size:22px;text-transform:capitalize">${esc(({ trial: 'Free trial', subscription: 'Unlimited', coins: 'Daily coins', admin: 'Admin' })[state.user.billingMode] || state.user.plan)}</div></div>
      </div>

      <div id="botsGrid" class="grid grid-3">
        ${state.bots.length ? state.bots.map(botCard).join('') : `
          <div class="empty" style="grid-column:1/-1">
            <img src="/img/logo.png" alt="" />
            <h3>Set up your first bot</h3>
            <p>Link your WhatsApp number and your bot is online in about two minutes.</p>
            <button class="btn btn-primary btn-lg" onclick="openNewBot()">Create bot</button>
          </div>`}
      </div>
    </div>
  </div>`;

  $('#newBotBtn').onclick = openNewBot;
  bindBotActions();
  startStatusPolling();
  loadWallet();
  loadReferral();
}

async function loadReferral() {
  const el = $('#referral');
  if (!el) return;
  try {
    const r = await api('/api/referrals');
    const link = `${location.origin}/#/register?ref=${encodeURIComponent(r.code)}`;
    const msg = `I host my WhatsApp bot on Ladybug Cloud - 7 days free. Join with my link and get ${r.friendCoins} bonus coins: ${link}`;
    const wa = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    const status = { rewarded: 'Rewarded', waiting: 'Waiting for their bot', blocked: 'Not eligible' };
    el.innerHTML = `
    <div class="referral">
      <div class="referral-main">
        <div class="k">Invite friends, earn coins</div>
        <h3>Get ${r.referrerCoins} coins for every friend who gets a bot online</h3>
        <p>Your friend gets <b>${r.friendCoins} coins</b> when they sign up. You get <b>${r.referrerCoins} coins</b> (about ${Math.round(r.referrerCoins / 20)} days of hosting) once their bot has run for ${r.minUptimeMin} minutes. Up to ${r.cap} rewards a month.</p>
        <div class="ref-link"><input class="input" readonly value="${esc(link)}" id="refLink" />
          <button class="btn" id="refCopy">Copy</button>
          <a class="btn btn-primary" href="${esc(wa)}" target="_blank" rel="noopener">Share on WhatsApp</a></div>
      </div>
      <div class="referral-side">
        <div class="ref-stats"><div><b>${r.invited}</b><span>invited</span></div><div><b>${r.earned}</b><span>coins earned</span></div><div><b>${r.rewardedMonth}/${r.cap}</b><span>this month</span></div></div>
        ${r.friends.length ? `<div class="ref-friends">${r.friends.slice(0, 5).map((f) => `<div class="ref-friend"><span>${esc(f.name)}</span><span class="pstatus ${f.status === 'rewarded' ? 'approved' : f.status === 'blocked' ? 'rejected' : 'pending'}">${status[f.status]}</span></div>`).join('')}</div>` : '<p class="pay-note" style="margin:0">No invites yet. Share your link to start earning.</p>'}
      </div>
    </div>`;
    $('#refCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (e) { $('#refLink').select(); toast('Press Ctrl+C to copy', 'ok'); }
    };
  } catch (e) { /* ignore */ }
}

function badge(status) {
  const map = { running: 'Running', stopped: 'Stopped', crashed: 'Crashed', starting: 'Starting', stopping: 'Stopping' };
  return `<span class="badge badge-${status}">${map[status] || status}</span>`;
}

function botCard(b) {
  const now = Date.now();
  const paid = b.coinPaidUntil && b.coinPaidUntil > now && b.running;
  const live = b.status === 'running';
  const initial = esc((b.name || '?').trim().charAt(0).toUpperCase() || '?');
  const uptime = live && b.startedAt
    ? `<span data-since="${b.startedAt}">${fmtLeft(now - b.startedAt)}</span>`
    : (b.stoppedAt ? `<span class="muted-v">stopped ${timeAgo(b.stoppedAt)}</span>` : '<span class="muted-v">not started yet</span>');
  const cover = paid
    ? `<div class="bot-cover"><div class="bot-cover-top"><span>Coins cover</span><b data-left="${b.coinPaidUntil}">${fmtLeft(b.coinPaidUntil - now)}</b></div>
         <div class="meter ok"><span style="width:${Math.max(4, Math.min(100, ((b.coinPaidUntil - now) / 86400000) * 100))}%"></span></div></div>`
    : '';
  return `
  <div class="bot-card is-${b.status}" data-id="${b.id}">
    <div class="bot-top">
      <div class="bot-ava"><span>${initial}</span><i class="bot-dot ${b.status}"></i></div>
      <div class="bot-id">
        <div class="bot-name">${esc(b.name)}</div>
        <div class="bot-meta">${b.hasSession ? esc(b.sessionIdMasked) : 'No session linked'}</div>
      </div>
      ${badge(b.status)}
    </div>
    <div class="bot-hero">
      <div class="bot-hero-k">${live ? 'Online for' : 'Status'}</div>
      <div class="bot-hero-v">${uptime}</div>
    </div>
    <div class="bot-chips">
      <span class="chip ${b.autoRestart ? 'on' : ''}" title="Restarts itself if it crashes">Auto-restart ${b.autoRestart ? 'on' : 'off'}</span>
      <span class="chip ${b.restarts ? 'warn' : ''}">${b.restarts || 0} restart${b.restarts === 1 ? '' : 's'}</span>
      ${b.pid && live ? `<span class="chip">PID ${b.pid}</span>` : ''}
    </div>
    ${live && b.resources ? `<div class="bot-res" title="Live resource usage of this bot">
      <div><span>Memory</span><b>${b.resources.memMB.toFixed(0)} MB</b></div>
      <div><span>CPU</span><b>${b.resources.cpu.toFixed(1)}%</b></div>
      <div><span>Threads</span><b>${b.resources.threads || '-'}</b></div>
    </div>` : ''}
    ${cover}
    ${b.suspendedReason && !b.running ? `<div class="suspended">${esc(b.suspendedReason)}${/coins/i.test(b.suspendedReason) ? ' <a class="buy-link" href="#/pay?buy=coins100">Buy coins</a>' : ''}</div>` : ''}
    ${b.lastError ? `<div class="suspended is-err">${esc(b.lastError)}</div>` : ''}
    <div class="bot-actions">
      ${live
        ? `<button class="btn btn-danger-solid" data-act="stop">Stop</button>
           <button class="btn" data-act="restart">Restart</button>`
        : `<button class="btn btn-primary" data-act="start">${b.status === 'starting' || b.status === 'stopping' ? '...' : 'Start bot'}</button>`}
      <button class="btn btn-ghost" data-act="logs">Logs</button>
      <button class="btn btn-ghost" data-act="uptime" title="Uptime history">Uptime</button>
      <button class="btn btn-ghost" data-act="env" title="Custom bot settings (paid)">Settings${b.envCount ? ` (${b.envCount})` : ''}</button>
      <span class="bot-actions-spacer"></span>
      <button class="btn btn-ghost btn-icon" data-act="edit" title="Edit bot">Edit</button>
      <button class="btn btn-ghost btn-icon btn-danger" data-act="delete" title="Delete bot">Delete</button>
    </div>
  </div>`;
}

function bindBotActions() {
  $$('.bot-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => handleBotAction(id, btn.dataset.act, btn);
    });
  });
}

async function handleBotAction(id, act, btn) {
  const bot = state.bots.find((b) => b.id === id);
  if (!bot) return;

  if (act === 'logs') return openLogs(bot);
  if (act === 'edit') return openEditBot(bot);
  if (act === 'env') return openEnvVars(bot);
  if (act === 'uptime') return openUptime(bot);

  if (act === 'delete') {
    if (!confirm(`Delete bot "${bot.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/bots/${id}`, { method: 'DELETE' });
      toast('Bot deleted');
      renderDashboard();
    } catch (e) { toast(e.message, 'err'); }
    return;
  }

  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    await api(`/api/bots/${id}/${act}`, { method: 'POST' });
    toast(act === 'start' ? 'Bot starting...' : act === 'stop' ? 'Bot stopping...' : 'Restarting...');
    setTimeout(renderDashboard, 700);
  } catch (e) {
    toast(e.message, 'err');
    loadWallet();
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---------------------------------------------------------------- modals */
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalBack').classList.add('show');
}
function closeModal() {
  $('#modalBack').classList.remove('show');
  $('#modal').innerHTML = '';
}
$('#modalBack') && ($('#modalBack').onclick = (e) => { if (e.target.id === 'modalBack') closeModal(); });

function openNewBot() {
  if (state.bots.length >= state.limit) {
    return toast(`Bot limit reached (${state.limit}). Contact the admin to upgrade.`, 'err');
  }
  openModal(`
    <h3>Create your bot</h3>
    <p class="sub">Pair a number in the browser, or paste an existing session ID.</p>
    <div class="alert alert-error" id="mErr"></div>
    <div class="field"><label>Bot Name</label><input class="input" id="mName" placeholder="My Ladybug" maxlength="40" /></div>

    <div class="pair-box">
      <div class="pair-head">Link your WhatsApp number</div>
      <div class="pair-row">
        <input class="input" id="mPhone" placeholder="Phone with country code e.g. 27821234567" inputmode="numeric" />
        <button class="btn btn-primary btn-sm" id="mPair">Get code</button>
      </div>
      <div id="mPairOut" class="pair-out"></div>
      <div class="hint">Open WhatsApp → <b>Linked devices</b> → <b>Link with phone number</b> and enter the code.</div>
    </div>

    <div class="field">
      <label>Session ID</label>
      <textarea class="input" id="mSession" placeholder="Ladybug!H4sIA..."></textarea>
      <div class="hint">Filled automatically after pairing, or paste one that starts with <code>Ladybug!</code>.</div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mCreate">Create Bot</button>
    </div>`);

  let pairTimer = null;
  let pairJob = null;

  const stopPolling = () => {
    if (pairTimer) { clearInterval(pairTimer); pairTimer = null; }
  };
  // stop polling if the modal is dismissed
  const back = $('#modalBack');
  const prevClick = back.onclick;
  back.onclick = (e) => {
    if (e.target.id === 'modalBack') { stopPolling(); pairJob && api(`/api/session/pair/${pairJob}`, { method: 'DELETE' }).catch(() => {}); }
    prevClick && prevClick(e);
  };

  $('#mPair').onclick = async () => {
    const phone = $('#mPhone').value.replace(/[^0-9]/g, '');
    const out = $('#mPairOut');
    if (phone.length < 7) {
      out.innerHTML = '<div class="pair-err">Enter a valid number with country code.</div>';
      return;
    }
    stopPolling();
    const btn = $('#mPair');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    out.innerHTML = '<div class="pair-wait">Starting WhatsApp pairing…</div>';
    try {
      const { job } = await api('/api/session/pair', { method: 'POST', body: { phone } });
      pairJob = job.id;
      renderPair(job);
      pairTimer = setInterval(async () => {
        try {
          const r = await api(`/api/session/pair/${job.id}`);
          renderPair(r.job);
          if (r.job.status === 'ready' || r.job.status === 'error') {
            stopPolling();
            btn.disabled = false;
            btn.textContent = 'Get code';
          }
        } catch (e) {
          stopPolling();
          btn.disabled = false;
          btn.textContent = 'Get code';
          out.innerHTML = `<div class="pair-err">${esc(e.message)}</div>`;
        }
      }, 2000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Get code';
      out.innerHTML = `<div class="pair-err">${esc(e.message)}</div>`;
    }
  };

  function renderPair(job) {
    const out = $('#mPairOut');
    if (!out) return;
    if (job.status === 'ready') {
      $('#mSession').value = job.sessionId;
      const who = job.me && job.me.id ? String(job.me.id).split(':')[0].split('@')[0] : job.phone;
      out.innerHTML = `<div class="pair-ok">Paired as <b>${esc(who)}</b>. The session is filled in below.</div>`;
      toast('Session generated!');
    } else if (job.status === 'error') {
      out.innerHTML = `<div class="pair-err">${esc(job.message || 'Pairing failed.')}</div>`;
    } else if (job.code) {
      out.innerHTML = `
        <div class="pair-code-label">Your pairing code</div>
        <div class="pair-code">${esc(String(job.code).replace(/(.{4})(?=.)/g, '$1 '))}</div>
        <div class="pair-wait">${esc(job.message || 'Waiting for you to enter the code…')}</div>`;
    } else {
      out.innerHTML = `<div class="pair-wait">${esc(job.message || 'Connecting…')}</div>`;
    }
  }

  $('#mCreate').onclick = async () => {
    const name = $('#mName').value.trim();
    const sessionId = $('#mSession').value.trim();
    const err = $('#mErr');
    err.className = 'alert alert-error';
    if (!name || !sessionId) {
      err.textContent = 'Both fields are required.';
      err.className = 'alert alert-error show';
      return;
    }
    const btn = $('#mCreate');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      await api('/api/bots', { method: 'POST', body: { name, sessionId } });
      stopPolling();
      closeModal();
      toast('Bot created!');
      renderDashboard();
    } catch (e) {
      err.textContent = e.message;
      err.className = 'alert alert-error show';
      btn.disabled = false;
      btn.textContent = 'Create Bot';
    }
  };
}

/* ---------------------------------------------------------------- uptime history (24h free, 30 days paid) */
function uptimeBars(items, labelFn) {
  const color = (p) => (p == null ? 'rgba(128,128,128,.25)' : p >= 99 ? '#22c55e' : p >= 90 ? '#eab308' : '#ef4444');
  return `<div style="display:flex;gap:3px;align-items:flex-end;height:46px">${items.map((x) =>
    `<div title="${esc(labelFn(x))}: ${x.pct == null ? 'no data' : x.pct + '%'}" style="flex:1;border-radius:3px;background:${color(x.pct)};height:${x.pct == null ? 20 : Math.max(18, x.pct)}%"></div>`).join('')}</div>`;
}

async function openUptime(bot) {
  let d;
  try { d = await api(`/api/bots/${bot.id}/uptime`); } catch (e) { return toast(e.message, 'err'); }
  const big = (v, label) => `<div style="flex:1"><div class="k">${label}</div><div style="font-size:26px;font-weight:700">${v == null ? '-' : v + '%'}</div></div>`;
  const evIcon = { started: '&#9654;', stopped: '&#9632;', crashed: '&#9888;' };
  const events = (d.events || []).map((e) => `<div style="display:flex;gap:8px;font-size:13px;padding:4px 0;border-bottom:1px solid rgba(128,128,128,.15)">
      <span>${evIcon[e.type] || '&bull;'}</span><b style="text-transform:capitalize">${esc(e.type)}</b>
      <span style="color:var(--muted);flex:1">${esc(e.note || '')}</span><span style="color:var(--muted)">${timeAgo(e.t)}</span></div>`).join('') || '<p class="sub">Nothing has happened yet.</p>';
  const hrFmt = (x) => new Date(x.t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const dayFmt = (x) => new Date(x.t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const sm = d.summary || {};
  const paidBlock = d.full
    ? `<div class="k" style="margin:14px 0 6px">Last 30 days</div>${uptimeBars(d.days, dayFmt)}
       <div style="display:flex;gap:12px;margin-top:10px">${big(d.pct7, '7 days')}${big(d.pct30, '30 days')}${big(d.crashes30d, 'Crashes (30d)').replace('%</div>', '</div>')}</div>
       <p class="sub">Uptime history active for ${sm.daysLeft} more day${sm.daysLeft === 1 ? '' : 's'}.</p>`
    : `<div class="alert show" style="display:block;margin-top:14px">Want the full picture? <b>30-day history</b>, 7 and 30 day uptime and the full event list are <b>$${sm.priceUsd}/month</b>. We keep recording either way, so your history will be there when you unlock it.</div>`;
  openModal(`
    <h3>Uptime &middot; ${esc(bot.name)}</h3>
    <div style="display:flex;gap:12px;margin:8px 0 12px">${big(d.last24h.pct, 'Last 24 hours')}${big(d.crashes24h, 'Crashes (24h)').replace('%</div>', '</div>')}</div>
    ${uptimeBars(d.last24h.hours, hrFmt)}
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px"><span>24h ago</span><span>now</span></div>
    ${paidBlock}
    <div class="k" style="margin:14px 0 6px">Recent events</div>
    <div style="max-height:180px;overflow:auto">${events}</div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Close</button>
      ${d.full ? '' : `<a class="btn btn-primary" href="#/pay?buy=uptime" onclick="closeModal()">Unlock 30 days - $${sm.priceUsd}/month</a>`}
    </div>`);
}

/* ---------------------------------------------------------------- custom bot settings (PAID) */
async function openEnvVars(bot) {
  let data;
  try { data = await api(`/api/bots/${bot.id}/env`); } catch (e) { return toast(e.message, 'err'); }
  const sm = data.summary || {};
  if (!data.active) {
    return openModal(`
      <h3>Custom bot settings</h3>
      <p class="sub">Set your own values for your bot, like <code>PREFIX</code> or <code>OWNER_NUMBER</code>, without touching any code. They are passed to <b>${esc(bot.name)}</b> every time it starts.</p>
      <div class="alert show" style="display:block">This is a paid feature: <b>$${sm.priceUsd}/month</b>${bot.envCount ? ` &middot; your ${bot.envCount} saved setting(s) are kept and switch back on when you renew` : ''}.</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Close</button>
        <a class="btn btn-primary" href="#/pay?buy=envvars" onclick="closeModal()">Unlock for $${sm.priceUsd}/month</a>
      </div>`);
  }
  const rows = Object.entries(data.env || {});
  const rowHtml = (k, v) => `<div class="env-row" style="display:flex;gap:8px;margin-bottom:8px">
      <input class="input env-k" placeholder="NAME" maxlength="40" value="${esc(k)}" style="flex:0 0 40%;text-transform:uppercase" />
      <input class="input env-v" placeholder="value" maxlength="500" value="${esc(v)}" />
      <button class="btn btn-ghost btn-danger env-del" type="button" title="Remove">&times;</button></div>`;
  openModal(`
    <h3>Custom bot settings</h3>
    <p class="sub">Values passed to <b>${esc(bot.name)}</b> when it starts. Active for <b>${sm.daysLeft}</b> more day${sm.daysLeft === 1 ? '' : 's'}.</p>
    <div class="alert alert-error" id="envErr"></div>
    <div id="envRows">${rows.map(([k, v]) => rowHtml(k, v)).join('')}</div>
    <button class="btn btn-sm" id="envAdd" type="button">+ Add setting</button>
    <p class="sub" style="margin-top:10px">Names use capital letters, numbers and _. Up to ${data.max} settings. Platform names such as SESSION_ID and PATH are reserved. Restart the bot to apply changes.</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="envSave">Save</button>
    </div>`);
  const wire = () => $$('.env-del').forEach((b) => { b.onclick = () => b.closest('.env-row').remove(); });
  wire();
  if (!rows.length) { $('#envRows').insertAdjacentHTML('beforeend', rowHtml('', '')); wire(); }
  $('#envAdd').onclick = () => {
    if ($$('.env-row').length >= data.max) return toast(`Maximum ${data.max} settings`, 'err');
    $('#envRows').insertAdjacentHTML('beforeend', rowHtml('', '')); wire();
  };
  $('#envSave').onclick = async () => {
    const env = {};
    for (const row of $$('.env-row')) {
      const k = row.querySelector('.env-k').value.trim();
      const v = row.querySelector('.env-v').value;
      if (!k && !v) continue;
      env[k] = v;
    }
    const btn = $('#envSave'); btn.disabled = true;
    try {
      const r = await api(`/api/bots/${bot.id}/env`, { method: 'PUT', body: { env } });
      closeModal(); toast(r.message || 'Saved'); renderDashboard();
    } catch (e) {
      const err = $('#envErr'); err.textContent = e.message; err.className = 'alert alert-error show'; btn.disabled = false;
    }
  };
}

/* ---------------------------------------------------------------- settings page */
async function renderSettings() {
  if (!state.user) { location.hash = '#/login'; return; }
  let al = {}, bill = {};
  try { [al, bill] = await Promise.all([api('/api/account/alerts'), api('/api/billing')]); } catch (e) { /* show page anyway */ }
  const ev = bill.envVars || {};
  const passTag = (f, key) => f.active
    ? `<span class="chip on">Active &middot; ${f.daysLeft} day${f.daysLeft === 1 ? '' : 's'} left</span> <a class="btn btn-sm" href="#/pay?buy=${key}">Renew</a>`
    : `<span class="chip">$${f.priceUsd}/month</span> <a class="btn btn-sm btn-primary" href="#/pay?buy=${key}">Unlock</a>`;
  $('#view').innerHTML = `
  <div class="app"><div class="wrap">
    <div class="app-head"><div><h1>Settings</h1><p>Signed in as <b>${esc(state.user.username)}</b></p></div></div>
    <div class="pay-grid">
      <div class="card">
        <h3>Change password <span class="chip on">Free</span></h3>
        <div class="alert alert-error" id="pwErr"></div>
        <div class="field"><label>Current password</label><input class="input" id="pwCur" type="password" autocomplete="current-password" /></div>
        <div class="field"><label>New password</label><input class="input" id="pwNew" type="password" autocomplete="new-password" minlength="6" /></div>
        <div class="field"><label>Repeat new password</label><input class="input" id="pwNew2" type="password" autocomplete="new-password" /></div>
        <button class="btn btn-primary" id="pwSave">Update password</button>
        <p class="pay-note">Other devices signed in to your account are logged out when you change it.</p>
      </div>
      <div class="card">
        <h3>Crash alerts ${passTag(al.priceUsd != null ? al : { active: false, priceUsd: '1' }, 'alerts')}</h3>
        <p class="pay-note">Get a message when a bot goes down and when it is back online. Paste a Discord or Slack webhook URL (or any https endpoint that accepts JSON).</p>
        <div class="alert alert-error" id="alErr"></div>
        <div class="field"><label>Webhook URL</label><input class="input" id="alUrl" placeholder="https://discord.com/api/webhooks/..." value="${esc(al.webhook || '')}" ${al.active ? '' : 'disabled'} /></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="alSave" ${al.active ? '' : 'disabled'}>Save</button>
          <button class="btn" id="alTest" ${al.active && al.webhook ? '' : 'disabled'}>Send test alert</button>
        </div>
      </div>
      <div class="card">
        <h3>Uptime history ${passTag(bill.uptime || { active: false, priceUsd: '1' }, 'uptime')}</h3>
        <p class="pay-note">Everyone sees the last 24 hours of each bot. The paid pass adds 30 days of history, 7 and 30 day uptime and the full event list. Open it from the <b>Uptime</b> button on a bot card.</p>
        <a class="btn" href="#/dashboard">Go to my bots</a>
      </div>
      <div class="card">
        <h3>Custom bot settings ${passTag(ev.priceUsd != null ? ev : { active: false, priceUsd: '1' }, 'envvars')}</h3>
        <p class="pay-note">Set values such as <code>PREFIX</code> or <code>OWNER_NUMBER</code> for each bot without editing code. Open it from the <b>Settings</b> button on a bot card on your dashboard.</p>
        <a class="btn" href="#/dashboard">Go to my bots</a>
      </div>
    </div>
  </div></div>`;

  const showErr = (id, msg) => { const e = $(id); e.textContent = msg; e.className = 'alert alert-error show'; };
  $('#pwSave').onclick = async () => {
    $('#pwErr').className = 'alert alert-error';
    if ($('#pwNew').value !== $('#pwNew2').value) return showErr('#pwErr', 'The new passwords do not match.');
    const btn = $('#pwSave'); btn.disabled = true;
    try {
      const r = await api('/api/account/password', { method: 'POST', body: { currentPassword: $('#pwCur').value, newPassword: $('#pwNew').value } });
      toast(r.signedOutOthers ? `Password updated. ${r.signedOutOthers} other device(s) logged out.` : 'Password updated.');
      ['#pwCur', '#pwNew', '#pwNew2'].forEach((i) => { $(i).value = ''; });
    } catch (e) { showErr('#pwErr', e.message); }
    btn.disabled = false;
  };
  $('#alSave').onclick = async () => {
    $('#alErr').className = 'alert alert-error';
    try {
      await api('/api/account/alerts', { method: 'PUT', body: { webhook: $('#alUrl').value.trim() } });
      toast('Alert settings saved');
      renderSettings();
    } catch (e) { showErr('#alErr', e.message); }
  };
  $('#alTest').onclick = async () => {
    $('#alErr').className = 'alert alert-error';
    const btn = $('#alTest'); btn.disabled = true;
    try { await api('/api/account/alerts/test', { method: 'POST' }); toast('Test alert sent'); }
    catch (e) { showErr('#alErr', e.message); }
    btn.disabled = false;
  };
}

function openEditBot(bot) {
  openModal(`
    <h3>Edit bot</h3>
    <p class="sub">Update the name, session ID or auto-restart setting.</p>
    <div class="alert alert-error" id="mErr"></div>
    <div class="field"><label>Bot Name</label><input class="input" id="mName" value="${esc(bot.name)}" maxlength="40" /></div>
    <div class="field"><label>New Session ID <span style="text-transform:none;font-weight:400">(leave blank to keep)</span></label><textarea class="input" id="mSession" placeholder="Leave empty to keep current session"></textarea></div>
    <div class="field">
      <label>Auto-restart</label>
      <select class="input" id="mAuto"><option value="true" ${bot.autoRestart ? 'selected' : ''}>Enabled</option><option value="false" ${!bot.autoRestart ? 'selected' : ''}>Disabled</option></select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mSave">Save changes</button>
    </div>`);

  $('#mSave').onclick = async () => {
    const body = {
      name: $('#mName').value.trim(),
      autoRestart: $('#mAuto').value === 'true',
    };
    const s = $('#mSession').value.trim();
    if (s) body.sessionId = s;
    const btn = $('#mSave');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      await api(`/api/bots/${bot.id}`, { method: 'PATCH', body });
      closeModal();
      toast('Saved');
      renderDashboard();
    } catch (e) {
      const err = $('#mErr');
      err.textContent = e.message;
      err.className = 'alert alert-error show';
      btn.disabled = false;
      btn.textContent = 'Save changes';
    }
  };
}

function openLogs(bot) {
  openModal(`
    <h3>${esc(bot.name)} — Live logs</h3>
    <p class="sub">Streaming console output from your bot process.</p>
    <div class="console" id="console"><div class="ln out">Loading...</div></div>
    <div class="modal-actions">
      <a class="btn btn-sm" id="dlLogs" href="/api/bots/${bot.id}/logs/download" download>&#11015; Download .txt</a>
      <button class="btn btn-sm" id="clearLogs">Clear</button>
      <button class="btn" onclick="closeModal()">Close</button>
    </div>`);

  const consoleEl = $('#console');
  const load = async () => {
    try {
      const r = await api(`/api/bots/${bot.id}/logs?limit=300`);
      if (!r.logs.length) {
        consoleEl.innerHTML = '<div class="ln out">No logs yet. Start the bot to see output.</div>';
        return;
      }
      const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 60;
      consoleEl.innerHTML = r.logs
        .map((l) => `<div class="ln ${l.stream === 'stderr' ? 'err' : 'out'}"><span class="ts">${new Date(l.t).toLocaleTimeString()}</span>${esc(l.line)}</div>`)
        .join('');
      if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
    } catch (e) {
      consoleEl.innerHTML = `<div class="ln err">${esc(e.message)}</div>`;
    }
  };
  load();
  if (state.logTimer) clearInterval(state.logTimer);
  state.logTimer = setInterval(load, 2500);

  $('#clearLogs').onclick = async () => {
    await api(`/api/bots/${bot.id}/logs`, { method: 'DELETE' });
    load();
  };
}

/* ---------------------------------------------------------------- polling */
function startStatusPolling() {
  clearInterval(window._poll);
  window._poll = setInterval(async () => {
    if (location.hash !== '#/dashboard' || $('#modalBack').classList.contains('show')) return;
    try {
      const data = await api('/api/bots');
      const changed = JSON.stringify(data.bots.map((b) => [b.id, b.status, b.restarts])) !==
                      JSON.stringify(state.bots.map((b) => [b.id, b.status, b.restarts]));
      if (changed) {
        state.bots = data.bots;
        const grid = $('#botsGrid');
        if (grid) {
          grid.innerHTML = state.bots.map(botCard).join('');
          bindBotActions();
        }
      }
    } catch (e) { /* ignore */ }
  }, 5000);
}

/* ---------------------------------------------------------------- status */
async function renderStatus() {
  $('#view').innerHTML = `
  <section class="section" style="padding-top:48px">
    <div class="wrap">
      <div class="status-head">
        <div>
          <h2 style="margin-bottom:6px">Platform status</h2>
          <p class="sub" style="margin:0">Live view of Ladybug Cloud and the bots running on it.</p>
        </div>
        <div id="statusPill" class="pill"><span class="dot"></span> Checking...</div>
      </div>
      <div class="stats-grid" id="statusStats"></div>
      <div class="card" style="margin-top:24px">
        <div class="card-head">
          <h3>Running bots</h3>
          <span class="muted" id="statusUpdated" style="font-size:12.5px"></span>
        </div>
        <div id="statusBots"><div class="muted" style="padding:16px 0">Loading…</div></div>
      </div>
      <p class="muted" style="text-align:center;margin-top:22px;font-size:12.5px">
        Bot names are shown publicly; session IDs are never exposed.
      </p>
    </div>
  </section>`;

  async function load() {
    let d;
    try {
      d = await api('/api/status');
    } catch (e) {
      $('#statusPill').innerHTML = '<span class="dot" style="background:#ff2d55"></span> Unreachable';
      $('#statusBots').innerHTML = `<div class="pair-err">${esc(e.message)}</div>`;
      return;
    }
    const healthy = d.ok;
    $('#statusPill').innerHTML = `<span class="dot" style="background:${healthy ? '#22c55e' : '#ff2d55'}"></span> ${healthy ? 'All systems operational' : 'Degraded'}`;
    $('#statusStats').innerHTML = `
      <div class="stat"><div class="stat-label">Running</div><div class="stat-value" style="color:var(--ok)">${d.stats.running}</div></div>
      <div class="stat"><div class="stat-label">Total bots</div><div class="stat-value">${d.stats.bots}</div></div>
      <div class="stat"><div class="stat-label">Users</div><div class="stat-value">${d.stats.users}</div></div>
      <div class="stat"><div class="stat-label">Host uptime</div><div class="stat-value">${fmtUptime(d.uptime)}</div></div>`;

    const rows = (d.bots || []).map((b) => `
      <div class="status-row">
        <div class="status-name">${esc(b.name)}</div>
        <div class="status-mid">${b.running ? `Up ${fmtUptime(b.uptime)}` : 'Offline'}</div>
        ${badge(b.status)}
      </div>`).join('');

    $('#statusBots').innerHTML = rows || '<div class="muted" style="padding:16px 0">No bots yet — be the first to host one.</div>';
    $('#statusUpdated').textContent = `updated ${new Date(d.generatedAt).toLocaleTimeString()}`;
  }

  await load();
  if (state.logTimer) clearInterval(state.logTimer);
  state.logTimer = setInterval(load, 10000);
}

/* ---------------------------------------------------------------- admin */
async function renderAdmin() {
  if (!state.user) return (location.hash = '#/login');
  if (!state.user.isAdmin) return (location.hash = '#/dashboard');

  $('#view').innerHTML = `
  <div class="app">
    <div class="wrap">
      <div class="app-head">
        <div><h1>Admin Panel</h1><p>Manage users, bots and the bot codebase.</p></div>
        <span class="badge badge-running">Admin</span>
      </div>
      <div class="tabs">
        <button class="tab" data-tab="overview">Overview</button>
        <button class="tab" data-tab="users">Users</button>
        <button class="tab" data-tab="bots">All Bots</button>
        <button class="tab" data-tab="inbox">Inbox${state.adminUnread ? ` <span class="msg-n">${state.adminUnread}</span>` : ''}</button>
        <button class="tab" data-tab="referrals">Referrals</button>
        <button class="tab" data-tab="payments">Payments${state.pendingPayments ? ` <span class="msg-n">${state.pendingPayments}</span>` : ''}</button>
        <button class="tab" data-tab="installer">Bot Installer</button>
      </div>
      <div id="adminBody"></div>
    </div>
  </div>`;

  $$('.tab').forEach((t) => {
    t.onclick = () => { state.adminTab = t.dataset.tab; adminTabs(); };
  });
  adminTabs();
}

function adminTabs() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.adminTab));
  const body = $('#adminBody');
  if (state.adminTab === 'overview') adminOverview(body);
  if (state.adminTab === 'users') adminUsers(body);
  if (state.adminTab === 'bots') adminBots(body);
  if (state.adminTab === 'inbox') adminInbox(body);
  if (state.adminTab === 'referrals') adminReferrals(body);
  if (state.adminTab === 'payments') adminPayments(body);
  if (state.adminTab === 'installer') adminInstaller(body);
}

async function adminOverview(el) {
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const s = await api('/api/admin/stats');
    el.innerHTML = `
      <div class="stats-row">
        <div class="stat"><div class="k">Users</div><div class="v">${s.users}</div></div>
        <div class="stat"><div class="k">Bots</div><div class="v">${s.bots}</div></div>
        <div class="stat"><div class="k">Running</div><div class="v" style="color:#6ee7a0">${s.running}</div></div>
        <div class="stat"><div class="k">Uptime</div><div class="v" style="font-size:20px">${fmtUptime(s.uptime)}</div></div>
      </div>
      <div class="grid grid-3" style="margin-top:18px">
        <div class="card"><h3>System</h3><p>Node ${esc(s.node)}<br/>${esc(s.platform)}<br/>${s.cpus} CPUs · Load ${s.loadavg.join(' / ')}</p></div>
        <div class="card"><h3>Memory</h3><p>RSS ${s.memory.rss} MB<br/>Heap ${s.memory.heap} MB</p></div>
        <div class="card"><h3>Database backup</h3><p>${!s.backup.enabled ? 'Not configured<br/><span style="font-size:12px">Set MONGODB_URI on the server to keep data across redeploys.</span>' : s.backup.ready ? `<span style="color:var(--ok)">Connected to MongoDB</span><br/>Last backup: ${s.backup.lastPushAt ? timeAgo(s.backup.lastPushAt) : 'pending'}${s.backup.restored ? `<br/>Restored on boot: ${s.backup.restored.users} users, ${s.backup.restored.bots} bots` : ''}` : `Not connected<br/><span style="font-size:12px;color:#ff8095">${esc(s.backup.lastError || '')}</span>`}</p></div>
        <div class="card"><h3>Bot Code</h3><p>${s.installed ? 'Installed' : 'Not installed'}<br/>Admins: ${s.admins}</p></div>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error show">${esc(e.message)}</div>`;
  }
}

async function adminUsers(el) {
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const { users } = await api('/api/admin/users');
    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead><tr><th>User</th><th>Plan</th><th>Billing</th><th>Bots</th><th>Joined</th><th>Last login</th><th>Actions</th></tr></thead>
          <tbody>
            ${users.map((u) => `
              <tr>
                <td><strong>${esc(u.username)}</strong>${u.isAdmin ? ' <span class="badge badge-running" style="font-size:9px">admin</span>' : ''}<br/><span style="color:var(--muted);font-size:12px">${esc(u.email || '—')}</span></td>
                <td>${esc(u.plan)}</td>
                <td style="font-size:12.5px">${esc(u.billingMode)}<br/><span style="color:var(--muted)">${u.coins} coins</span></td>
                <td>${u.botCount} / ${u.botLimit}</td>
                <td style="color:var(--muted)">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                <td style="color:var(--muted)">${u.lastLogin ? timeAgo(new Date(u.lastLogin).getTime()) : 'never'}</td>
                <td>
                  <button class="btn btn-sm" data-uplan="${u.id}" data-plan="${u.plan === 'pro' ? 'free' : 'pro'}">${u.plan === 'pro' ? 'Downgrade' : 'Upgrade'}</button>
                  <button class="btn btn-sm btn-green" data-ugrant="${u.id}" data-body='{"grantSubscriptionDays":30}' title="Mark as paid: +30 days">+30d sub</button>
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantCoins":20}' title="Give 20 coins">+20 coins</button>
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantAutoClaimDays":30}' title="Grant 30 days of auto-claim">+auto-claim</button>
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantSlotDays":30,"grantSlots":1}' title="Grant 1 extra bot slot for 30 days">+slot</button>
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantFeature":"envvars","grantFeatureDays":30}' title="Grant 30 days of Custom bot settings">+env vars</button>
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantFeature":"alerts","grantFeatureDays":30}' title="Grant 30 days of Crash alerts">+alerts</button>
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantFeature":"uptime","grantFeatureDays":30}' title="Grant 30 days of Uptime history">+uptime</button>
                  ${u.id !== state.user.id ? `<button class="btn btn-sm btn-danger" data-udel="${u.id}">Delete</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    $$('[data-uplan]').forEach((b) => (b.onclick = async () => {
      try {
        await api(`/api/admin/users/${b.dataset.uplan}`, { method: 'PATCH', body: { plan: b.dataset.plan } });
        toast('Plan updated');
        adminUsers(el);
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-ugrant]').forEach((b) => (b.onclick = async () => {
      try {
        await api(`/api/admin/users/${b.dataset.ugrant}`, { method: 'PATCH', body: JSON.parse(b.dataset.body) });
        toast('Updated');
        adminUsers(el);
      } catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-udel]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this user and all their bots?')) return;
      try {
        await api(`/api/admin/users/${b.dataset.udel}`, { method: 'DELETE' });
        toast('User deleted');
        adminUsers(el);
      } catch (e) { toast(e.message, 'err'); }
    }));
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error show">${esc(e.message)}</div>`;
  }
}

async function adminBots(el) {
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const { bots } = await api('/api/admin/bots');
    if (!bots.length) return (el.innerHTML = '<div class="empty">No bots on the platform yet.</div>');
    const waLabel = { connected: ['Connected', 'on'], connecting: ['Connecting...', ''], reconnecting: ['Reconnecting', 'warn'], conflict: ['Session conflict', 'warn'], logged_out: ['Logged out', 'warn'], offline: ['Offline', ''], unknown: ['Not started', ''] };
    const connected = bots.filter((b) => b.running && b.waState === 'connected').length;
    const running = bots.filter((b) => b.running).length;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <b>${connected} of ${bots.length} bots connected to WhatsApp</b>
        <span style="color:var(--muted)">${running} process${running === 1 ? '' : 'es'} running</span>
        <span style="flex:1"></span>
        <button class="btn btn-sm" id="botsRefresh">Refresh</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Bot</th><th>Owner</th><th>WhatsApp number</th><th>Connection</th><th>Status</th><th>Restarts</th><th>Actions</th></tr></thead>
          <tbody>
            ${bots.map((b) => { const wl = waLabel[b.waState] || waLabel.unknown; return `
              <tr>
                <td><strong>${esc(b.name)}</strong><br/><span style="color:var(--muted);font-size:12px">${esc(b.sessionIdMasked)}</span></td>
                <td>${esc(b.owner)}</td>
                <td>${b.waNumber
                  ? `<b>+${esc(b.waNumber)}</b>${b.waName ? `<br/><span style="color:var(--muted);font-size:12px">${esc(b.waName)}</span>` : ''}<br/>
                     <button class="btn btn-sm btn-ghost" data-copy="+${esc(b.waNumber)}">Copy</button>
                     <a class="btn btn-sm" href="https://wa.me/${esc(b.waNumber)}" target="_blank" rel="noopener" title="Open WhatsApp and message the bot to test it">Test</a>`
                  : '<span class="muted-v">unknown</span>'}</td>
                <td><span class="chip ${wl[1]}">${wl[0]}</span>${b.waSince && b.running ? `<br/><span style="color:var(--muted);font-size:12px">${timeAgo(b.waSince)}</span>` : ''}${b.lastLogAt && b.running ? `<br/><span style="color:var(--muted);font-size:12px">last log ${timeAgo(b.lastLogAt)}</span>` : ''}</td>
                <td>${badge(b.status)}</td>
                <td>${b.restarts || 0}</td>
                <td>
                  ${b.running ? `<button class="btn btn-sm btn-danger" data-bstop="${b.id}">Stop</button>` : ''}
                  <button class="btn btn-sm btn-danger" data-bdel="${b.id}">Delete</button>
                </td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>`;
    $('#botsRefresh').onclick = () => adminBots(el);
    $$('[data-copy]', el).forEach((b) => (b.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(b.dataset.copy); toast('Number copied'); }));
    $$('[data-bstop]').forEach((b) => (b.onclick = async () => {
      try { await api(`/api/admin/bots/${b.dataset.bstop}/stop`, { method: 'POST' }); toast('Stopped'); adminBots(el); }
      catch (e) { toast(e.message, 'err'); }
    }));
    $$('[data-bdel]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Delete this bot?')) return;
      try { await api(`/api/admin/bots/${b.dataset.bdel}`, { method: 'DELETE' }); toast('Deleted'); adminBots(el); }
      catch (e) { toast(e.message, 'err'); }
    }));
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error show">${esc(e.message)}</div>`;
  }
}

async function adminInstaller(el) {
  el.innerHTML = '<div class="empty">Loading...</div>';
  const st = await api('/api/admin/installer').catch(() => ({}));
  el.innerHTML = `
    <div class="grid grid-3">
      <div class="card" style="grid-column: span 2">
        <h3>Install bot code from GitHub</h3>
        <p style="margin-bottom:14px">Downloads the Ladybug Mini source and extracts it into the bot directory. Session folders and node_modules are preserved.</p>
        <div class="field"><label>Archive URL</label><input class="input" id="iUrl" value="https://github.com/kids-codentando/Ladybug-Mini/archive/refs/heads/main.zip" /></div>
        <button class="btn btn-primary" id="iGithub">Install / Update from GitHub</button>
        <hr style="border:none;border-top:1px solid var(--border);margin:22px 0" />
        <h3>Upload a zip</h3>
        <p style="margin-bottom:14px">Upload your own bot build (must contain index.js at the root).</p>
        <input type="file" id="iFile" accept=".zip" class="input" style="padding:10px" />
        <button class="btn" id="iUpload" style="margin-top:12px">Upload & Install</button>
      </div>
      <div class="card">
        <h3>Status</h3>
        <p style="line-height:2">
          Code installed: <strong>${st.installed ? 'Yes' : 'No'}</strong><br/>
          Step: <strong>${esc(st.step || 'idle')}</strong><br/>
          Last install: <strong>${st.lastInstalledAt ? new Date(st.lastInstalledAt).toLocaleString() : 'never'}</strong>
        </p>
        <div style="height:8px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;margin:14px 0">
          <div style="height:100%;width:${st.progress || 0}%;background:linear-gradient(90deg,var(--red-2),var(--amber));transition:width .3s"></div>
        </div>
        <p style="font-size:12.5px;min-height:36px">${esc(st.message || '')}</p>
        <hr style="border:none;border-top:1px solid var(--border);margin:18px 0" />
        <h3>Dependencies</h3>
        <p style="margin-bottom:12px">Install the bot's npm packages (needed before first run).</p>
        <button class="btn btn-green btn-block" id="iDeps">Install Dependencies</button>
      </div>
    </div>`;

  const poll = async () => {
    const s = await api('/api/admin/installer').catch(() => null);
    if (s) {
      const p = el.querySelector('div[style*="width"]');
      if (p) p.style.width = `${s.progress || 0}%`;
      const msgEl = el.querySelectorAll('p')[1];
      if (msgEl && s.message) msgEl.textContent = s.message;
    }
  };

  $('#iGithub').onclick = async (e) => {
    e.target.disabled = true;
    e.target.innerHTML = '<span class="spin"></span> Installing...';
    try {
      await api('/api/admin/installer/github', { method: 'POST', body: { url: $('#iUrl').value.trim() } });
      toast('Bot code installed!');
      adminInstaller(el);
    } catch (err) {
      toast(err.message, 'err');
      e.target.disabled = false;
      e.target.textContent = 'Install / Update from GitHub';
    }
  };

  $('#iUpload').onclick = async () => {
    const f = $('#iFile').files[0];
    if (!f) return toast('Choose a zip file first', 'err');
    const fd = new FormData();
    fd.append('file', f);
    const btn = $('#iUpload');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Uploading...';
    try {
      const res = await fetch('/api/admin/installer/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Upload failed');
      toast('Installed!');
      adminInstaller(el);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = 'Upload & Install';
    }
  };

  $('#iDeps').onclick = async (e) => {
    e.target.disabled = true;
    e.target.innerHTML = '<span class="spin"></span> Installing deps...';
    try {
      await api('/api/admin/installer/deps', { method: 'POST' });
      toast('Dependency install started — this can take a few minutes');
      const t = setInterval(poll, 3000);
      setTimeout(() => clearInterval(t), 600000);
    } catch (err) {
      toast(err.message, 'err');
      e.target.disabled = false;
      e.target.textContent = 'Install Dependencies';
    }
  };
}

/* ---------------------------------------------------------------- boot */
window.addEventListener('hashchange', navigate);
window.closeModal = closeModal;
window.openNewBot = openNewBot;
navigate();


/* ---------------------------------------------------------------- pay page (user) */
async function renderPay() {
  if (!state.user) return (location.hash = '#/login');
  $('#view').innerHTML = '<div class="app"><div class="wrap"><div class="empty">Loading...</div></div></div>';
  let p;
  try { p = await api('/api/payments'); } catch (e) {
    $('#view').innerHTML = `<div class="app"><div class="wrap"><div class="alert alert-error show">${esc(e.message)}</div></div></div>`;
    return;
  }
  const accounts = p.accounts.map((a) => `
    <div class="acct">
      <div class="acct-cur">${esc(a.currency)}</div>
      <div class="acct-body">
        <div class="k">${esc(p.bankName)} ${esc(a.currency)} account</div>
        <div class="acct-num" id="acct-${esc(a.currency)}">${esc(a.number)}</div>
        ${p.accountName ? `<div class="acct-name">${esc(p.accountName)}</div>` : ''}
      </div>
      <button class="btn btn-sm" data-copy="${esc(a.number)}">Copy</button>
    </div>`).join('');
  const rows = p.items.map((i) => `
    <tr><td><b>${esc(i.name)}</b><br/><span style="color:var(--muted);font-size:12px">per ${i.days} days</span></td>
    <td>$${i.usd}</td><td><b>${esc('ZiG ' + i.zig.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</b></td></tr>`).join('');
  $('#view').innerHTML = `
  <div class="app"><div class="wrap">
    <div class="app-head">
      <div><h1>Pay &amp; prices</h1><p>Pay the admin by bank transfer in USD or ZiG.</p></div>
      <a class="btn" href="#/support">Contact admin</a>
    </div>
    <div class="pay-grid">
      <div class="card">
        <h3>${esc(p.bankName)} bank accounts</h3>
        <div class="accts">${accounts}</div>
        <div class="pay-ref"><div class="k">Payment reference</div><b>${esc(p.reference)}</b>
          <button class="btn btn-sm" data-copy="${esc(p.reference)}">Copy</button></div>
        <p class="pay-note">${esc(p.instructions)}</p>
      </div>
      <div class="card">
        <h3>Prices</h3>
        <div class="table-wrap" style="margin-top:10px"><table>
          <thead><tr><th>Option</th><th>USD</th><th>ZiG</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <p class="pay-note">ZiG prices use a rate of <b>1 USD = ZiG ${p.zigPerUsd}</b>. The admin updates the rate when the market moves, so always check this page before you send money.</p>
      </div>
      <form class="card" id="paidForm">
        <h3>I have paid</h3>
        <p class="pay-note" style="margin:0 0 14px">Sent the money? Tell us what it was for. The admin checks the transfer and switches your plan on.</p>
        <div class="field"><label>What did you pay for?</label>
          <select class="input" id="fItem">${p.items.map((i) => `<option value="${i.key}">${esc(i.name)} - $${i.usd} / ZiG ${i.zig.toFixed(2)}</option>`).join('')}</select></div>
        <div class="field" id="fQtyWrap" style="display:none"><label id="fQtyLabel">How many?</label>
          <input class="input" id="fQty" type="number" min="1" max="5" value="1" /></div>
        <div class="field"><label>Currency you paid in</label>
          <select class="input" id="fCur">${p.accounts.map((a) => `<option value="${esc(a.currency)}">${esc(a.currency)}</option>`).join('')}</select></div>
        <div class="field"><label>Transaction reference or sender name</label>
          <input class="input" id="fRef" maxlength="80" placeholder="e.g. bank receipt number" /></div>
        <div class="paid-total" id="fTotal"></div>
        <button class="btn btn-primary btn-block" type="submit">Submit payment</button>
      </form>
      <div class="card">
        <h3>My payments</h3>
        <div id="myPays" class="pay-list"><div class="chat-empty">Loading...</div></div>
      </div>
    </div>
  </div></div>`;
  const items = p.items;
  const total = () => {
    const it = items.find((i) => i.key === $('#fItem').value);
    const multi = it.key === 'slot' || it.coins;
    const qty = multi ? Math.max(1, Math.min(5, parseInt($('#fQty').value, 10) || 1)) : 1;
    $('#fQtyWrap').style.display = multi ? '' : 'none';
    $('#fQtyLabel').textContent = it.coins ? `How many ${it.coins}-coin packs?` : 'How many slots?';
    const cur = $('#fCur').value;
    const amt = cur.toLowerCase() === 'zig' ? 'ZiG ' + (it.zig * qty).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '$' + it.usd * qty;
    $('#fTotal').innerHTML = `Amount to send: <b>${esc(amt)}</b>`;
  };
  const want = (location.hash.split('buy=')[1] || '').split('&')[0];
  if (want && items.some((i) => i.key === want)) $('#fItem').value = want;
  ['fItem', 'fQty', 'fCur'].forEach((id) => { $('#' + id).oninput = total; $('#' + id).onchange = total; });
  total();
  const loadMine = async () => {
    try {
      const r = await api('/api/payments/mine');
      $('#myPays').innerHTML = r.payments.length ? r.payments.map((x) => `
        <div class="pay-item"><div><b>${esc(x.itemName)}${x.qty > 1 ? ' x' + x.qty : ''}</b><br/><span class="pay-sub">${esc(x.currency)} ${x.amount} - ref ${esc(x.reference)} - ${timeAgo(x.createdAt)}</span>${x.reason ? `<br/><span class="pay-sub">${esc(x.reason)}</span>` : ''}</div>
        <span class="pstatus ${x.status}">${x.status}</span></div>`).join('') : '<div class="chat-empty">Nothing submitted yet.</div>';
    } catch (e) { /* ignore */ }
  };
  loadMine();
  $('#paidForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $('#paidForm button[type=submit]'); btn.disabled = true;
    try {
      await api('/api/payments/submit', { method: 'POST', body: { item: $('#fItem').value, qty: $('#fQty').value, currency: $('#fCur').value, reference: $('#fRef').value } });
      toast('Submitted - the admin will confirm it soon');
      $('#fRef').value = '';
      loadMine();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
  $$('[data-copy]').forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch (e) { toast('Copy failed - select the text instead', 'err'); }
  }));
}

/* ---------------------------------------------------------------- contact admin (user) */
function threadHTML(msgs, mineIs) {
  if (!msgs.length) return '<div class="chat-empty">No messages yet. Say hello below.</div>';
  return msgs.map((m) => `
    <div class="chat-msg ${m.from === mineIs ? 'mine' : 'theirs'}">
      <div class="chat-bubble">${esc(m.body).replace(/\n/g, '<br/>')}</div>
      <div class="chat-time">${m.from === 'admin' ? 'Admin' : 'You'} - ${new Date(m.at).toLocaleString()}</div>
    </div>`).join('');
}

async function renderSupport() {
  if (!state.user) return (location.hash = '#/login');
  $('#view').innerHTML = `
  <div class="app"><div class="wrap">
    <div class="app-head">
      <div><h1>Contact admin</h1><p>Questions, payment proof, plan requests - the admin replies here.</p></div>
      <a class="btn" href="#/pay">Payment details</a>
    </div>
    <div class="card chat">
      <div class="chat-thread" id="chatThread"><div class="chat-empty">Loading...</div></div>
      <form class="chat-form" id="chatForm">
        <textarea class="input" id="chatBody" maxlength="2000" rows="3" placeholder="Write your message... e.g. I paid ZiG 79.71 for Unlimited, reference ${esc(state.user.username)}"></textarea>
        <div class="chat-actions"><span class="chat-count" id="chatCount">0 / 2000</span><button class="btn btn-primary" type="submit">Send</button></div>
      </form>
    </div>
  </div></div>`;
  const load = async (scroll) => {
    try {
      const r = await api('/api/messages?markRead=1');
      const t = $('#chatThread');
      if (!t) return;
      t.innerHTML = threadHTML(r.messages, 'user');
      if (scroll) t.scrollTop = t.scrollHeight;
      refreshUnread();
    } catch (e) { /* ignore */ }
  };
  await load(true);
  state.logTimer = setInterval(() => load(false), 8000);
  const body = $('#chatBody');
  body.oninput = () => { $('#chatCount').textContent = `${body.value.length} / 2000`; };
  $('#chatForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const text = body.value.trim();
    if (!text) return;
    const btn = $('#chatForm button[type=submit]'); btn.disabled = true;
    try {
      await api('/api/messages', { method: 'POST', body: { body: text } });
      body.value = ''; $('#chatCount').textContent = '0 / 2000';
      await load(true);
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
}

/* ---------------------------------------------------------------- admin: inbox */
async function adminInbox(el, openUserId) {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const { threads } = await api('/api/admin/messages');
    if (!threads.length) { el.innerHTML = '<div class="empty"><h3>No messages yet</h3><p>When users contact you from their dashboard, they show up here.</p></div>'; return; }
    el.innerHTML = `
      <div class="inbox">
        <div class="inbox-list">${threads.map((t) => `
          <button class="inbox-row ${openUserId === t.userId ? 'active' : ''}" data-thread="${t.userId}">
            <div class="inbox-top"><b>${esc(t.username)}</b>${t.unread ? `<span class="msg-n">${t.unread}</span>` : ''}<span class="inbox-time">${timeAgo(t.last.at)}</span></div>
            <div class="inbox-prev">${t.last.from === 'admin' ? 'You: ' : ''}${esc(t.last.body)}</div>
          </button>`).join('')}</div>
        <div class="inbox-view card" id="inboxView"><div class="chat-empty">Pick a conversation.</div></div>
      </div>`;
    $$('[data-thread]').forEach((b) => (b.onclick = () => openThread(el, b.dataset.thread)));
    if (openUserId) openThread(el, openUserId, true);
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error show">${esc(e.message)}</div>`;
  }
}

async function openThread(listEl, userId, skipRelist) {
  const view = $('#inboxView');
  try {
    const r = await api(`/api/admin/messages/${userId}`);
    $$('.inbox-row').forEach((x) => x.classList.toggle('active', x.dataset.thread === userId));
    view.innerHTML = `
      <div class="inbox-head"><div><h3>${esc(r.user.username)}</h3><span style="color:var(--muted);font-size:12.5px">${esc(r.user.email || '')} - ${esc(r.user.billingMode)} - ${r.user.coins} coins</span></div>
        <button class="btn btn-sm btn-danger" id="delThread">Delete chat</button></div>
      <div class="chat-thread" id="adminThread">${threadHTML(r.messages, 'admin')}</div>
      <form class="chat-form" id="adminReplyForm">
        <textarea class="input" id="adminReply" maxlength="2000" rows="3" placeholder="Reply to ${esc(r.user.username)}..."></textarea>
        <div class="chat-actions"><span></span><button class="btn btn-primary" type="submit">Send reply</button></div>
      </form>`;
    const t = $('#adminThread'); t.scrollTop = t.scrollHeight;
    refreshUnread();
    $('#adminReplyForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const text = $('#adminReply').value.trim();
      if (!text) return;
      try {
        await api(`/api/admin/messages/${userId}`, { method: 'POST', body: { body: text } });
        openThread(listEl, userId);
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#delThread').onclick = async () => {
      if (!confirm(`Delete the whole conversation with ${r.user.username}?`)) return;
      try { await api(`/api/admin/messages/${userId}`, { method: 'DELETE' }); toast('Deleted'); adminInbox(listEl); } catch (e) { toast(e.message, 'err'); }
    };
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------------------------------------------------------- admin: payment details */
async function adminPayments(el) {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const p = await api('/api/admin/payments');
    const acctRow = (a = { currency: '', number: '' }) => `
      <div class="acct-edit"><input class="input" data-cur placeholder="Currency (ZiG)" value="${esc(a.currency)}" style="max-width:120px" />
      <input class="input" data-num placeholder="Account number" value="${esc(a.number)}" /></div>`;
    const pr = await api('/api/admin/payment-requests');
    const payRow = (x, actions) => `
      <div class="pay-item"><div><b>${esc(x.username)}</b> - ${esc(x.itemName)}${x.qty > 1 ? ' x' + x.qty : ''}<br/>
        <span class="pay-sub">${esc(x.currency)} ${x.amount} (US$${x.amountUsd}) - ref ${esc(x.reference)} - ${timeAgo(x.createdAt)}</span>${x.reason ? `<br/><span class="pay-sub">${esc(x.reason)}</span>` : ''}</div>
        ${actions || `<span class="pstatus ${x.status}">${x.status}</span>`}</div>`;
    el.innerHTML = `
    <div class="card" style="margin-bottom:18px">
      <h3>Payments waiting for approval ${pr.pending.length ? `<span class="msg-n">${pr.pending.length}</span>` : ''}</h3>
      <p class="pay-note" style="margin:0 0 10px">Check the money in your NSB account first, then approve. Approving switches the plan on and messages the user.</p>
      <div class="pay-list">${pr.pending.length ? pr.pending.map((x) => payRow(x, `<span class="pay-btns"><button class="btn btn-sm btn-green" data-approve="${x.id}">Approve</button><button class="btn btn-sm btn-danger" data-reject="${x.id}">Reject</button></span>`)).join('') : '<div class="chat-empty">Nothing waiting.</div>'}</div>
      ${pr.recent.length ? `<details class="coin-log"><summary>Recent decisions</summary>${pr.recent.map((x) => payRow(x)).join('')}</details>` : ''}
    </div>
    <div class="pay-grid">
      <form class="card" id="payForm">
        <h3>Payment details shown to users</h3>
        <div class="field"><label>Bank</label><input class="input" id="pBank" value="${esc(p.bankName)}" /></div>
        <div class="field"><label>Account holder name (optional)</label><input class="input" id="pName" value="${esc(p.accountName)}" placeholder="Name on the account" /></div>
        <div class="field"><label>Accounts</label><div id="acctRows">${p.accounts.map(acctRow).join('')}</div>
          <button class="btn btn-sm" type="button" id="addAcct" style="margin-top:8px">Add account</button></div>
        <div class="field"><label>Exchange rate (ZiG per 1 USD)</label><input class="input" id="pRate" type="number" step="0.0001" min="0" value="${p.zigPerUsd}" />
          <small style="color:var(--muted)">Used for every ZiG price. Check the RBZ rate and update when it moves.</small></div>
        <div class="field"><label>Instructions</label><textarea class="input" id="pInstr" rows="4" maxlength="600" style="font-family:var(--sans)">${esc(p.instructions)}</textarea></div>
        <button class="btn btn-primary" type="submit">Save</button>
      </form>
      <div class="card">
        <h3>Current prices</h3>
        <div class="table-wrap" style="margin-top:10px"><table>
          <thead><tr><th>Option</th><th>USD</th><th>ZiG</th></tr></thead>
          <tbody id="priceRows">${p.prices.items.map((i) => `<tr><td>${esc(i.name)}</td><td>$${i.usd}</td><td>ZiG ${i.zig.toFixed(2)}</td></tr>`).join('')}</tbody>
        </table></div>
        <p class="pay-note">USD prices come from the server settings (SUBSCRIPTION_PRICE_USD, AUTOCLAIM_PRICE_USD, SLOT_PRICE_USD). ZiG = USD x rate.</p>
      </div>
    </div>`;
    $$('[data-approve]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { const r = await api(`/api/admin/payment-requests/${b.dataset.approve}/approve`, { method: 'POST' }); toast('Activated: ' + r.activated); refreshUnread(); adminPayments(el); }
      catch (e) { toast(e.message, 'err'); b.disabled = false; }
    }));
    $$('[data-reject]').forEach((b) => (b.onclick = async () => {
      const reason = prompt('Reason for rejecting (shown to the user, optional):');
      if (reason === null) return;
      try { await api(`/api/admin/payment-requests/${b.dataset.reject}/reject`, { method: 'POST', body: { reason } }); toast('Rejected'); refreshUnread(); adminPayments(el); }
      catch (e) { toast(e.message, 'err'); }
    }));
    $('#addAcct').onclick = () => { $('#acctRows').insertAdjacentHTML('beforeend', acctRow()); };
    $('#payForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const accounts = $$('.acct-edit').map((r) => ({ currency: $('[data-cur]', r).value, number: $('[data-num]', r).value }));
      try {
        await api('/api/admin/payments', { method: 'PUT', body: {
          bankName: $('#pBank').value, accountName: $('#pName').value, accounts,
          zigPerUsd: $('#pRate').value, instructions: $('#pInstr').value,
        } });
        toast('Payment details saved');
        adminPayments(el);
      } catch (e) { toast(e.message, 'err'); }
    };
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error show">${esc(e.message)}</div>`;
  }
}


/* ---------------------------------------------------------------- admin: referrals */
async function adminReferrals(el) {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const r = await api('/api/admin/referrals');
    el.innerHTML = `
      <div class="stats-row">
        <div class="stat"><div class="k">Referred signups</div><div class="v">${r.referrals.length}</div></div>
        <div class="stat"><div class="k">Rewarded</div><div class="v" style="color:var(--ok)">${r.rewarded}</div></div>
        <div class="stat"><div class="k">Coins given</div><div class="v">${r.coinsGiven}</div></div>
      </div>
      ${r.referrals.length ? `<div class="table-wrap"><table>
        <thead><tr><th>New user</th><th>Invited by</th><th>Status</th><th>Joined</th></tr></thead>
        <tbody>${r.referrals.map((x) => `<tr><td><b>${esc(x.username)}</b></td><td>${esc(x.referrer)}</td>
          <td><span class="pstatus ${x.status === 'rewarded' ? 'approved' : x.status === 'blocked' ? 'rejected' : 'pending'}">${esc(x.status)}</span>${x.note ? `<br/><span class="pay-sub">${esc(x.note)}</span>` : ''}</td>
          <td style="color:var(--muted)">${x.joined ? new Date(x.joined).toLocaleDateString() : '-'}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty"><h3>No referrals yet</h3><p>Users share their link from the dashboard.</p></div>'}`;
  } catch (e) {
    el.innerHTML = `<div class="alert alert-error show">${esc(e.message)}</div>`;
  }
}


/* ---------------------------------------------------------------- Ladybug Drive (storage) */
function fmtBytes(n) {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
}

const FILE_KINDS = {
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'],
  video: ['mp4', 'mkv', 'mov', 'webm', 'avi'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz'],
  documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'xlsx', 'json'],
};
function fileKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].includes(ext)) || 'other';
}
const KIND_LABEL = { images: 'Images', video: 'Video', audio: 'Audio', documents: 'Documents', archives: 'Archives', other: 'Other' };

async function renderStorage() {
  if (!state.user) { location.hash = '#/login'; return; }
  const q = /[?&]p=([^&]*)/.exec(location.hash);
  let cwd = q ? decodeURIComponent(q[1]) : '';
  $('#view').innerHTML = `<div class="app"><div class="wrap"><div class="app-head"><div><h1>Storage</h1><p>Loading your drive...</p></div></div></div></div>`;
  let d;
  try { d = await api('/api/storage?path=' + encodeURIComponent(cwd)); }
  catch (e) { toast(e.message, 'err'); location.hash = '#/storage'; return; }

  const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);
  const free = Math.max(0, d.quotaBytes - d.usedBytes);
  const order = ['images', 'video', 'audio', 'documents', 'archives', 'other'];
  const segs = order.filter((k) => d.breakdown[k] > 0).map((k) => `<i class="seg seg-${k}" style="width:${pct(d.breakdown[k], d.quotaBytes)}%" title="${KIND_LABEL[k]}: ${fmtBytes(d.breakdown[k])}"></i>`).join('');
  const legend = order.map((k) => `<span class="lg"><i class="seg-${k}"></i>${KIND_LABEL[k]} <b>${fmtBytes(d.breakdown[k])}</b></span>`).join('');
  const crumbs = ['<a href="#/storage">My drive</a>'];
  const parts = cwd ? cwd.split('/') : [];
  parts.forEach((part, i) => crumbs.push(`<a href="#/storage?p=${encodeURIComponent(parts.slice(0, i + 1).join('/'))}">${esc(part)}</a>`));
  const P = d.platform || {};
  const platPct = pct(P.usedBytes, P.capacityBytes);

  const rows = d.items.length ? d.items.map((it) => {
    const rel = (cwd ? cwd + '/' : '') + it.name;
    const kind = it.dir ? 'folder' : fileKind(it.name);
    return `<div class="drive-row" data-path="${esc(rel)}" data-dir="${it.dir ? 1 : 0}">
      <span class="drive-ic k-${kind}" aria-hidden="true">${it.dir ? '&#128193;' : { images: '&#128444;', video: '&#127910;', audio: '&#127925;', archives: '&#128230;', documents: '&#128196;', other: '&#128459;' }[kind]}</span>
      <span class="drive-name">${it.dir ? `<a href="#/storage?p=${encodeURIComponent(rel)}">${esc(it.name)}</a>` : esc(it.name)}</span>
      <span class="drive-size">${it.dir ? '' : fmtBytes(it.size)}</span>
      <span class="drive-mod">${new Date(it.modified).toLocaleDateString()}</span>
      <span class="drive-act">
        ${it.dir ? '' : '<button class="btn btn-sm btn-ghost" data-do="dl">Download</button>'}
        <button class="btn btn-sm btn-ghost" data-do="rn">Rename</button>
        <button class="btn btn-sm btn-ghost btn-danger" data-do="rm">Delete</button>
      </span>
    </div>`;
  }).join('') : `<div class="drive-empty"><b>This folder is empty</b><span>Drop files here or press Upload to add your first one.</span></div>`;

  $('#view').innerHTML = `
  <div class="app"><div class="wrap">
    <div class="app-head">
      <div><h1>Storage</h1><p>Files for your bots - media, backups and assets. Private to your account.</p></div>
      <div class="app-head-actions">
        <button class="btn" id="newFolder">New folder</button>
        <button class="btn btn-primary" id="uploadBtn">Upload files</button>
        <input type="file" id="fileIn" multiple hidden />
      </div>
    </div>

    ${P.persistent === false ? `<div class="alert drive-warn" style="display:block"><b>Temporary storage.</b> This server has no persistent disk, so files here are deleted when it redeploys or restarts. Download anything you need to keep.</div>` : ''}
    <div class="drive-top">
      <div class="card drive-meter">
        <div class="drive-meter-head"><div><span class="drive-big">${fmtBytes(d.usedBytes)}</span><span class="drive-of"> of ${fmtBytes(d.quotaBytes)} used</span></div><span class="chip">${fmtBytes(free)} free</span></div>
        <div class="stackbar" role="img" aria-label="Storage used by file type">${segs}</div>
        <div class="drive-legend">${legend}</div>
      </div>
      <div class="card drive-plat">
        <div class="drive-plat-k">Platform capacity</div>
        <div class="drive-plat-v">${fmtBytes(P.capacityBytes)}</div>
        <div class="meter ${platPct > 90 ? 'warn' : 'ok'}"><span style="width:${Math.max(1, platPct)}%"></span></div>
        <div class="drive-plat-s">${fmtBytes(P.usedBytes)} used across all accounts${P.limited ? ' &middot; limited by the disk attached to this server' : ''}</div>
      </div>
    </div>

    <div class="card drive-box" id="driveBox">
      <div class="drive-crumbs">${crumbs.join('<span>/</span>')}</div>
      <div class="drive-head"><span></span><span>Name</span><span>Size</span><span>Modified</span><span></span></div>
      <div class="drive-list">${rows}</div>
      <div class="drive-drop" id="dropHint">Drop files to upload (up to ${fmtBytes(d.maxFileMB * 1048576)} each)</div>
      <div class="drive-prog" id="driveProg" hidden><div class="meter ok"><span style="width:0%"></span></div><small></small></div>
    </div>
  </div></div>`;

  const here = '?path=' + encodeURIComponent(cwd);
  const upload = (files) => {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    const prog = $('#driveProg'); prog.hidden = false;
    const bar = $('span', prog), label = $('small', prog);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/storage/upload' + here);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.style.width = (e.loaded / e.total * 100) + '%'; label.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''} - ${fmtBytes(e.loaded)} of ${fmtBytes(e.total)}`; } };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) toast(`Uploaded ${r.saved.length} file${r.saved.length > 1 ? 's' : ''}`);
      else toast(r.error || 'Upload failed', 'err');
      renderStorage();
    };
    xhr.onerror = () => { toast('Upload failed - check your connection', 'err'); prog.hidden = true; };
    xhr.send(fd);
  };
  $('#uploadBtn').onclick = () => $('#fileIn').click();
  $('#fileIn').onchange = (e) => upload(Array.from(e.target.files));
  const box = $('#driveBox');
  ['dragenter', 'dragover'].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.remove('dragging'); }));
  box.addEventListener('drop', (e) => upload(Array.from(e.dataTransfer.files)));

  $('#newFolder').onclick = async () => {
    const name = prompt('Folder name');
    if (!name) return;
    try { await api('/api/storage/folder', { method: 'POST', body: { path: cwd, name } }); renderStorage(); } catch (e) { toast(e.message, 'err'); }
  };
  $$('.drive-row [data-do]').forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('.drive-row'); const rel = row.dataset.path; const act = btn.dataset.do;
      try {
        if (act === 'dl') { location.href = '/api/storage/download?path=' + encodeURIComponent(rel); return; }
        if (act === 'rn') {
          const cur = rel.split('/').pop();
          const name = prompt('New name', cur);
          if (!name || name === cur) return;
          await api('/api/storage/rename', { method: 'POST', body: { path: rel, name } });
        }
        if (act === 'rm') {
          if (!confirm(`Delete "${rel.split('/').pop()}"? This cannot be undone.`)) return;
          await api('/api/storage?path=' + encodeURIComponent(rel), { method: 'DELETE' });
          toast('Deleted');
        }
        renderStorage();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
