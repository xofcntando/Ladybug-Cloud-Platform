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
  '/developers': renderDevelopers,
  '/web': renderWebConsole,
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
      <a href="#/developers" class="nav-link hide-sm">Developers</a>
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
      <a href="#/developers" class="nav-link hide-sm">Developers</a>
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
      <span><b>Ladybug Cloud</b> by Ntandomods &middot; <a href="#/developers">Developers &amp; API</a></span>
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
      <button class="btn btn-ghost" data-act="web" title="Open WhatsApp for this bot number">WhatsApp</button>
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

  if (act === 'web') return (location.hash = '#/web?bot=' + bot.id);
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

/* ---------------------------------------------------------------- linked devices (restore without pairing) */
async function loadDevicesBox(mount, { botId, getName, onDone }) {
  const box = typeof mount === 'string' ? $(mount) : mount;
  if (!box) return;
  let data;
  try { data = await api('/api/devices'); } catch (e) { return; }
  const devs = data.devices || [];
  if (!devs.length) { box.innerHTML = ''; return; }
  const when = (d) => new Date(d).toLocaleDateString();
  box.innerHTML = `
    <div class="pair-box">
      <div class="pair-head">Restore a previously linked device</div>
      <div class="hint" style="margin:0 0 10px">No new code needed. These numbers were linked before and their saved sessions are still valid.</div>
      ${devs.map((d) => `
        <div class="pair-row" style="align-items:center;margin-bottom:8px">
          <div style="flex:1;min-width:0">
            <b>+${esc(d.number)}</b> ${d.label ? '· ' + esc(d.label) : d.waName && d.waName !== '~' ? '· ' + esc(d.waName) : ''}
            <div class="hint" style="margin:0">${d.status === 'logged_out' ? '<span style="color:#ef4444">Logged out by WhatsApp, pair again</span>' : d.inUseBy ? 'In use by ' + esc(d.inUseBy.name) : 'Linked ' + when(d.linkedAt)}</div>
          </div>
          <button class="btn btn-sm btn-primary" data-restore="${esc(d.id)}" ${d.status === 'logged_out' || (d.inUseBy && d.inUseBy.id === botId) ? 'disabled' : ''}>Restore</button>
          <button class="btn btn-sm" data-forget="${esc(d.id)}" title="Forget this device">✕</button>
        </div>`).join('')}
    </div>`;
  box.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        const body = botId ? { botId } : { name: (getName && getName()) || undefined };
        await api(`/api/devices/${b.dataset.restore}/restore`, { method: 'POST', body });
        toast('Device restored');
        onDone && onDone();
      } catch (e) {
        b.disabled = false; b.textContent = 'Restore';
        toast(e.message, 'err');
      }
    };
  });
  box.querySelectorAll('[data-forget]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Forget this saved device? You can always pair it again.')) return;
      try { await api(`/api/devices/${b.dataset.forget}`, { method: 'DELETE' }); loadDevicesBox(mount, { botId, getName, onDone }); }
      catch (e) { toast(e.message, 'err'); }
    };
  });
}

function openNewBot() {
  if (state.bots.length >= state.limit) {
    return toast(`Bot limit reached (${state.limit}). Contact the admin to upgrade.`, 'err');
  }
  openModal(`
    <h3>Create your bot</h3>
    <p class="sub">Pair a number in the browser, or paste an existing session ID.</p>
    <div class="alert alert-error" id="mErr"></div>
    <div class="field"><label>Bot Name</label><input class="input" id="mName" placeholder="My Ladybug" maxlength="40" /></div>

    <div id="mDevices"></div>
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
  loadDevicesBox('#mDevices', { getName: () => $('#mName').value.trim(), onDone: () => { closeModal(); renderDashboard(); } });

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
      out.innerHTML = `<div class="pair-ok">Paired as <b>${esc(who)}</b>. The session is filled in below and saved to your linked devices.</div>`;
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

/* ---------------------------------------------------------------- WhatsApp Web console */
let webES = null;
function closeWebStream() { if (webES) { webES.close(); webES = null; } }
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/web')) closeWebStream(); });

async function renderWebConsole() {
  if (!state.user) return (location.hash = '#/login');
  closeWebStream();
  const botId = (/[?&]bot=([^&]+)/.exec(location.hash) || [])[1];
  let bot = null;
  try { bot = (await api('/api/bots')).bots.find((b) => b.id === botId); } catch (e) { /* handled below */ }
  if (!bot) return (location.hash = '#/dashboard');

  document.title = 'WhatsApp - by Ntandomods';
  const WAI = {"user": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\"><path fill=\"currentColor\" d=\"M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-3.300 0-10 1.700-10 5v3h20v-3c0-3.300-6.700-5-10-5z\"/></svg>", "chat": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\"><path fill=\"currentColor\" d=\"M19.8 4H4.2C3 4 2 5 2 6.2v15.4l4-4h13.8c1.2 0 2.2-1 2.2-2.2V6.2C22 5 21 4 19.8 4zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z\"/></svg>", "bots": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\"><path fill=\"currentColor\" d=\"M12 2a2 2 0 0 1 1 3.7V7h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3h4V5.7A2 2 0 0 1 12 2zM8.5 12a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z\"/></svg>", "moon": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\"><path fill=\"currentColor\" d=\"M12 3a9 9 0 1 0 9 9c0-.5 0-.9-.1-1.4A5.5 5.5 0 0 1 13.4 3.1C13 3 12.5 3 12 3z\"/></svg>", "new": "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\"><path fill=\"currentColor\" d=\"M19.2 3H4.8C3.8 3 3 3.8 3 4.8v14.4L7 15h12.2c1 0 1.8-.8 1.8-1.8V4.8c0-1-.8-1.8-1.8-1.8zM16 10h-3v3h-2v-3H8V8h3V5h2v3h3v2z\" transform=\"translate(0 1.5)\"/></svg>", "search": "<svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\"><path fill=\"currentColor\" d=\"M15.9 14.3H15l-.3-.3c1-1.1 1.6-2.7 1.6-4.3 0-3.7-3-6.7-6.7-6.7S3 6 3 9.7s3 6.7 6.7 6.7c1.6 0 3.2-.6 4.3-1.6l.3.3v.8l5.1 5.1 1.5-1.5-5-5.2zm-6.2 0a4.6 4.6 0 1 1 0-9.200 4.600 4.600 0 0 1 0 9.200z\"/></svg>", "send": "<svg viewBox=\"0 0 24 24\" width=\"24\" height=\"24\"><path fill=\"currentColor\" d=\"M1.1 21.8 23 12.4 1.1 3l-.1 7.300 15.600 2.100L1 14.500z\"/></svg>", "emoji": "<svg viewBox=\"0 0 24 24\" width=\"26\" height=\"26\"><path fill=\"currentColor\" d=\"M9.15 11.4a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zm5.7 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4zM12 17.5c2 0 3.700-1.100 4.500-2.700H7.500c.8 1.600 2.500 2.700 4.500 2.700zM12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z\"/></svg>", "lock": "<svg viewBox=\"0 0 24 24\" width=\"12\" height=\"12\"><path fill=\"currentColor\" d=\"M12 1a5 5 0 0 0-5 5v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm-3 5a3 3 0 0 1 6 0v2H9V6z\"/></svg>"};
  let waTheme = 'dark';
  try { waTheme = localStorage.getItem('wa_theme') || 'dark'; } catch (e) { /* ignore */ }
  const myInitial = esc((bot.name || 'W').charAt(0).toUpperCase());
  $('#view').innerHTML = `
  <div class="wa-app" id="waApp" data-theme="${waTheme}">
    <nav class="wa-rail">
      <a class="wa-rail-btn on" title="Chats">${WAI.chat}</a>
      <a class="wa-rail-btn" href="#/dashboard" title="Back to my bots">${WAI.bots}</a>
      <button class="wa-rail-btn" id="waStarBtn" title="Starred messages"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="m12 17.300 6.200 3.700-1.600-7L22 9.200l-7.200-.6L12 2 9.200 8.600 2 9.200 7.400 14l-1.600 7z"/></svg></button>
      <span class="wa-rail-grow"></span>
      <button class="wa-rail-btn" id="waTheme" title="Switch light / dark theme">${WAI.moon}</button>
      <button class="wa-rail-me" id="waMe" title="Profile">${myInitial}</button>
    </nav>
    <div class="wa-shell" id="waShell">
      <aside class="wa-side">
        <header class="wa-side-head">
          <div class="wa-brand"><b>WhatsApp</b><small>by Ntandomods</small></div>
          <div class="wa-side-icons">
            <button class="wa-icon-btn" id="waNew" title="New chat">${WAI.new}</button>
            <button class="wa-icon-btn" id="waProfBtn" title="Profile and settings">${WAI.user}</button>
          </div>
        </header>
        <div class="wa-status" id="waStatus"><span class="wa-dot"></span><span>Checking connection…</span></div>
        <div class="wa-searchbar"><div class="wa-searchbox">${WAI.search}<input id="waSearch" placeholder="Search or start a new chat" autocomplete="off" /></div></div>
        <div class="wa-tabs" id="waTabs">
          <button data-tab="all" class="on">All</button>
          <button data-tab="online">Online <i id="waOnlineN">0</i></button>
          <button data-tab="unread">Unread <i id="waUnreadN">0</i></button>
          <button data-tab="archived">Archived <i id="waArchN">0</i></button>
        </div>
        <div class="wa-list" id="waList"><div class="chat-empty">Loading…</div></div>
        <div class="wa-profile" id="waProfile" hidden></div>
      </aside>
      <section class="wa-main" id="waMain">
        <div class="wa-empty" id="waEmpty">
          <img src="/img/logo.png" alt="" class="wa-empty-logo" />
          <h2>WhatsApp - by Ntandomods</h2>
          <p>Send and receive messages as <b>${esc(bot.name)}</b>, live, from your browser.<br>Pick a chat on the left or start a new one.</p>
          <div class="wa-empty-foot">${WAI.lock} Messages are shown live and never stored on the server</div>
        </div>
        <div class="wa-top" id="waTop"></div>
        <div class="wa-find" id="waFind" hidden><input id="waFindInput" placeholder="Search in this chat" autocomplete="off" /><span id="waFindCount"></span><button class="wa-icon-btn" id="waFindClose" title="Close">✕</button></div>
        <div class="wa-thread" id="waThread"></div>
        <div class="wa-attach" id="waAttach" hidden></div>
        <div class="wa-reply" id="waReply" hidden></div>
        <form class="wa-compose" id="waForm" hidden>
          <button type="button" class="wa-icon-btn" id="waClipBtn" title="Attach photo or file"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M1.800 12.700 12 2.500c2.400-2.400 6.400-2.400 8.800 0s2.400 6.400 0 8.800L11 21.100c-1.700 1.700-4.500 1.700-6.200 0s-1.700-4.500 0-6.200L13.500 6.200l1.400 1.400-8.700 8.700c-.9.900-.9 2.300 0 3.200s2.300.9 3.200 0l9.800-9.800c1.600-1.600 1.600-4.200 0-5.800s-4.200-1.600-5.800 0L3.200 14.100z"/></svg></button>
          <input type="file" id="waFile" accept="image/jpeg,image/png,image/webp,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip" hidden />
          <div class="wa-emoji-wrap">
            <button type="button" class="wa-icon-btn" id="waEmojiBtn" title="Emoji">${WAI.emoji}</button>
            <div class="wa-emoji-pop" id="waEmojiPop" hidden></div>
          </div>
          <div class="wa-input-wrap"><textarea id="waText" rows="1" maxlength="4096" placeholder="Type a message"></textarea></div>
          <button class="wa-send" type="submit" title="Send">${WAI.send}</button>
        </form>
        <aside class="wa-info" id="waInfo"></aside>
      </section>
    </div>
  </div>`;
  const waApp = $('#waApp');
  $('#waTheme').onclick = () => {
    waTheme = waTheme === 'dark' ? 'light' : 'dark';
    waApp.dataset.theme = waTheme;
    try { localStorage.setItem('wa_theme', waTheme); } catch (e) { /* ignore */ }
  };
  {
    const pop = $('#waEmojiPop');
    pop.innerHTML = '😀 😂 🥹 😍 😘 😎 🤔 😅 😭 😡 👍 👎 🙏 👏 🙌 💪 🔥 ❤️ 💚 🎉 ✅ ❌ 🐞 👀 🤝 💯'.split(' ').map((e) => `<button type="button">${e}</button>`).join('');
    $('#waEmojiBtn').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
    pop.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const ta = $('#waText');
      ta.value += b.textContent;
      ta.focus();
      ta.dispatchEvent(new Event('input'));
    };
    document.addEventListener('click', (e) => { if (!e.target.closest('.wa-emoji-wrap')) pop.hidden = true; });
  }

  const base = `/api/bots/${bot.id}/web`;
  const S = { chats: [], jid: null, msgs: [], replyTo: null, q: '', tab: 'all', conn: null, me: null, wa: null, groupSize: null, typingOn: false, find: '' };
  const TYPING_TTL = 12000, ONLINE_TTL = 180000;
  // Presence as it should look right now. Typing expires on its own and a silent 'online' goes stale.
  function eff(c) {
    const p = c.presence;
    if (!p) return { state: 'unknown' };
    const age = Date.now() - (c._pAt || 0);
    let st = p.state;
    if ((st === 'composing' || st === 'recording') && age > TYPING_TTL) st = 'available';
    if (st === 'available' && age > ONLINE_TTL) st = 'unknown';
    return { state: st, lastSeen: p.lastSeen };
  }
  const isOnline = (c) => ['available', 'composing', 'recording'].includes(eff(c).state);
  function lastSeenText(ts) {
    if (!ts) return 'offline';
    const d = new Date(ts * 1000), n = new Date();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === n.toDateString()) return 'last seen today at ' + t;
    const y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'last seen yesterday at ' + t;
    return 'last seen ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' + t;
  }
  function presenceLine(c) {
    if (!c) return '';
    if (c.isGroup) return S.groupSize ? S.groupSize + ' participants' : 'group';
    const e = eff(c);
    if (e.state === 'composing') return 'typing…';
    if (e.state === 'recording') return 'recording audio…';
    if (e.state === 'available') return 'online';
    if (e.state === 'unavailable') return lastSeenText(e.lastSeen);
    return '';
  }
  const avatarHtml = (c, size) => {
    const letter = esc((c.name || '?').replace(/^\+/, '').charAt(0).toUpperCase());
    const img = c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
    const dot = !c.isGroup && isOnline(c) ? '<i class="wa-online-dot"></i>' : '';
    return `<div class="wa-avatar ${size || ''}"><span>${letter}</span>${img}${dot}</div>`;
  };
  const hhmm = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayLabel = (t) => { const d = new Date(t * 1000); const n = new Date(); return d.toDateString() === n.toDateString() ? hhmm(t) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  const TICK1 = '<svg viewBox="0 0 16 11" width="16" height="11"><path fill="currentColor" d="M11.1.7 4.800 8.200 2 5.500.9 6.600l3.900 3.900L12.300 1.800z"/></svg>';
  const TICK2 = '<svg viewBox="0 0 16 11" width="16" height="11"><path fill="currentColor" d="m15.01 1.7-.9-.7a.4.4 0 0 0-.6.1L8.700 7.400a.4.4 0 0 1-.6 0L7.500 6.800l-.9 1 1.100 1.100c.4.4 1 .4 1.400 0l5.800-6.600a.4.4 0 0 0 .1-.6zM10.600 1.100l-.9-.7a.4.4 0 0 0-.6.1L4.800 6.600a.4.4 0 0 1-.6 0L1.900 4.300a.4.4 0 0 0-.6 0l-.8.9a.4.4 0 0 0 0 .6l3.100 3.100c.4.4 1 .4 1.400 0l5.700-6.700a.4.4 0 0 0 0-.6z"/></svg>';
  const tick = (m) => (m.fromMe ? `<span class="wa-tick ${m.status === 'read' ? 'read' : ''}">${m.status === 'delivered' || m.status === 'read' ? TICK2 : TICK1}</span>` : '');
  const icon = { image: '🖼', video: '🎬', voice: '🎤', audio: '🎵', document: '📄', sticker: '✨', contact: '👤', location: '📍', poll: '📊' };

  /* ---- per-bot preferences kept in this browser only (pins, archive, mute, stars, sounds) ---- */
  const PREF_KEY = 'wa_prefs_' + bot.id;
  const P = (() => { try { return Object.assign({ pinned: [], archived: [], muted: [], starred: {}, sound: true, desktop: false }, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { return { pinned: [], archived: [], muted: [], starred: {}, sound: true, desktop: false }; } })();
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(P)); } catch (e) { /* storage full or blocked */ } };
  const toggleIn = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); savePrefs(); return i < 0; };
  const fmtSize = (n) => (!n ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const MEDIA = {}; // message id -> { mime, data, name } once opened
  const WAI2 = {
    clip: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M1.8 12.700 12 2.500c2.400-2.400 6.400-2.400 8.800 0s2.400 6.400 0 8.800L11 21.100c-1.700 1.700-4.500 1.700-6.200 0s-1.700-4.500 0-6.200L13.500 6.200l1.400 1.400-8.700 8.700c-.9.900-.9 2.300 0 3.200s2.300.9 3.200 0l9.800-9.800c1.600-1.600 1.600-4.200 0-5.800s-4.200-1.600-5.800 0L3.200 14.100c-.1 0-1.400-1.400-1.400-1.400z"/></svg>',
    find: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M15.900 14.300H15l-.3-.3c1-1.100 1.600-2.700 1.600-4.300 0-3.700-3-6.700-6.700-6.700S3 6 3 9.700s3 6.700 6.700 6.700c1.600 0 3.200-.6 4.300-1.600l.3.3v.8l5.100 5.100 1.500-1.500-5-5.200zm-6.200 0a4.600 4.600 0 1 1 0-9.200 4.600 4.600 0 0 1 0 9.200z"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="m12 17.300 6.200 3.700-1.600-7L22 9.200l-7.200-.6L12 2 9.200 8.600 2 9.200 7.400 14l-1.600 7z"/></svg>',
    chev: '<svg viewBox="0 0 19 20" width="16" height="17"><path fill="currentColor" d="M3.800 6.700l5.700 5.700 5.700-5.700 1.600 1.600-7.300 7.300-7.300-7.300z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.500L18.500 9H13z"/></svg>',
  };
  function beep() {
    if (!P.sound) return;
    try {
      const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.setValueAtTime(660, ctx.currentTime + 0.09);
      g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.24);
    } catch (e) { /* audio blocked until the user interacts */ }
  }
  function notifyNew(d) {
    if (d.entry.fromMe || d.entry.type === 'reaction' || P.muted.includes(d.jid)) return;
    if (d.jid === S.jid && !document.hidden) return;
    beep();
    if (P.desktop && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(d.chat.name || 'New message', { body: d.entry.text || d.entry.type, icon: '/img/logo.png', tag: d.jid });
        n.onclick = () => { window.focus(); openChat(d.jid); n.close(); };
      } catch (e) { /* not allowed here */ }
    }
  }
  // Floating menu used for chat and message actions.
  function popMenu(x, y, items) {
    document.querySelectorAll('.wa-pop').forEach((e) => e.remove());
    const m = document.createElement('div');
    m.className = 'wa-pop';
    m.innerHTML = items.filter(Boolean).map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.label}</button>`).join('');
    const list = items.filter(Boolean);
    m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; m.remove(); list[Number(b.dataset.i)].run(); };
    $('#waApp').appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  }

  function paintStatus() {
    const el = $('#waStatus');
    if (!el) return;
    const online = S.chats.filter((c) => !c.isGroup && isOnline(c)).length;
    const unread = S.chats.reduce((n, c) => n + (c.unread ? 1 : 0), 0);
    const on = $('#waOnlineN'), un = $('#waUnreadN');
    if (on) on.textContent = online;
    if (un) un.textContent = unread;
    let cls = 'off', text = 'Checking connection…';
    const wa = S.wa || {};
    const cs = S.conn && S.conn.state;
    const who = S.me ? '+' + String(S.me.id || '').split(':')[0].split('@')[0] + (S.me.name ? ' (' + S.me.name + ')' : '') : '';
    if (S.stopped) { cls = 'off'; text = 'Bot is stopped. Start it from the dashboard to go online.'; }
    else if (cs === 'open' || (!cs && wa.state === 'connected')) {
      cls = 'on';
      const since = (S.conn && S.conn.since) || wa.since;
      text = `Connected${who ? ' as ' + esc(who) : ''}${since ? ' · linked ' + esc(ago(since)) : ''} · <b>${online}</b> contact${online === 1 ? '' : 's'} online`;
    } else if (wa.state === 'logged_out') { cls = 'bad'; text = 'This number was logged out of WhatsApp. Link it again with a fresh session.'; }
    else if (wa.state === 'conflict') { cls = 'warn'; text = 'Another device or server is using this session (conflict). Stop the other one so this bot can reconnect.'; }
    else if (cs === 'closed' || wa.state === 'reconnecting') { cls = 'warn'; text = 'Connection to WhatsApp dropped. Reconnecting…'; }
    else if (cs === 'connecting' || wa.state === 'connecting') { cls = 'warn'; text = 'Connecting to WhatsApp…'; }
    el.className = 'wa-status ' + cls;
    el.innerHTML = `<span class="wa-dot"></span><span>${text}</span>`;
  }
  function ago(ms) {
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h < 24 ? h + ' h ago' : Math.floor(h / 24) + ' d ago';
  }

  function paintList() {
    const box = $('#waList');
    if (!box) return;
    paintStatus();
    const archivedN = S.chats.filter((c) => P.archived.includes(c.jid)).length;
    const arch = $('#waArchN'); if (arch) arch.textContent = archivedN;
    const unreadTotal = S.chats.reduce((n, c) => n + (c.unread && !P.muted.includes(c.jid) ? c.unread : 0), 0);
    document.title = (unreadTotal ? `(${unreadTotal}) ` : '') + 'WhatsApp - by Ntandomods';
    let list = S.chats;
    if (S.tab === 'archived') list = list.filter((c) => P.archived.includes(c.jid));
    else list = list.filter((c) => !P.archived.includes(c.jid));
    if (S.tab === 'online') list = list.filter((c) => !c.isGroup && isOnline(c));
    if (S.tab === 'unread') list = list.filter((c) => c.unread);
    if (window.WALBL) list = WALBL.filter(list);
    if (S.tab === 'online') list = [...list].sort((a, b) => (eff(b).state === 'composing') - (eff(a).state === 'composing'));
    list = [...list].sort((a, b) => (P.pinned.includes(b.jid) - P.pinned.includes(a.jid)) || (b.lastTs - a.lastTs));
    if (!list.length) {
      box.innerHTML = `<div class="chat-empty">${S.chats.length
        ? (window.WALBL && WALBL.filtering() ? 'No chats with this label in this view.' : S.tab === 'online' ? 'Nobody is online right now. People show up here the moment WhatsApp reports them online or typing.' : S.tab === 'archived' ? 'No archived chats.' : 'No unread chats.')
        : 'No chats yet. When someone messages this number it shows up here.'}</div>`;
      return;
    }
    box.innerHTML = list.map((c) => {
      const e = eff(c);
      const typing = e.state === 'composing' || e.state === 'recording';
      const last = typing
        ? `<span class="wa-last wa-typing-txt">${e.state === 'composing' ? 'typing…' : 'recording audio…'}</span>`
        : `<span class="wa-last">${c.lastFromMe ? 'You: ' : ''}${esc(c.lastText || '')}</span>`;
      const pinned = P.pinned.includes(c.jid), muted = P.muted.includes(c.jid);
      return `
      <div class="wa-chat ${c.jid === S.jid ? 'active' : ''}" data-jid="${esc(c.jid)}">
        ${avatarHtml(c)}
        <div class="wa-chat-body">
          <div class="wa-chat-row"><b class="wa-name">${esc(c.name)}</b><span>${c.lastTs ? dayLabel(c.lastTs) : ''}</span></div>${window.WALBL ? WALBL.chips(c.jid) : ''}
          <div class="wa-chat-row">${last}<em class="wa-flags">${muted ? '<u title="Muted">🔕</u>' : ''}${pinned ? '<u title="Pinned">📌</u>' : ''}</em>${c.unread ? `<i class="wa-badge ${muted ? 'muted' : ''}">${c.unread}</i>` : ''}<button class="wa-chat-menu" data-cmenu="${esc(c.jid)}" title="Options">${WAI2.chev}</button></div>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-jid]').forEach((el) => {
      el.onclick = (e) => { if (e.target.closest('[data-cmenu]')) return; openChat(el.dataset.jid); };
      el.oncontextmenu = (e) => { e.preventDefault(); chatMenu(el.dataset.jid, e.clientX, e.clientY); };
    });
    box.querySelectorAll('[data-cmenu]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const r = b.getBoundingClientRect(); chatMenu(b.dataset.cmenu, r.left, r.bottom); }; });
    queueAvatars(list);
  }
  function chatMenu(jid, x, y) {
    const c = S.chats.find((k) => k.jid === jid);
    if (!c) return;
    popMenu(x, y, [
      { label: P.pinned.includes(jid) ? 'Unpin chat' : 'Pin chat', run: () => { if (!P.pinned.includes(jid) && P.pinned.length >= 3) return toast('You can pin up to 3 chats', 'err'); toggleIn(P.pinned, jid); paintList(); } },
      { label: P.archived.includes(jid) ? 'Unarchive chat' : 'Archive chat', run: () => { toggleIn(P.archived, jid); paintList(); } },
      { label: P.muted.includes(jid) ? 'Unmute notifications' : 'Mute notifications', run: () => { toggleIn(P.muted, jid); paintList(); } },
      window.WALBL ? { label: 'Labels…', run: () => WALBL.pick(jid) } : null,
      window.WAGAL ? { label: 'Media, docs and links', run: () => WAGAL.open(jid) } : null,
      window.WAX ? { label: 'Export chat (.txt)', run: () => WAX.exportChat(jid) } : null,
      c.unread ? { label: 'Mark as read', run: () => { c.unread = 0; api(base + '/read', { method: 'POST', body: { jid } }).catch(() => {}); paintList(); } } : null,
    ]);
  }

  // Profile pictures load one at a time so we never hammer WhatsApp.
  const avatarSeen = new Set();
  let avatarBusy = false;
  const avatarQ = [];
  function queueAvatars(list) {
    for (const c of list.slice(0, 40)) if (!c.avatar && !avatarSeen.has(c.jid)) { avatarSeen.add(c.jid); avatarQ.push(c.jid); }
    pumpAvatars();
  }
  async function pumpAvatars() {
    if (avatarBusy) return;
    avatarBusy = true;
    while (avatarQ.length && $('#waList')) {
      const jid = avatarQ.shift();
      try {
        const r = await api(`${base}/avatar?jid=${encodeURIComponent(jid)}`);
        const c = S.chats.find((x) => x.jid === jid);
        if (c && r.url) { c.avatar = r.url; paintListSoon(); }
      } catch (e) { /* contact hides it, or bot offline */ }
      await new Promise((r) => setTimeout(r, 700));
    }
    avatarBusy = false;
  }
  let paintT = null;
  function paintListSoon() { clearTimeout(paintT); paintT = setTimeout(() => { paintList(); paintTop(); }, 150); }

  function paintTop() {
    const c = S.chats.find((x) => x.jid === S.jid) || S.chat;
    const top = $('#waTop');
    if (!top || !c || !S.jid) return;
    const line = presenceLine(c);
    const live = !c.isGroup && isOnline(c);
    top.innerHTML = `<button class="wa-icon-btn wa-back" id="waBack" title="Back">←</button><div class="wa-top-click" id="waTopInfo">${avatarHtml(c)}<div class="wa-who-top"><b>${esc(c.name)}</b><span class="wa-presence ${live ? 'live' : ''} ${eff(c).state === 'composing' ? 'typing' : ''}">${esc(line || S.jid.split('@')[0])}</span></div></div>
      <button class="wa-icon-btn" id="waFindBtn" title="Search in chat">${WAI2.find}</button>
      <button class="wa-icon-btn" id="waInfoBtn" title="${c.isGroup ? 'Group info' : 'Contact info'}">${WAI2.info}</button>
      ${c.isGroup ? '' : '<button class="wa-icon-btn wa-block-btn" id="waBlockBtn" title="Block contact"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.900-6.300L5.700 16.900A8 8 0 0 1 4 12zm8 8a8 8 0 0 1-4.900-1.700L18.300 7.100A8 8 0 0 1 12 20z"/></svg></button>'}`;
    $('#waBack').onclick = () => { $('#waShell').classList.remove('chat-open'); $('#waMain').classList.remove('info-open'); };
    const bb = $('#waBlockBtn'); if (bb) bb.onclick = toggleBlock;
    $('#waFindBtn').onclick = toggleFind;
    $('#waInfoBtn').onclick = openInfo;
    $('#waTopInfo').onclick = openInfo;
    if (window.WAGAL) WAGAL.decorateTop(top);
  }

  /* search inside the open chat */
  function toggleFind() {
    const bar = $('#waFind');
    bar.hidden = !bar.hidden;
    S.find = '';
    $('#waFindInput').value = '';
    if (!bar.hidden) $('#waFindInput').focus();
    paintThread(false);
  }

  /* extra rows in the info drawer: media gallery, labels, save contact */
  function decorateInfo(box, c) {
    const body = box.querySelector('.wa-prof-body');
    if (!body) return;
    if (window.WACON) WACON.decorateInfo(box, c);
    const row = document.createElement('div');
    row.className = 'wa-con-act';
    row.innerHTML = [window.WAGAL ? '<button class="wa-btn ghost" data-gal>Media, docs and links</button>' : '', window.WALBL ? '<button class="wa-btn ghost" data-lbl>Labels</button>' : ''].join('');
    const anchor = body.querySelector('.wa-con-act') || body.querySelector('.wa-info-top');
    if (anchor) anchor.after(row); else body.prepend(row);
    const g = row.querySelector('[data-gal]'); if (g) g.onclick = () => WAGAL.open(c.jid);
    const l = row.querySelector('[data-lbl]'); if (l) l.onclick = () => WALBL.pick(c.jid);
  }

  /* group / contact info drawer */
  async function openInfo() {
    const c = S.chats.find((x) => x.jid === S.jid) || S.chat;
    if (!c) return;
    const box = $('#waInfo');
    $('#waMain').classList.add('info-open');
    box.innerHTML = `<header class="wa-prof-head"><button class="wa-icon-btn" id="waInfoClose" title="Close">✕</button><b>${c.isGroup ? 'Group info' : 'Contact info'}</b></header><div class="chat-empty">Loading…</div>`;
    $('#waInfoClose').onclick = () => $('#waMain').classList.remove('info-open');
    const head = `<div class="wa-info-top">${avatarHtml(c, 'big')}<h3>${esc(c.name)}</h3><small>${c.isGroup ? '' : '+' + esc(String(c.jid).split('@')[0].split(':')[0])}</small></div>`;
    if (!c.isGroup) {
      const mediaN = S.msgs.filter((m) => ['image', 'video', 'document', 'audio', 'voice'].includes(m.type)).length;
      box.innerHTML = `<header class="wa-prof-head"><button class="wa-icon-btn" id="waInfoClose">✕</button><b>Contact info</b></header><div class="wa-prof-body">${head}<div class="wa-set-row"><span>Messages in this session</span><b>${S.msgs.length}</b></div><div class="wa-set-row"><span>Media and files</span><b>${mediaN}</b></div><div class="wa-set-row"><span>Starred messages</span><b>${Object.values(P.starred).filter((x) => x.jid === c.jid).length}</b></div></div>`;
      $('#waInfoClose').onclick = () => $('#waMain').classList.remove('info-open');
      decorateInfo(box, c);
      return;
    }
    try {
      const g = await api(`${base}/group?jid=${encodeURIComponent(c.jid)}`);
      const people = g.participants.slice().sort((a, b) => (!!b.admin - !!a.admin) || (b.me - a.me));
      box.innerHTML = `<header class="wa-prof-head"><button class="wa-icon-btn" id="waInfoClose">✕</button><b>Group info</b></header><div class="wa-prof-body">
        <div class="wa-info-top">${avatarHtml(c, 'big')}<h3>${esc(g.subject)}</h3><small>Group · ${g.size} participants${g.created ? ' · created ' + esc(new Date(g.created * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })) : ''}</small></div>
        ${g.desc ? `<h4 class="wa-sec">Description</h4><p class="wa-desc">${esc(g.desc).replace(/\n/g, '<br>')}</p>` : ''}
        <h4 class="wa-sec">${g.size} participants</h4>
        ${people.map((p) => `<div class="wa-blocked"><span>${esc(p.me ? 'You' : (p.name || '+' + p.phone))}</span>${p.admin ? '<em class="wa-admin">Group admin</em>' : ''}</div>`).join('')}
      </div>`;
      $('#waInfoClose').onclick = () => $('#waMain').classList.remove('info-open');
      decorateInfo(box, c);
    } catch (e) {
      box.innerHTML = `<header class="wa-prof-head"><button class="wa-icon-btn" id="waInfoClose">✕</button><b>Group info</b></header><div class="wa-prof-body">${head}<div class="chat-empty">${esc(e.message)}</div></div>`;
      $('#waInfoClose').onclick = () => $('#waMain').classList.remove('info-open');
    }
  }

  const hl = (text) => {
    const safe = window.WAX ? WAX.fmt(esc(text)) : esc(text).replace(/\n/g, '<br>');
    const q = (S.find || '').trim();
    if (!q) return safe;
    const re = new RegExp('(' + esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return safe.split(/(<[^>]*>)/).map((part) => (part.startsWith('<') ? part : part.replace(re, '<mark>$1</mark>'))).join('');
  };
  function mediaHtml(m) {
    const got = MEDIA[m.id];
    const meta = m.media || {};
    if (!got && m.thumb && ['image', 'video', 'sticker'].includes(m.type)) {
      const state = m._loading ? 'Loading…' : m._err ? 'Tap to retry' : m.type === 'video' ? '▶ Tap to play' : 'Tap to open';
      return `<div class="wa-thumbwrap" data-open="${esc(m.id)}"><img class="wa-img thumb" src="${m.thumb}" alt=""><span class="wa-thumb-badge ${m._err ? 'err' : ''}">${state}</span>${m._err ? `<small class="wa-thumb-err">${esc(m._err)}</small>` : ''}</div>`;
    }
    if (m.type === 'sticker' && got) return `<img class="wa-img sticker" src="${got.data}" alt="">`;
    if (m.type === 'image' && got) return `<img class="wa-img" data-zoom="${esc(m.id)}" src="${got.data}" alt="photo">`;
    if (m.type === 'video' && got) return `<video class="wa-vid" src="${got.data}" controls preload="metadata"></video>`;
    if (m.type === 'voice' && window.WAX) return WAX.voiceHtml(m);
    if ((m.type === 'audio' || m.type === 'voice') && got) return `<audio class="wa-aud" src="${got.data}" controls></audio>`;
    if (m.type === 'document') {
      return `<div class="wa-doc" data-open="${esc(m.id)}">${WAI2.doc}<div><b>${esc(meta.name || m.text || 'Document')}</b><small>${esc(fmtSize(meta.size))}${got ? ' · tap to save' : ' · tap to download'}</small></div></div>`;
    }
    const nice = { image: 'photo', video: 'video', audio: 'audio file', voice: 'voice message', sticker: 'sticker' }[m.type];
    if (nice) return `<button class="wa-load" data-open="${esc(m.id)}">${m._loading ? 'Loading…' : (m._err ? 'Retry: ' + esc(m._err) : icon[m.type] + ' Load ' + nice + (meta.size ? ' (' + esc(fmtSize(meta.size)) + ')' : ''))}</button>`;
    return `<span class="wa-media">${icon[m.type] || ''} ${esc(m.type)}</span>`;
  }
  const KNOWN_MEDIA = ['image', 'video', 'voice', 'audio', 'document', 'sticker'];
  async function fetchMedia(m) {
    m._loading = true; m._err = null; paintThread(false);
    try { MEDIA[m.id] = await api(`${base}/media?jid=${encodeURIComponent(S.jid)}&id=${encodeURIComponent(m.id)}`); }
    catch (e) { m._err = e.message || 'Could not load'; m._failed = true; }
    m._loading = false;
    paintThread(false);
    return !!MEDIA[m.id];
  }
  async function openMedia(id, { save } = {}) {
    const m = S.msgs.find((x) => x.id === id);
    if (!m || m._loading) return;
    if (!MEDIA[id]) {
      const ok = await fetchMedia(m);
      if (!ok) return toast(m._err, 'err');
    }
    if (save || m.type === 'document') {
      const a = document.createElement('a');
      a.href = MEDIA[id].data; a.download = MEDIA[id].name || m.text || (m.type + '-' + id.slice(0, 6));
      document.body.appendChild(a); a.click(); a.remove();
    }
  }
  // photos and stickers open by themselves (one at a time), everything else waits for a click
  let autoBusy = false;
  async function autoLoadImages() {
    if (autoBusy) return;
    autoBusy = true;
    try {
      for (const m of S.msgs.slice(-40)) {
        if (!$('#waThread')) break;
        if ((m.type === 'image' || m.type === 'sticker') && !MEDIA[m.id] && !(m.media && m.media.size > 1.5 * 1048576) && !m._failed) {
          await fetchMedia(m);
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } finally { autoBusy = false; }
  }

  function paintThread(stick) {
    const t = $('#waThread');
    if (!t) return;
    const nearBottom = stick || t.scrollHeight - t.scrollTop - t.clientHeight < 120;
    let lastDay = '';
    let hits = 0;
    t.innerHTML = S.msgs.map((m) => {
      const day = new Date(m.ts * 1000).toDateString();
      const sep = day !== lastDay ? `<div class="wa-day">${esc(new Date(m.ts * 1000).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))}</div>` : '';
      lastDay = day;
      if (m.type === 'reaction') return sep;
      const who = !m.fromMe && S.chat && S.chat.isGroup ? `<div class="wa-who">${esc(m.senderName || '+' + m.sender)}</div>` : '';
      const star = P.starred[m.id] ? '<span class="wa-star" title="Starred">★</span>' : '';
      const edited = m.edited ? '<span class="wa-edited">edited</span>' : '';
      const menu = m.deleted ? '' : `<button class="wa-msg-menu" data-mmenu="${esc(m.id)}" title="Options">${WAI2.chev}</button>`;
      let inner;
      if (m.deleted) inner = '<span class="wa-deleted">This message was deleted</span>';
      else {
        const body = m.text ? hl(m.text) : '';
        const rp = window.WARICH ? WARICH.parts(m) : { top: '', rich: '', isRich: false, link: '', reacts: '' };
        const media = KNOWN_MEDIA.includes(m.type) ? mediaHtml(m) : (rp.isRich ? rp.rich : (icon[m.type] ? `<span class="wa-media">${icon[m.type]} ${esc(m.type)}</span>` : ''));
        const showText = m.type !== 'document' && !rp.isRich && m.text;
        inner = `${rp.top}${media}${media && showText ? '<br>' : ''}${showText ? body : ''}${rp.link}${rp.reacts}`;
        if (S.find && m.text && m.text.toLowerCase().includes(S.find.toLowerCase())) hits += 1;
      }
      return `${sep}<div class="wa-msg ${m.fromMe ? 'me' : 'them'}${m.edited || P.starred[m.id] || m.quoted || m.link || m.poll || m.location || m.contact ? ' wide' : ''}${m.reactions && Object.keys(m.reactions).length ? ' has-reacts' : ''}" data-id="${esc(m.id)}">${menu}${who}${inner}<div class="wa-meta">${star}${edited}${hhmm(m.ts)} ${tick(m)}</div></div>`;
    }).join('') || '<div class="chat-empty">No messages yet.</div>';
    const cnt = $('#waFindCount'); if (cnt) cnt.textContent = S.find ? hits + ' found' : '';
    t.querySelectorAll('[data-open]').forEach((el) => { el.onclick = () => openMedia(el.dataset.open); });
    t.querySelectorAll('[data-zoom]').forEach((el) => { el.onclick = () => zoomImage(el.src); });
    t.querySelectorAll('[data-mmenu]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const r = b.getBoundingClientRect(); msgMenu(b.dataset.mmenu, r.left - 120, r.bottom); }; });
    t.querySelectorAll('.wa-msg[data-id]').forEach((el) => { el.oncontextmenu = (e) => { e.preventDefault(); msgMenu(el.dataset.id, e.clientX, e.clientY); }; });
    if (window.WAX) WAX.afterPaint(t);
    if (nearBottom && !S.find) t.scrollTop = t.scrollHeight;
    autoLoadImages();
  }

  function zoomImage(src) {
    const o = document.createElement('div');
    o.className = 'wa-lightbox';
    o.innerHTML = `<img src="${src}" alt=""><a class="wa-lightbox-dl" href="${src}" download="photo.jpg" title="Download">⬇</a>`;
    o.onclick = (e) => { if (!e.target.closest('a')) o.remove(); };
    $('#waApp').appendChild(o);
  }

  function msgMenu(id, x, y) {
    const m = S.msgs.find((k) => k.id === id);
    if (!m || m.deleted) return;
    const fresh = Date.now() / 1000 - m.ts < 15 * 60;
    popMenu(x, y, [
      { label: 'Reply', run: () => setReply(m) },
      m.text ? { label: 'Copy text', run: () => { try { navigator.clipboard.writeText(m.text); toast('Copied'); } catch (e) { /* ignore */ } } } : null,
      m.type === 'text' ? { label: 'Forward', run: () => forwardDialog(m) } : null,
      { label: P.starred[m.id] ? 'Unstar' : 'Star', run: () => { if (P.starred[m.id]) delete P.starred[m.id]; else P.starred[m.id] = { jid: S.jid, id: m.id, text: m.text || m.type, ts: m.ts, fromMe: m.fromMe, chat: (S.chat && S.chat.name) || '' }; savePrefs(); paintThread(false); } },
      KNOWN_MEDIA.includes(m.type) ? { label: 'Download', run: () => openMedia(m.id, { save: true }) } : null,
      m.fromMe && m.type === 'text' && fresh ? { label: 'Edit', run: () => editDialog(m) } : null,
      m.fromMe ? { label: 'Delete for everyone', danger: true, run: async () => { if (!confirm('Delete this message for everyone?')) return; try { await api(base + '/delete', { method: 'POST', body: { jid: S.jid, id: m.id } }); m.deleted = true; m.text = ''; paintThread(false); } catch (er) { toast(er.message, 'err'); } } } : null,
    ]);
    if (window.WARICH) WARICH.addReactionRow(m);
  }

  function dialog(html) {
    const d = document.createElement('div');
    d.className = 'wa-dialog-back';
    d.innerHTML = `<div class="wa-dialog">${html}</div>`;
    d.onclick = (e) => { if (e.target === d) d.remove(); };
    $('#waApp').appendChild(d);
    return d;
  }
  function editDialog(m) {
    const d = dialog(`<h3>Edit message</h3><textarea id="waEditText" rows="4" maxlength="4096">${esc(m.text)}</textarea><div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Save</button></div>`);
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('[data-ok]').onclick = async () => {
      const text = d.querySelector('#waEditText').value.trim();
      if (!text || text === m.text) return d.remove();
      try { await api(base + '/edit', { method: 'POST', body: { jid: S.jid, id: m.id, text } }); m.text = text; m.edited = true; paintThread(false); d.remove(); }
      catch (er) { toast(er.message, 'err'); }
    };
    d.querySelector('#waEditText').focus();
  }
  function forwardDialog(m) {
    const d = dialog(`<h3>Forward message to…</h3><input class="wa-dialog-input" id="waFwdQ" placeholder="Search chats" /><div class="wa-fwd-list" id="waFwdList"></div>`);
    const draw = (q) => {
      const list = S.chats.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
      d.querySelector('#waFwdList').innerHTML = list.map((c) => `<div class="wa-fwd" data-j="${esc(c.jid)}">${avatarHtml(c)}<span>${esc(c.name)}</span></div>`).join('') || '<div class="chat-empty">No chats</div>';
      d.querySelectorAll('[data-j]').forEach((el) => { el.onclick = async () => { try { await api(base + '/send', { method: 'POST', body: { jid: el.dataset.j, text: m.text } }); toast('Forwarded'); d.remove(); } catch (er) { toast(er.message, 'err'); } }; });
    };
    draw('');
    d.querySelector('#waFwdQ').oninput = (e) => draw(e.target.value);
    d.querySelector('#waFwdQ').focus();
  }
  function starredDialog() {
    const items = Object.values(P.starred).sort((a, b) => b.ts - a.ts);
    const d = dialog(`<h3>Starred messages</h3><div class="wa-fwd-list">${items.map((x) => `<div class="wa-starred" data-j="${esc(x.jid)}"><small>${esc(x.fromMe ? 'You' : x.chat)} · ${esc(new Date(x.ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</small><div>${esc(x.text).slice(0, 300)}</div></div>`).join('') || '<div class="chat-empty">No starred messages yet. Use the message menu to star one.</div>'}</div>`);
    d.querySelectorAll('[data-j]').forEach((el) => { el.onclick = () => { d.remove(); openChat(el.dataset.j); }; });
  }

  function setReply(m) {
    S.replyTo = m || null;
    const r = $('#waReply');
    if (!m) { r.hidden = true; r.innerHTML = ''; return; }
    r.hidden = false;
    r.innerHTML = `<span>Replying to: ${esc((m.text || m.type).slice(0, 80))}</span><a href="#" id="waNoReply">✕</a>`;
    $('#waNoReply').onclick = (e) => { e.preventDefault(); setReply(null); };
    $('#waText').focus();
  }

  async function loadChats() {
    try {
      const r = await api(`${base}/chats?q=${encodeURIComponent(S.q)}`);
      const old = new Map(S.chats.map((c) => [c.jid, c]));
      S.chats = r.chats.map((c) => {
        const o = old.get(c.jid);
        if (c.presence) c._pAt = Date.now(); else if (o && o.presence) { c.presence = o.presence; c._pAt = o._pAt; }
        if (!c.avatar && o && o.avatar) c.avatar = o.avatar;
        return c;
      });
      S.conn = r.conn || S.conn; S.me = r.me || S.me; S.stopped = false;
      paintList();
    } catch (e) {
      if (/not running/i.test(e.message)) { S.stopped = true; paintStatus(); }
      $('#waList').innerHTML = `<div class="chat-empty">${esc(e.message)}${/not running/i.test(e.message) ? '<br><a href="#/dashboard">Start the bot first</a>' : ''}</div>`;
    }
  }

  async function openChat(jid) {
    if (window.WAX) WAX.beforeOpen(jid);
    S.jid = jid; S.replyTo = null; setReply(null);
    $('#waShell').classList.add('chat-open');
    $('#waMain').classList.add('has-chat');
    $('#waMain').classList.remove('info-open');
    $('#waFind').hidden = true; S.find = ''; $('#waFindInput').value = '';
    try {
      const r = await api(`${base}/messages?jid=${encodeURIComponent(jid)}&limit=100`);
      S.msgs = r.messages; S.chat = r.chat;
      S.groupSize = null;
      const known = S.chats.find((x) => x.jid === jid);
      if (known && r.chat && r.chat.presence && !known.presence) { known.presence = r.chat.presence; known._pAt = Date.now(); }
      paintTop();
      api(`${base}/presence?jid=${encodeURIComponent(jid)}`).then((p) => {
        if (S.jid !== jid) return;
        if (p.group) S.groupSize = p.size;
        else if (p.presence && known && p.presence.state !== 'unknown') { known.presence = p.presence; known._pAt = Date.now(); }
        paintTop(); paintList();
      }).catch(() => {});
      $('#waForm').hidden = false;
      paintThread(true);
      const c = S.chats.find((x) => x.jid === jid);
      if (c && c.unread) { c.unread = 0; api(base + '/read', { method: 'POST', body: { jid } }).catch(() => {}); }
      paintList();
    } catch (e) { toast(e.message, 'err'); }
  }

  $('#waForm').onsubmit = async (e) => {
    e.preventDefault();
    const ta = $('#waText');
    const raw = ta.value.trim();
    if (!raw || !S.jid) return;
    const prep = window.WAX ? WAX.prepareSend(raw) : { text: raw };
    const text = prep.text;
    ta.disabled = true;
    try {
      await api(base + '/send', { method: 'POST', body: { jid: S.jid, text, mentions: prep.mentions, quotedId: S.replyTo ? S.replyTo.id : undefined } });
      ta.value = ''; setReply(null);
    } catch (er) { toast(er.message, 'err'); }
    ta.disabled = false; ta.focus();
  };
  $('#waText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#waForm').requestSubmit(); } };

  document.querySelectorAll('#waTabs [data-tab]').forEach((b) => {
    b.onclick = () => {
      S.tab = b.dataset.tab;
      document.querySelectorAll('#waTabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
      paintList();
    };
  });

  // Let the other person see "typing..." while you write, and stop when you pause.
  let typingStop = null;
  $('#waText').addEventListener('input', () => {
    if (!S.jid) return;
    const jid = S.jid;
    if (!S.typingOn) { S.typingOn = true; api(base + '/typing', { method: 'POST', body: { jid, on: true } }).catch(() => {}); }
    clearTimeout(typingStop);
    typingStop = setTimeout(() => { S.typingOn = false; api(base + '/typing', { method: 'POST', body: { jid, on: false } }).catch(() => {}); }, 4000);
  });

  // Typing and 'online' expire on their own, so repaint now and then.
  const repaintTimer = setInterval(() => {
    if (!$('#waList')) return clearInterval(repaintTimer);
    paintList(); paintTop();
  }, 10000);

  let searchT = null;
  $('#waSearch').oninput = (e) => { clearTimeout(searchT); searchT = setTimeout(() => { S.q = e.target.value.trim(); loadChats(); }, 250); };

  $('#waNew').onclick = async () => {
    if (window.WACON) return WACON.open();
    const phone = prompt('Phone number with country code, e.g. 27821234567');
    if (!phone) return;
    try {
      const r = await api(base + '/lookup', { method: 'POST', body: { phone } });
      if (!r.exists) return toast('That number is not on WhatsApp', 'err');
      await loadChats();
      openChat(r.jid);
    } catch (e) { toast(e.message, 'err'); }
  };


  /* ------------------------------------------------------------ profile, privacy, blocked contacts */
  const PRIV_OPTS = {
    last: ['Last seen', [['all', 'Everyone'], ['contacts', 'My contacts'], ['contact_blacklist', 'My contacts except…'], ['none', 'Nobody']]],
    online: ['Online', [['all', 'Everyone'], ['match_last_seen', 'Same as last seen']]],
    profile: ['Profile photo', [['all', 'Everyone'], ['contacts', 'My contacts'], ['contact_blacklist', 'My contacts except…'], ['none', 'Nobody']]],
    status: ['About', [['all', 'Everyone'], ['contacts', 'My contacts'], ['contact_blacklist', 'My contacts except…'], ['none', 'Nobody']]],
    readreceipts: ['Read receipts (blue ticks)', [['all', 'On'], ['none', 'Off']]],
    groupadd: ['Who can add me to groups', [['all', 'Everyone'], ['contacts', 'My contacts'], ['contact_blacklist', 'My contacts except…']]],
    calladd: ['Who can call me', [['all', 'Everyone'], ['known', 'Known contacts only']]],
  };
  const DISAPPEAR = [[0, 'Off'], [86400, '24 hours'], [604800, '7 days'], [7776000, '90 days']];
  const profEl = $('#waProfile');
  let profLoaded = false;

  function setMeAvatar(url) {
    const me = $('#waMe');
    if (me && url) me.innerHTML = `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">`;
  }

  async function openProfile() {
    profEl.hidden = false;
    profEl.innerHTML = `<header class="wa-prof-head"><button class="wa-icon-btn" id="waProfClose" title="Close">←</button><b>Profile</b></header><div class="chat-empty">Loading profile…</div>`;
    $('#waProfClose').onclick = closeProfile;
    let p, pv = null, bl = [];
    try { p = await api(base + '/profile'); }
    catch (e) { profEl.querySelector('.chat-empty').textContent = e.message; return; }
    setMeAvatar(p.picture);
    const [pvR, blR] = await Promise.allSettled([api(base + '/privacy'), api(base + '/blocklist')]);
    if (pvR.status === 'fulfilled') pv = pvR.value.settings || {};
    if (blR.status === 'fulfilled') bl = blR.value.blocked || [];
    drawProfile(p, pv, bl);
  }
  function closeProfile() { profEl.hidden = true; }

  function drawProfile(p, pv, bl) {
    const initial = esc((p.name || bot.name || '?').charAt(0).toUpperCase());
    const privRows = pv ? Object.entries(PRIV_OPTS).map(([k, [label, opts]]) => {
      const cur = pv[k];
      const known = opts.some(([v]) => v === cur);
      return `<label class="wa-set-row"><span>${label}</span><select data-priv="${k}">${known || cur === undefined ? '' : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`}${opts.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
    }).join('') : '<div class="chat-empty">Privacy settings could not be loaded.</div>';
    profEl.innerHTML = `
      <header class="wa-prof-head"><button class="wa-icon-btn" id="waProfClose" title="Close">←</button><b>Profile</b></header>
      <div class="wa-prof-body">
        <div class="wa-prof-photo">
          <div class="wa-prof-avatar" id="waPhotoBtn" title="Change profile photo">
            ${p.picture ? `<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">` : `<span>${initial}</span>`}
            <div class="wa-prof-cam"><svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M12 15.200a3.200 3.200 0 1 0 0-6.400 3.200 3.200 0 0 0 0 6.400zM9 2 7.200 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.200L15 2H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg><i>CHANGE PHOTO</i></div>
          </div>
          <input type="file" id="waPhotoFile" accept="image/jpeg,image/png,image/webp" hidden />
          ${p.picture ? '<button class="wa-link-btn" id="waPhotoDel">Remove photo</button>' : ''}
        </div>
        <div class="wa-field"><label>Your name</label><div class="wa-field-row"><input id="waName" maxlength="25" value="${esc(p.name || '')}" /><button class="wa-icon-btn wa-save" id="waNameSave" title="Save name"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9 16.2 4.800 12l-1.400 1.400L9 19 21 7l-1.400-1.400z"/></svg></button></div><small>This is the name people see when you message them.</small></div>
        <div class="wa-field"><label>About</label><div class="wa-field-row"><input id="waAbout" maxlength="139" value="${esc(p.about || '')}" placeholder="Hey there! I am using WhatsApp." /><button class="wa-icon-btn wa-save" id="waAboutSave" title="Save about"><svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M9 16.2 4.800 12l-1.400 1.400L9 19 21 7l-1.400-1.400z"/></svg></button></div></div>
        <div class="wa-field"><label>Phone number</label><div class="wa-field-row"><input value="+${esc(p.phone)}" readonly /><button class="wa-icon-btn" id="waCopyPhone" title="Copy"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg></button></div></div>

        <h4 class="wa-sec">Notifications</h4>
        <label class="wa-set-row"><span>Message sound</span><input type="checkbox" id="waSnd" ${P.sound ? 'checked' : ''} /></label>
        <label class="wa-set-row"><span>Desktop notifications</span><input type="checkbox" id="waDsk" ${P.desktop ? 'checked' : ''} /></label>

        <h4 class="wa-sec">Privacy</h4>
        ${privRows}
        <label class="wa-set-row"><span>Default disappearing messages</span><select id="waDisappear">${DISAPPEAR.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
        <small class="wa-note">Applies to new chats only. Privacy changes are limited to a few a minute to keep your number safe.</small>

        <h4 class="wa-sec">Blocked contacts <i>${bl.length}</i></h4>
        <div id="waBlocked">${bl.length ? bl.map((b) => `<div class="wa-blocked"><span>${esc(b.name)}</span><button class="wa-link-btn" data-unblock="${esc(b.jid)}">Unblock</button></div>`).join('') : '<div class="wa-note">You have not blocked anyone.</div>'}</div>
      </div>`;
    $('#waProfClose').onclick = closeProfile;

    const guard = async (fn, ok) => { try { await fn(); toast(ok); } catch (e) { toast(e.message, 'err'); } };
    $('#waNameSave').onclick = () => guard(async () => { await api(base + '/profile', { method: 'POST', body: { name: $('#waName').value } }); S.me = { ...(S.me || {}), name: $('#waName').value.trim() }; paintStatus(); }, 'Name updated');
    $('#waAboutSave').onclick = () => guard(() => api(base + '/profile', { method: 'POST', body: { about: $('#waAbout').value } }), 'About updated');
    $('#waCopyPhone').onclick = () => { try { navigator.clipboard.writeText('+' + p.phone); toast('Number copied'); } catch (e) { /* ignore */ } };
    $('#waPhotoBtn').onclick = () => $('#waPhotoFile').click();
    $('#waPhotoFile').onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const dataUrl = await squarePhoto(f, 640);
        await api(base + '/profile', { method: 'POST', body: { picture: dataUrl } });
        toast('Profile photo updated');
        openProfile();
      } catch (er) { toast(er.message || 'Could not use that image', 'err'); }
    };
    const del = $('#waPhotoDel');
    if (del) del.onclick = () => { if (confirm('Remove your profile photo?')) guard(async () => { await api(base + '/profile', { method: 'POST', body: { removePicture: true } }); const me = $('#waMe'); if (me) me.textContent = (p.name || bot.name || 'W').charAt(0).toUpperCase(); openProfile(); }, 'Photo removed'); };
    profEl.querySelectorAll('[data-priv]').forEach((sel) => {
      sel.onchange = () => guard(() => api(base + '/privacy', { method: 'POST', body: { key: sel.dataset.priv, value: sel.value } }), 'Privacy updated');
    });
    $('#waSnd').onchange = (e) => { P.sound = e.target.checked; savePrefs(); if (P.sound) beep(); };
    $('#waDsk').onchange = async (e) => {
      if (!e.target.checked) { P.desktop = false; return savePrefs(); }
      if (!('Notification' in window)) { e.target.checked = false; return toast('This browser has no desktop notifications', 'err'); }
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      P.desktop = perm === 'granted'; e.target.checked = P.desktop; savePrefs();
      if (!P.desktop) toast('Notifications are blocked in your browser settings', 'err');
    };
    $('#waDisappear').onchange = (e) => guard(() => api(base + '/disappearing', { method: 'POST', body: { seconds: Number(e.target.value) } }), 'Default timer updated');
    profEl.querySelectorAll('[data-unblock]').forEach((b) => {
      b.onclick = () => guard(async () => { await api(base + '/block', { method: 'POST', body: { jid: b.dataset.unblock, block: false } }); b.closest('.wa-blocked').remove(); }, 'Contact unblocked');
    });
  }

  // Centre-crop to a square and shrink, so any phone photo uploads in well under 200 KB.
  function squarePhoto(file, size) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Choose a JPEG, PNG or WebP image'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = Math.min(size, side);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.88));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image')); };
      img.src = url;
    });
  }

  $('#waMe').onclick = openProfile;
  $('#waProfBtn').onclick = openProfile;
  // Block / unblock the open contact from the chat header.
  async function toggleBlock() {
    const c = S.chats.find((x) => x.jid === S.jid) || S.chat;
    if (!c || c.isGroup) return;
    if (!confirm(`Block ${c.name}? They will no longer be able to message or call you.`)) return;
    try { await api(base + '/block', { method: 'POST', body: { jid: S.jid, block: true } }); toast(c.name + ' blocked. Unblock from Profile.'); } catch (e) { toast(e.message, 'err'); }
  }


  /* ------------------------------------------------------------ search, attach, shortcuts */
  $('#waFindInput').oninput = (e) => {
    S.find = e.target.value;
    paintThread(false);
    const first = $('#waThread mark');
    if (first) first.scrollIntoView({ block: 'center' });
  };
  $('#waFindInput').onkeydown = (e) => {
    if (e.key === 'Escape') return toggleFind();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const marks = $$('#waThread mark');
    if (!marks.length) return;
    S.findIdx = ((S.findIdx || 0) + (e.shiftKey ? -1 : 1) + marks.length) % marks.length;
    marks[S.findIdx].scrollIntoView({ block: 'center' });
  };
  $('#waFindClose').onclick = toggleFind;
  $('#waStarBtn').onclick = starredDialog;

  // Attach: pick a file (or paste / drop an image), preview it, add a caption, send.
  const MAX_FILE = 8 * 1024 * 1024;
  function readDataUrl(file) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('Could not read that file')); r.readAsDataURL(file); });
  }
  async function shrinkImage(file, max = 1600) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Not a readable image')); i.src = url; });
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.86);
    } finally { URL.revokeObjectURL(url); }
  }
  async function stageFile(file) {
    if (!S.jid) return toast('Open a chat first', 'err');
    if (!file) return;
    if (file.size > MAX_FILE) return toast('That file is over the 8 MB limit', 'err');
    let data, name = file.name || 'file', isImg = /^image\/(jpeg|png|webp)$/.test(file.type);
    try { data = isImg && file.size > 1.2 * 1048576 ? await shrinkImage(file) : await readDataUrl(file); } catch (e) { return toast(e.message, 'err'); }
    if (isImg && data.startsWith('data:image/jpeg') && !/\.jpe?g$/i.test(name)) name = name.replace(/\.\w+$/, '') + '.jpg';
    const box = $('#waAttach');
    const preview = isImg ? `<img src="${data}" alt="">` : /^video\//.test(file.type) ? `<video src="${data}" controls></video>` : `<div class="wa-attach-file">${WAI2.doc}<b>${esc(name)}</b><small>${esc(fmtSize(file.size))}</small></div>`;
    box.hidden = false;
    box.innerHTML = `<div class="wa-attach-card"><button class="wa-icon-btn wa-attach-x" id="waAttachX" title="Cancel">✕</button><div class="wa-attach-prev">${preview}</div><div class="wa-attach-bar"><input id="waCaption" maxlength="900" placeholder="Add a caption" autocomplete="off" /><button class="wa-send" id="waAttachSend" title="Send"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M1.100 21.800 23 12.400 1.100 3l-.1 7.300 15.600 2.100L1 14.500z"/></svg></button></div></div>`;
    $('#waAttachX').onclick = () => { box.hidden = true; box.innerHTML = ''; };
    const send = async () => {
      const btn = $('#waAttachSend'); btn.disabled = true;
      try {
        await api(base + '/sendmedia', { method: 'POST', body: { jid: S.jid, data, name, caption: $('#waCaption').value.trim() || undefined } });
        box.hidden = true; box.innerHTML = '';
      } catch (er) { toast(er.message, 'err'); btn.disabled = false; }
    };
    $('#waAttachSend').onclick = send;
    $('#waCaption').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } };
    $('#waCaption').focus();
  }
  $('#waClipBtn').onclick = (e) => { e.stopPropagation(); if (window.WARICH) WARICH.attachMenu($('#waClipBtn'), () => $('#waFile').click()); else $('#waFile').click(); };
  $('#waFile').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; stageFile(f); };
  $('#waText').addEventListener('paste', (e) => {
    const f = Array.from((e.clipboardData && e.clipboardData.files) || []).find((x) => /^image\//.test(x.type));
    if (f) { e.preventDefault(); stageFile(f); }
  });
  const thread = $('#waThread');
  thread.addEventListener('dragover', (e) => { e.preventDefault(); });
  thread.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) stageFile(f); });
  document.addEventListener('keydown', function waKeys(e) {
    if (!document.getElementById('waApp')) return document.removeEventListener('keydown', waKeys);
    if (e.key === 'Escape') {
      document.querySelectorAll('.wa-pop,.wa-lightbox,.wa-dialog-back').forEach((x) => x.remove());
      if (!$('#waAttach').hidden) { $('#waAttach').hidden = true; $('#waAttach').innerHTML = ''; }
      else if (!$('#waProfile').hidden) closeProfile();
      else $('#waMain').classList.remove('info-open');
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#waSearch').focus(); }
  });

  if (window.WAX) {
    try { WAX.init({ S, base, bot, api, toast, esc, $, waApp, P, savePrefs, MEDIA, paintThread, paintList, setReply, openChat, dialog, popMenu, fetchMedia, hhmm }); }
    catch (e) { console.error('[wa-extras]', e); }
  }
  if (window.WARICH) {
    try { WARICH.init({ S, base, api, toast, dialog, popMenu, setReply, openChat, loadChats, paintThread }); }
    catch (e) { console.error('[wa-rich]', e); }
  }
  { const ctx = { S, base, bot, api, toast, esc, dialog, popMenu, openChat, loadChats, paintList, paintTop, avatarHtml, hhmm };
    for (const k of ['WALBL', 'WAGAL', 'WACON', 'WASTAT', 'WAAUTO']) { if (window[k]) { try { window[k].init(ctx); } catch (e) { console.error('[' + k + ']', e); } } } }
  if (window.WAACC) {
    try { WAACC.init({ bot, api, toast, esc, dialog }); }
    catch (e) { console.error('[wa-accounts]', e); }
  }
  await loadChats();

  // live updates
  webES = new EventSource(base + '/stream');
  for (const k of ['WACON', 'WASTAT']) { if (window[k] && window[k].bindStream) { try { window[k].bindStream(webES); } catch (e) { console.error('[' + k + ']', e); } } }
  webES.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data);
    const i = S.chats.findIndex((c) => c.jid === d.jid);
    const prev = i >= 0 ? S.chats[i] : null;
    const chat = { ...d.chat };
    if (prev) { if (!chat.avatar) chat.avatar = prev.avatar; if (!chat.presence || chat.presence.state === 'unknown') { chat.presence = prev.presence; chat._pAt = prev._pAt; } }
    if (chat.presence && !chat._pAt) chat._pAt = Date.now();
    if (d.jid === S.jid) {
      if (!S.msgs.some((m) => m.id === d.entry.id)) S.msgs.push(d.entry);
      paintThread(d.entry.fromMe);
      if (window.WARICH && d.entry.type !== 'reaction') WARICH.noteIncoming(d.entry.fromMe);
      if (!d.entry.fromMe) { chat.unread = 0; api(base + '/read', { method: 'POST', body: { jid: S.jid } }).catch(() => {}); }
    }
    if (i >= 0) S.chats.splice(i, 1);
    if (!S.q) S.chats.unshift(chat);
    paintList();
    notifyNew({ ...d, chat });
  });
  webES.addEventListener('reactions', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.jid !== S.jid) return;
    const m = S.msgs.find((x) => x.id === d.id);
    if (m) { m.reactions = d.reactions; paintThread(false); }
  });
  webES.addEventListener('deleted', (ev) => {
    const d = JSON.parse(ev.data);
    const m = S.msgs.find((x) => x.id === d.id);
    if (m) { m.deleted = true; m.text = ''; if (d.jid === S.jid) paintThread(false); }
  });
  webES.addEventListener('edited', (ev) => {
    const d = JSON.parse(ev.data);
    const m = S.msgs.find((x) => x.id === d.id);
    if (m) { m.text = d.text; m.edited = true; if (d.jid === S.jid) paintThread(false); }
  });
  webES.addEventListener('status', (ev) => {
    const d = JSON.parse(ev.data);
    const m = S.msgs.find((x) => x.id === d.id);
    if (m) { m.status = d.status; if (d.jid === S.jid) paintThread(false); }
  });
  webES.addEventListener('presence', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.group) return;
    let c = S.chats.find((x) => x.jid === d.jid);
    if (!c) { const n = String(d.jid).split('@')[0]; c = S.chats.find((x) => String(x.jid).split('@')[0] === n); }
    if (!c) return;
    c.presence = d.presence; c._pAt = Date.now();
    paintList();
    if (c.jid === S.jid) paintTop();
    if (d.presence && d.presence.state === 'composing' && c.jid !== S.jid) { /* shown in the list as "typing…" */ }
  });
  webES.addEventListener('avatar', (ev) => {
    const d = JSON.parse(ev.data);
    const c = S.chats.find((x) => x.jid === d.jid);
    if (c) { c.avatar = d.url; paintListSoon(); }
  });
  webES.addEventListener('connection', (ev) => {
    const d = JSON.parse(ev.data);
    S.conn = d; if (d.me) S.me = d.me; S.stopped = false;
    paintStatus();
    if (d.state === 'open') loadChats();
  });
  webES.addEventListener('hello', (ev) => {
    const d = JSON.parse(ev.data);
    S.wa = d.wa || null; S.stopped = !d.running;
    api(base + '/info').then((i) => { S.conn = i.conn || S.conn; S.me = i.me || S.me; S.wa = i.wa || S.wa; S.stopped = !i.running; paintStatus(); }).catch(() => {});
    paintStatus();
  });
  webES.addEventListener('bot', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.wa) S.wa = d.wa;
    if (d.type === 'stopped' || d.type === 'crashed') { S.stopped = true; S.conn = null; }
    if (d.type === 'started' || d.type === 'online') S.stopped = false;
    paintStatus();
    if (d.type === 'stopped' || d.type === 'crashed' || d.type === 'logged_out') toast('The bot went offline', 'err');
    if (d.type === 'conflict') toast('WhatsApp session conflict: another device is using this session', 'err');
  });
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
    <div id="mDevices"></div>
    <div class="field"><label>New Session ID <span style="text-transform:none;font-weight:400">(leave blank to keep)</span></label><textarea class="input" id="mSession" placeholder="Leave empty to keep current session"></textarea></div>
    <div class="field">
      <label>Auto-restart</label>
      <select class="input" id="mAuto"><option value="true" ${bot.autoRestart ? 'selected' : ''}>Enabled</option><option value="false" ${!bot.autoRestart ? 'selected' : ''}>Disabled</option></select>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="mSave">Save changes</button>
    </div>`);

  loadDevicesBox('#mDevices', { botId: bot.id, onDone: () => { closeModal(); renderDashboard(); } });

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

/* ---------------------------------------------------------------- developers (public API) */
async function renderDevelopers() {
  const base = location.origin + '/api/v1';
  const code = (txt) => `<pre class="code-block">${esc(txt)}</pre>`;
  const P = '<span class="chip pro">Pass</span>';
  const endpoints = [
    ['GET', '/ping', 'none', 'Health check'],
    ['GET', '/me', 'read', 'Your account, plan limits and the key in use'],
    ['GET', '/billing', 'read', 'Coins, trial and pass status'],
    ['GET', '/usage', 'read', 'Request counts for your keys'],
    ['GET', '/bots', 'read', 'List your bots and your bot limit'],
    ['GET', '/bots/{id}', 'read', 'One bot: status, WhatsApp state, resources'],
    ['GET', '/bots/{id}/logs?limit=200', 'read', 'Recent log lines (max 1000, secrets hidden)'],
    ['GET', '/bots/{id}/uptime', 'read', 'Uptime report. 24 hours free, 30 days with the pass'],
    ['POST', '/bots/{id}/start | stop | restart', 'write ' + P, 'Control a bot (uses coins / trial like the dashboard)'],
    ['POST', '/bots', 'write ' + P, 'Create a bot: {"name", "sessionId"}'],
    ['PATCH', '/bots/{id}', 'write ' + P, 'Rename, change session ID or auto-restart'],
    ['DELETE', '/bots/{id}', 'write ' + P, 'Delete a bot'],
    ['GET | PUT', '/bots/{id}/env', 'read / write ' + P, 'Read or replace custom env vars (PREFIX, OWNER_NUMBER, ...)'],
    ['POST', '/session/pair', 'write ' + P, 'Start WhatsApp pairing: {"phone"}. Returns a pairing code'],
    ['GET | DELETE', '/session/pair/{id}', 'read / write ' + P, 'Poll a pairing job until it returns the session ID, or cancel it'],
    ['GET', '/bots/{id}/logs/stream', 'read ' + P, 'Live logs over Server-Sent Events'],
    ['GET', '/bots/{id}/resources?hours=24', 'read ' + P, 'Hourly memory and CPU averages, up to 7 days'],
    ['GET | POST', '/webhooks', 'read / write ' + P, 'List or create signed event webhooks (secret shown once)'],
    ['DELETE', '/webhooks/{id}', 'write ' + P, 'Delete a webhook'],
    ['POST', '/webhooks/{id}/test | enable | disable', 'write ' + P, 'Send a test event, or pause / resume'],
  ];
  const methodChip = (m) => `<span class="chip ${m.startsWith('GET') && !m.includes('|') ? 'on' : ''}">${m}</span>`;

  const sec = (id, title, body, extra) => `<section class="card dev-sec" id="sec-${id}" style="margin-bottom:18px"><h3>${title}</h3>${body}</section>`;
  const note = (t) => `<p class="pay-note">${t}</p>`;
  const step = (n, t, d) => `<div class="dev-step"><span class="dev-n">${n}</span><div><b>${t}</b><div class="pay-note" style="margin-top:3px">${d}</div></div></div>`;
  const li = (arr) => `<ul class="dev-list">${arr.map((x) => `<li>${x}</li>`).join('')}</ul>`;

  $('#view').innerHTML = `
  <div class="app"><div class="wrap dev-hub">
    <div class="dev-hero">
      <span class="chip on">API v1</span>
      <h1>Ladybug Cloud Developers</h1>
      <p>Build on top of your WhatsApp bots: start and stop them, onboard customers, stream logs and react to events from your own code.</p>
      <div class="dev-powered"><img src="/img/logo.png" alt="" /> <span>APIs powered by <b>Ntandomods Developers</b></span></div>
      <div class="dev-jump">
        <button class="btn btn-sm" data-jump="start">Get started</button>
        <button class="btn btn-sm" data-jump="keys">API keys</button>
        <button class="btn btn-sm" data-jump="guides">Guides</button>
        <button class="btn btn-sm" data-jump="safety">Avoid WhatsApp bans</button>
        <button class="btn btn-sm" data-jump="reference">Reference</button>
        <button class="btn btn-sm" data-jump="faq">FAQ</button>
      </div>
    </div>
    <div id="passCard"></div>

    ${sec('start', 'Get started in 5 minutes', `
      ${step(1, 'Create an account', state.user ? 'You are signed in as <b>' + esc(state.user.username) + '</b>.' : '<a href="#/register">Sign up free</a> or <a href="#/login">log in</a>. Every account can use the free read-only API.')}
      ${step(2, 'Create an API key', 'Use the <b>API keys</b> section below. Copy it straight away, it is shown once. Treat it like a password and never put it in front-end code.')}
      ${step(3, 'Make your first call', 'Send the key as a bearer token. Replace <code>lbk_your_key_here_ntandomods</code> with yours. Every key ends in <code>_ntandomods</code>.')}
      ${code(`curl ${base}/me \\\n  -H "Authorization: Bearer lbk_your_key_here_ntandomods"`)}

    ${sec('commands', 'Custom commands (API Pass)', `
      <p>Create commands your bot answers in WhatsApp, straight from the API. Edits go live in the running bot within a second, no restart.</p>
      ${code(`curl -X POST ${base}/bots/BOT_ID/commands \\\n  -H "Authorization: Bearer lbk_your_key_here_ntandomods" -H "Content-Type: application/json" \\\n  -d '{"name":"hello","response":"Hi {name}! You said: {args}","cooldownSeconds":5}'`)}
      <p>Types: <code>text</code>, <code>image</code> (public image URL + caption) and <code>webhook</code> (your HTTPS endpoint gets the message, signed with <code>X-Ladybug-Signature</code>, and its reply is sent back). Placeholders: <code>{name} {sender} {args} {arg1}..{arg9} {group} {botname} {date} {time}</code>. Restrict with <code>access</code> (everyone, admins, owner) and <code>scope</code> (any, group, private). See <code>GET ${base}/commands/meta</code> and the OpenAPI file for everything.</p>
    `)}
      ${code(`# Python\nimport os, requests\nH = {"Authorization": "Bearer " + os.environ["LADYBUG_KEY"]}\nprint(requests.get("${base}/bots", headers=H).json())`)}
      ${code(`// Node 18+\nconst r = await fetch("${base}/bots", { headers: { Authorization: "Bearer " + process.env.LADYBUG_KEY } });\nconsole.log((await r.json()).bots);`)}
      ${step(4, 'Need to control bots? Get the API Pass', 'Free keys are read-only. The <a href="#/pay?buy=api">API Pass</a> unlocks write keys: start/stop/restart, create and delete bots, pairing, env vars, webhooks and live logs.')}
      ${step(5, 'Handle errors and limits', 'Every error is JSON like <code>{"error":"message","code":"rate_limited","requestId":"req_..."}</code> (quote the requestId when you contact support). Add an <code>Idempotency-Key</code> header to POST calls so retries never create duplicates. Back off when you get a <code>429</code> and honour the <code>Retry-After</code> header.')}
    `)}

    ${sec('keys', 'API keys', state.user ? `
        ${note('Keys are shown once, so copy yours straight away. Anyone holding a <b>write</b> key can control your bots, so keep it on your server and rotate it if it leaks.')}
        <div class="alert alert-error" id="keyErr"></div>
        <div id="newKeyBox" class="alert alert-ok"></div>
        <div id="keyList" style="margin:12px 0"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="margin:0;flex:1;min-width:160px"><label>Key name</label><input class="input" id="keyName" maxlength="40" placeholder="e.g. my-script" /></div>
          <div class="field" style="margin:0"><label>Access</label>
            <select class="input" id="keyScope"><option value="read">Read only</option><option value="write">Read + control bots</option></select></div>
          <div class="field" style="margin:0;width:120px"><label>Expires (days) ${P}</label><input class="input" id="keyExp" type="number" min="1" max="365" placeholder="never" /></div>
          <div class="field" style="margin:0;flex:1;min-width:160px"><label>Allowed IPs ${P}</label><input class="input" id="keyIps" placeholder="optional, comma separated" /></div>
          <button class="btn btn-primary" id="keyCreate">Create key</button>
        </div>` : note('<a href="#/login">Log in</a> or <a href="#/register">create a free account</a> to generate an API key.'))}

    ${state.user ? sec('webhooks', `Webhooks ${P}`, `
      ${note('We POST a signed JSON event to your HTTPS endpoint when a bot starts, stops, crashes, comes back online, is logged out of WhatsApp or hits a session conflict. No more polling.')}
      <div class="alert alert-error" id="whErr"></div>
      <div id="newWhBox" class="alert alert-ok"></div>
      <div id="whList" style="margin:12px 0"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="margin:0;flex:1;min-width:240px"><label>Endpoint URL</label><input class="input" id="whUrl" placeholder="https://example.com/ladybug-hook" /></div>
        <div class="field" style="margin:0;flex:1;min-width:200px"><label>Events (blank = all)</label><input class="input" id="whEvents" placeholder="bot.crashed, bot.online" /></div>
        <button class="btn btn-primary" id="whCreate">Add webhook</button>
      </div>`) : ''}

    ${sec('guides', 'Guides', `
      <h4 class="dev-h">Resell bots: onboard a customer end to end ${P}</h4>
      ${note('Pair the customer\'s WhatsApp number, create their bot, and start it, all from your own checkout or admin panel.')}
      ${code(`// Node 18+\nconst H = { Authorization: "Bearer " + process.env.LADYBUG_KEY, "Content-Type": "application/json" };\nconst call = (p, o) => fetch("${base}" + p, { headers: H, ...o }).then((r) => r.json());\n\n// 1. Ask for a pairing code for the customer's number (digits only, with country code)\nconst { job } = await call("/session/pair", { method: "POST", body: JSON.stringify({ phone: "263771234567" }) });\nconsole.log("Customer enters this code in WhatsApp > Linked devices:", job.code);\n\n// 2. Poll until the session is ready (every 3 seconds)\nlet j;\ndo { await new Promise((r) => setTimeout(r, 3000)); j = (await call("/session/pair/" + job.id)).job; }\nwhile (j.status !== "ready" && j.status !== "error");\n\n// 3. Create and start the bot\nconst { bot } = await call("/bots", { method: "POST", body: JSON.stringify({ name: "Customer bot", sessionId: j.sessionId }) });\nawait call("/bots/" + bot.id + "/env", { method: "PUT", body: JSON.stringify({ env: { PREFIX: "." } }) });\nawait call("/bots/" + bot.id + "/start", { method: "POST" });`)}

      <h4 class="dev-h">React to events with webhooks ${P}</h4>
      ${note('Create a webhook above, store its signing secret, then verify every request. Failed deliveries are retried 3 times (now, +5s, +30s). An endpoint that fails 20 deliveries in a row is paused.')}
      ${code(`import crypto from "node:crypto";\n\napp.post("/ladybug-hook", express.raw({ type: "application/json" }), (req, res) => {\n  const ts = req.header("X-Ladybug-Timestamp");\n  const sig = req.header("X-Ladybug-Signature");\n  const expected = "v1=" + crypto.createHmac("sha256", process.env.LADYBUG_WEBHOOK_SECRET)\n    .update(ts + "." + req.body.toString()).digest("hex");\n  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;\n  const ok = fresh && sig.length === expected.length &&\n    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));\n  if (!ok) return res.sendStatus(401);\n  const event = JSON.parse(req.body); // { id, type: "bot.crashed", created, data: { bot, detail } }\n  res.sendStatus(200); // answer fast, work later\n});`)}
      ${note('Events: <code>bot.started</code>, <code>bot.stopped</code>, <code>bot.crashed</code>, <code>bot.online</code>, <code>bot.logged_out</code>, <code>bot.conflict</code>. Use <b>Send test</b> in the list above to try your endpoint.')}

      <h4 class="dev-h">Watch logs live ${P}</h4>
      ${code(`curl -N ${base}/bots/BOT_ID/logs/stream?tail=50 \\\n  -H "Authorization: Bearer lbk_your_key_here_ntandomods"\n\n# you receive:  event: log   data: {"t":..., "stream":"stdout", "line":"..."}\n#               event: bot   data: {"type":"crashed", ...}`)}
      ${note('Session IDs and your custom env values are hidden in log output. Streams last up to 30 minutes, so reconnect when you receive <code>event: end</code>. EventSource cannot send the Authorization header, so use curl or <code>fetch()</code> streaming.')}

      <h4 class="dev-h">Health dashboard in a few lines ${P}</h4>
      ${code(`# memory and CPU per hour for the last 48h\ncurl "${base}/bots/BOT_ID/resources?hours=48" -H "Authorization: Bearer $KEY"\n# 30-day uptime and recent events\ncurl ${base}/bots/BOT_ID/uptime -H "Authorization: Bearer $KEY"`)}
    `)}

    ${sec('safety', 'Avoid WhatsApp bans', `
      <div class="alert show" style="display:block;margin-bottom:12px">Ladybug connects to WhatsApp the same way WhatsApp Web does. That is not an official WhatsApp product, so <b>nobody can guarantee a number will never be restricted</b>. These habits cut the risk a lot. Ladybug Cloud is not affiliated with WhatsApp Inc.</div>
      <h4 class="dev-h">Do</h4>
      ${li([
        '<b>Only message people who opted in</b> or wrote to you first. Unsolicited bulk messages and reports are the number one cause of bans.',
        '<b>Use an aged number</b> with real chat history. Avoid brand-new SIMs for production. Warm a new number up for 1 to 2 weeks with low volume and real conversations.',
        '<b>Pace your messages.</b> Add human-like delays (a few seconds, with some randomness) and never fire bursts. Spread large jobs over hours, not seconds.',
        '<b>Vary content.</b> Do not send the identical text to many people. Personalise, and avoid link-heavy messages.',
        '<b>Pair once and reuse the session.</b> Every new pairing is a new linked device. The API allows 2 pairing requests per number and 5 per account per hour on purpose.',
        '<b>One session, one place.</b> Never run the same session on your laptop and on Ladybug at the same time. The platform rejects duplicate sessions (HTTP 409) and stops conflicting twins.',
        '<b>Fix crashes instead of restarting them.</b> The API enforces a 30 second cooldown and 6 start/restart calls per bot per hour. Listen for <code>bot.crashed</code> and read the logs instead of looping restarts.',
        '<b>Stop on <code>bot.logged_out</code> or <code>bot.conflict</code>.</b> Do not auto re-pair in a loop. Tell the owner and let them relink once.',
        '<b>Honour opt-outs and blocks.</b> If people report or block your number, stop messaging them and slow down.',
        '<b>Tell your customers the risk</b> if you resell bots, and keep their numbers separate from personal ones.',
      ])}
      <h4 class="dev-h">Do not</h4>
      ${li([
        'Message scraped, bought or cold lists, or add people to groups without consent.',
        'Send rapid-fire identical messages, mass forwards or chain messages.',
        'Restart, re-pair or reconnect a bot in a tight loop.',
        'Use a number you cannot afford to lose for anything high-volume.',
      ])}
      ${note('Need real marketing volume? Use the official <a href="https://business.whatsapp.com/products/business-platform" target="_blank" rel="noopener">WhatsApp Business Platform</a> with approved templates. Use Ladybug bots for conversational, opt-in use cases.')}
    `)}

    ${sec('limits', 'Limits and errors', `
      <div style="overflow-x:auto"><table class="dev-table">
        <thead><tr><th>Limit</th><th>Free</th><th>API Pass</th></tr></thead>
        <tbody>
          <tr><td>Requests per minute, per key</td><td>30</td><td>600</td></tr>
          <tr><td>Keys</td><td>1 (read-only)</td><td>5 (expiry + IP allowlist)</td></tr>
          <tr><td>Start / restart per bot</td><td>-</td><td>1 per 30 s, 6 per hour</td></tr>
          <tr><td>Pairing requests</td><td>-</td><td>5 per account and 2 per number, per hour</td></tr>
          <tr><td>Webhooks / open log streams</td><td>-</td><td>5 / 5</td></tr>
        </tbody>
      </table></div>
      ${note('Statuses: <code>401</code> bad, revoked or expired key. <code>402</code> needs the API Pass, or the bot is out of coins. <code>403</code> read-only key or blocked IP. <code>404</code> not your bot. <code>409</code> session already used by another bot. <code>429</code> rate limited or safety guardrail (see <code>Retry-After</code>). Responses carry <code>X-RateLimit-Limit</code> and <code>X-RateLimit-Remaining</code>.')}
    `)}

    ${sec('reference', 'Endpoint reference', `
      <div style="overflow-x:auto"><table class="dev-table">
        <thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>What it does</th></tr></thead>
        <tbody>${endpoints.map((e) => `<tr><td>${methodChip(e[0])}</td><td><code>${esc(e[1])}</code></td><td>${e[2]}</td><td>${esc(e[3])}</td></tr>`).join('')}</tbody>
      </table></div>
      ${note('Base URL: <code>' + esc(base) + '</code>. Machine-readable spec: <a href="/api/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a> (import it into Postman or Insomnia). API keys cannot change passwords, payments or the file drive.')}
    `)}

    ${sec('faq', 'FAQ', `
      <h4 class="dev-h">Who builds and runs the API?</h4>${note('The API is powered by <b>Ntandomods Developers</b>, the team behind Ladybug Cloud.')}
      <h4 class="dev-h">Does a call cost coins?</h4>${note('API calls themselves are free. Starting or restarting a bot spends coins or trial time exactly like pressing Start in the dashboard.')}
      <h4 class="dev-h">What happens when my pass expires?</h4>${note('Read access keeps working. Write calls, webhooks, streams and the extra history return <code>402</code> until you renew. Existing bots, keys and webhook settings are kept.')}
      <h4 class="dev-h">Can I use the API from a browser?</h4>${note('CORS is open, but never put a key in public front-end code. Call the API from your server.')}
      <h4 class="dev-h">Need help or a feature?</h4>${note('Message the admin from <a href="#/support">Contact admin</a>.')}
    `)}

    <div class="dev-foot"><img src="/img/logo.png" alt="" /> <span>Ladybug Cloud API &middot; powered by <b>Ntandomods Developers</b></span></div>
  </div></div>`;

  $$('[data-jump]').forEach((b) => (b.onclick = () => { const el = $('#sec-' + b.dataset.jump); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));

  if (!state.user) return;
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : 'never');
  let info = { limits: { pro: false }, pass: {} };

  const drawKeys = async () => {
    try {
      info = await api('/api/account/keys');
      const L = info.limits;
      const pass = info.pass || {};
      $('#passCard').innerHTML = `
        <div class="card pass-card" style="margin-bottom:18px">
          <div class="card-head"><h3>API Pass ${L.pro ? '<span class="chip on">Active' + (pass.daysLeft ? ' &middot; ' + pass.daysLeft + ' days left' : '') + '</span>' : `<span class="chip">$${pass.priceUsd != null ? pass.priceUsd : 5}/month</span>`}</h3>
            <a class="btn ${L.pro ? '' : 'btn-primary'} btn-sm" href="#/pay?buy=api">${L.pro ? 'Renew' : 'Get the API Pass'}</a></div>
          <p class="pay-note">Free: read-only access, 1 key, 30 requests/min, 24-hour uptime. <b>With the pass:</b> start/stop/restart, create and delete bots, WhatsApp pairing for your customers, env vars over the API, signed webhooks, live log streaming, 30-day uptime and resource history, 5 keys with expiry and IP allowlist, 600 requests/min. Crash alerts, custom bot settings and uptime history are included too.</p>
        </div>`;
      $('#keyList').innerHTML = info.keys.length
        ? info.keys.map((k) => `
          <div class="key-row">
            <div><b>${esc(k.name)}</b> <span class="chip ${k.scope === 'write' ? '' : 'on'}">${k.scope}</span><br>
              <small><code>${esc(k.preview)}</code> &middot; created ${esc(timeAgo(Date.parse(k.createdAt)))} &middot; ${k.lastUsedAt ? 'used ' + esc(timeAgo(Date.parse(k.lastUsedAt))) : 'never used'}
              &middot; expires ${esc(fmtDate(k.expiresAt))}${k.allowedIps.length ? ' &middot; IPs: ' + esc(k.allowedIps.join(', ')) : ''}<br>
              Requests: ${k.usage.today} today &middot; ${k.usage.last7d} in 7 days &middot; ${k.usage.last30d} in 30 days</small></div>
            <button class="btn btn-sm btn-danger" data-revoke="${esc(k.id)}">Revoke</button>
          </div>`).join('')
        : '<p class="pay-note">No keys yet.</p>';
      $$('[data-revoke]').forEach((b) => (b.onclick = async () => {
        if (!confirm('Revoke this key? Anything using it stops working immediately.')) return;
        try { await api('/api/account/keys/' + b.dataset.revoke, { method: 'DELETE' }); toast('Key revoked'); drawKeys(); }
        catch (e) { toast(e.message, 'err'); }
      }));
      ['keyExp', 'keyIps', 'whUrl', 'whEvents', 'whCreate'].forEach((id) => { const el = $('#' + id); if (el) el.disabled = !L.pro; });
    } catch (e) { $('#keyList').textContent = e.message; }
  };

  const drawHooks = async () => {
    try {
      const r = await api('/api/account/webhooks');
      $('#whList').innerHTML = r.webhooks.length
        ? r.webhooks.map((w) => `
          <div class="key-row">
            <div><b style="word-break:break-all">${esc(w.url)}</b> <span class="chip ${w.active ? 'on' : ''}">${w.active ? 'active' : 'paused'}</span><br>
              <small>${esc(w.events.join(', '))}<br>Last delivery: ${w.lastDeliveryAt ? esc(timeAgo(Date.parse(w.lastDeliveryAt))) + ' (' + esc(w.lastStatus) + ')' : 'none yet'}${w.consecutiveFailures ? ' &middot; ' + w.consecutiveFailures + ' failures in a row' : ''}</small></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-sm" data-whtest="${esc(w.id)}">Send test</button>
              <button class="btn btn-sm" data-whtoggle="${esc(w.id)}" data-on="${w.active ? 1 : 0}">${w.active ? 'Pause' : 'Resume'}</button>
              <button class="btn btn-sm btn-danger" data-whdel="${esc(w.id)}">Delete</button>
            </div>
          </div>`).join('')
        : `<p class="pay-note">${r.limits.pro ? 'No webhooks yet.' : 'Webhooks are part of the API Pass.'}</p>`;
      $$('[data-whtest]').forEach((b) => (b.onclick = async () => {
        b.disabled = true;
        try { const t = await api(`/api/account/webhooks/${b.dataset.whtest}/test`, { method: 'POST' }); toast(t.ok ? 'Test delivered (HTTP ' + t.status + ')' : 'Test failed: ' + (t.error || 'no response'), t.ok ? 'ok' : 'err'); drawHooks(); }
        catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
      $$('[data-whtoggle]').forEach((b) => (b.onclick = async () => {
        try { await api(`/api/account/webhooks/${b.dataset.whtoggle}/${b.dataset.on === '1' ? 'disable' : 'enable'}`, { method: 'POST' }); drawHooks(); }
        catch (e) { toast(e.message, 'err'); }
      }));
      $$('[data-whdel]').forEach((b) => (b.onclick = async () => {
        if (!confirm('Delete this webhook?')) return;
        try { await api('/api/account/webhooks/' + b.dataset.whdel, { method: 'DELETE' }); drawHooks(); }
        catch (e) { toast(e.message, 'err'); }
      }));
    } catch (e) { $('#whList').textContent = e.message; }
  };
  drawKeys();
  drawHooks();

  const showSecret = (boxSel, title, secret) => {
    const box = $(boxSel);
    box.classList.add('show');
    box.innerHTML = `<b>${esc(title)}</b><br><code style="word-break:break-all;user-select:all">${esc(secret)}</code> <button class="btn btn-sm" data-copy>Copy</button>`;
    box.querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(secret).then(() => toast('Copied'));
  };

  $('#keyCreate').onclick = async () => {
    const err = $('#keyErr'); err.classList.remove('show');
    try {
      const body = { name: $('#keyName').value, scope: $('#keyScope').value };
      if ($('#keyExp').value) body.expiresInDays = Number($('#keyExp').value);
      if ($('#keyIps').value.trim()) body.allowedIps = $('#keyIps').value;
      const r = await api('/api/account/keys', { method: 'POST', body });
      showSecret('#newKeyBox', 'Copy your new key now. You will not see it again.', r.key);
      ['keyName', 'keyExp', 'keyIps'].forEach((id) => { $('#' + id).value = ''; });
      drawKeys();
    } catch (e) { err.textContent = e.message; err.classList.add('show'); }
  };

  $('#whCreate').onclick = async () => {
    const err = $('#whErr'); err.classList.remove('show');
    try {
      const body = { url: $('#whUrl').value.trim() };
      const evs = $('#whEvents').value.split(/[\s,]+/).filter(Boolean);
      if (evs.length) body.events = evs;
      const r = await api('/api/account/webhooks', { method: 'POST', body });
      showSecret('#newWhBox', 'Signing secret. Copy it now, it is not shown again.', r.secret);
      $('#whUrl').value = ''; $('#whEvents').value = '';
      drawHooks();
    } catch (e) { err.textContent = e.message; err.classList.add('show'); }
  };
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
                  <button class="btn btn-sm" data-ugrant="${u.id}" data-body='{"grantFeature":"api","grantFeatureDays":30}' title="Grant 30 days of the API Pass">+API</button>
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
