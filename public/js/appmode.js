/* Ladybug Cloud — installed-app mode.
 *
 * When the site runs as an installed app (standalone display mode) it gets a different
 * shell from the website: a compact app bar, a bottom tab bar, and an "All features"
 * sheet that lists every page and every WhatsApp console tool in one place. The website
 * keeps its normal top navigation.
 *
 * Why a JS switch instead of only a CSS media query: browsers disagree about reporting
 * `display-mode: standalone` (iOS reports navigator.standalone, some Android webviews
 * report nothing), and a media query cannot build the extra chrome anyway. The CSS also
 * honours the media query so the look is right even before this file runs.
 *
 * Exposed as window.LBAPP = { on, open, close, refresh }.
 */
(function () {
  var FEATURE_KEY = 'lb_app_mode';

  function detect() {
    try {
      if (/[?&]app=1\b/.test(location.search)) return true;
      if (/[?&]app=0\b/.test(location.search)) return false;
      if (localStorage.getItem(FEATURE_KEY) === '1') return true;
    } catch (e) { /* private mode */ }
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (e) { /* old browser */ }
    return navigator.standalone === true;
  }

  var ON = detect();
  if (!ON) {
    window.LBAPP = { on: false, open: function () {}, close: function () {}, refresh: function () {} };
    return;
  }
  document.documentElement.setAttribute('data-app', '1');

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var TITLES = {    '/': 'Ladybug Cloud',
    '/pricing': 'Pricing',
    '/login': 'Sign in',
    '/register': 'Create account',
    '/dashboard': 'My bots',
    '/activity': 'Activity',
    '/storage': 'Storage',
    '/pay': 'Pay',
    '/settings': 'Settings',
    '/developers': 'Developers',
    '/status': 'Status',
    '/support': 'Contact admin',
    '/terms': 'Terms',
    '/web': 'WhatsApp',
    '/admin': 'Admin',
  };

  /* Crisp line icons for the chrome; the sheet tiles keep their colourful emoji. */
  var svg = function (d, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 20) + '" height="' + (size || 20) +
      '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  };
  var ICON = {
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', 19),
    bell: svg('<path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>', 19),
    menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>', 20),
    home: svg('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>'),
    chat: svg('<path d="M20 4H4a1 1 0 0 0-1 1v15l4-3h13a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/><path d="M7 9h10M7 13h6"/>'),
    drive: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    grid: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'),
  };

  /* Every page in the app, grouped for the sheet. */
  var PAGES = [
    { group: 'Workspace', items: [
      { icon: '🏠', label: 'My bots', href: '#/dashboard', note: 'Start, stop and watch your bots' },
      { icon: '💬', label: 'WhatsApp', href: '#/web', note: 'Chats, groups and status' },
      { icon: '🗂', label: 'Storage', href: '#/storage', note: 'Your drive and uploads' },
      { icon: '🔔', label: 'Activity', href: '#/activity', note: 'Everything that happened' },
    ] },
    { group: 'Account', items: [
      { icon: '💳', label: 'Pay', href: '#/pay', note: 'Coins, plan and ZiG prices' },
      { icon: '⚙️', label: 'Settings', href: '#/settings', note: 'Profile, password, sessions' },
      { icon: '🧩', label: 'Developers', href: '#/developers', note: 'API keys and webhooks' },
      { icon: '📈', label: 'Status', href: '#/status', note: 'Platform and bot uptime' },
      { icon: '✉️', label: 'Contact admin', href: '#/support', note: 'Messages and support' },
      { icon: '📄', label: 'Terms', href: '#/terms', note: 'Terms of service' },
    ] },
  ];

  /* Every WhatsApp console tool, each deep-linked so the installed app can reach it in one tap. */
  var TOOLS = [
    { icon: '📝', label: 'Chat Digest', tool: 'digest', note: 'Summarise a conversation' },
    { icon: '🗒', label: 'Notes & follow-ups', tool: 'notes', note: 'Keep track of promises' },
    { icon: '🌍', label: 'Auto-translate', tool: 'translate', note: 'Read chats in your language' },
    { icon: '📡', label: 'Response Radar', tool: 'radar', note: 'Who is waiting on a reply' },
    { icon: '🗑', label: 'Deleted messages', tool: 'deleted', note: 'What was removed' },
    { icon: '📊', label: 'Analytics', tool: 'analytics', note: 'Who talks the most' },
    { icon: '📣', label: 'Broadcast', tool: 'broadcast', note: 'Message many chats at once' },
    { icon: '🏷', label: 'Labels', tool: 'labels', note: 'Organise chats' },
    { icon: '🖼', label: 'Gallery', tool: 'gallery', note: 'Media in a chat' },
    { icon: '👥', label: 'Contacts', tool: 'contacts', note: 'Find or add someone' },
    { icon: '➕', label: 'New group', tool: 'groups', note: 'Create a group chat' },
    { icon: '⭕', label: 'Status & stories', tool: 'stories', note: 'Post and view status' },
    { icon: '📢', label: 'Channels', tool: 'channels', note: 'Follow channels' },
    { icon: '🤖', label: 'Automation', tool: 'auto', note: 'Auto-replies and rules' },
    { icon: '🎨', label: 'Appearance', tool: 'appearance', note: 'Theme and wallpaper' },
    { icon: '🔗', label: 'Linked numbers', tool: 'accounts', note: 'Manage WhatsApp sessions' },
  ];

  var bar = null;
  var tabs = null;
  var sheet = null;
  var titleEl = null;
  var botsCache = null;

  function page() {
    return (document.body && document.body.dataset && document.body.dataset.page) || '/';
  }

  function loggedIn() {
    return typeof state !== 'undefined' && state && state.user;
  }

  function firstBot() {
    if (botsCache) return Promise.resolve(botsCache);
    return fetch('/api/bots', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { botsCache = (d.bots || [])[0] || null; return botsCache; })
      .catch(function () { return null; });
  }

  function go(href) {
    if (href === '#/web') {
      firstBot().then(function (b) {
        location.hash = b ? '#/web?bot=' + encodeURIComponent(b.id) : '#/dashboard';
      });
      return;
    }
    location.hash = href;
  }

  function buildBar() {
    bar = document.createElement('header');
    bar.className = 'appbar';
    bar.id = 'appBar';
    bar.innerHTML =
      '<a class="appbar-brand" href="#/dashboard" aria-label="Ladybug Cloud home">' +
        '<img src="/img/logo.png" alt="" width="26" height="26">' +
        '<span id="appBarTitle">Ladybug Cloud</span>' +
      '</a>' +
      '<div class="appbar-actions">' +
        '<button type="button" class="appbar-btn" id="appSearch" aria-label="Search everything">' + ICON.search + '</button>' +
        '<a class="appbar-btn" href="#/activity" id="appBell" aria-label="Activity">' + ICON.bell + '<i class="appbar-dot" id="appBellN" hidden></i></a>' +
        '<button type="button" class="appbar-btn" id="appMenu" aria-label="All features">' + ICON.menu + '</button>' +
      '</div>';
    document.body.insertBefore(bar, document.body.firstChild);
    titleEl = bar.querySelector('#appBarTitle');
    bar.querySelector('#appSearch').onclick = function () { if (window.LBPAL) window.LBPAL.open(); };
    bar.querySelector('#appMenu').onclick = function () { open(); };
  }

  function buildTabs() {
    tabs = document.createElement('nav');
    tabs.className = 'apptabs';
    tabs.id = 'appTabs';
    tabs.setAttribute('aria-label', 'Main');
    tabs.innerHTML =
      '<button type="button" class="apptab" data-tab="home"><i>' + ICON.home + '</i><span>Home</span></button>' +
      '<button type="button" class="apptab" data-tab="chats"><i>' + ICON.chat + '</i><span>Chats</span></button>' +
      '<button type="button" class="apptab" data-tab="drive"><i>' + ICON.drive + '</i><span>Drive</span></button>' +
      '<button type="button" class="apptab" data-tab="activity"><i>' + ICON.bell + '</i><span>Activity</span></button>' +
      '<button type="button" class="apptab" data-tab="more"><i>' + ICON.grid + '</i><span>All</span></button>';
    document.body.appendChild(tabs);
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (!b) return;
      var t = b.getAttribute('data-tab');
      if (t === 'home') go('#/dashboard');
      else if (t === 'chats') go('#/web');
      else if (t === 'drive') go('#/storage');
      else if (t === 'activity') go('#/activity');
      else open();
    });
  }

  function tiles(group) {
    return (
      '<section class="appsheet-group">' +
        '<h3>' + esc(group.group) + '</h3>' +
        '<div class="appsheet-grid">' +
          group.items.map(function (it) {
            return '<button type="button" class="apptile" data-href="' + esc(it.href) + '">' +
              '<i>' + esc(it.icon) + '</i><b>' + esc(it.label) + '</b><small>' + esc(it.note) + '</small>' +
            '</button>';
          }).join('') +
        '</div>' +
      '</section>'
    );
  }

  function buildSheet() {
    sheet = document.createElement('div');
    sheet.className = 'appsheet';
    sheet.id = 'appSheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'All features');
    sheet.innerHTML =
      '<div class="appsheet-card">' +
        '<div class="appsheet-head">' +
          '<div><b>All features</b><small>Everything Ladybug Cloud can do, one tap away.</small></div>' +
          '<button type="button" class="appsheet-x" id="appSheetX" aria-label="Close">✕</button>' +
        '</div>' +
        '<div class="appsheet-body">' +
          PAGES.map(tiles).join('') +
          '<section class="appsheet-group">' +
            '<h3>WhatsApp console tools</h3>' +
            '<p class="appsheet-hint">Opens your bot\'s console with the tool already running.</p>' +
            '<div class="appsheet-grid">' +
              TOOLS.map(function (t) {
                return '<button type="button" class="apptile" data-tool="' + esc(t.tool) + '">' +
                  '<i>' + esc(t.icon) + '</i><b>' + esc(t.label) + '</b><small>' + esc(t.note) + '</small>' +
                '</button>';
              }).join('') +
            '</div>' +
          '</section>' +
          '<section class="appsheet-group">' +
            '<h3>This device</h3>' +
            '<div class="appsheet-grid">' +
              '<button type="button" class="apptile" data-act="search"><i>🔍</i><b>Search</b><small>Bots, files and activity</small></button>' +
              '<button type="button" class="apptile" data-act="refresh"><i>🔄</i><b>Check for update</b><small>Reload the newest build</small></button>' +
              '<button type="button" class="apptile" data-act="logout"><i>🚪</i><b>Log out</b><small>End this session</small></button>' +
            '</div>' +
          '</section>' +
        '</div>' +
      '</div>';
    document.body.appendChild(sheet);
    sheet.querySelector('#appSheetX').onclick = close;
    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) close();
      var t = e.target.closest('[data-href]');
      if (t) { close(); go(t.getAttribute('data-href')); return; }
      var tool = e.target.closest('[data-tool]');
      if (tool) { close(); openTool(tool.getAttribute('data-tool')); return; }
      var act = e.target.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        close();
        if (a === 'search') { if (window.LBPAL) window.LBPAL.open(); }
        else if (a === 'refresh') {
          if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(function (r) { return r && r.update(); }).catch(function () {});
          setTimeout(function () { location.reload(); }, 400);
        } else if (a === 'logout') {
          fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' })
            .then(function () { location.hash = '#/'; });
        }
      }
    });
  }

  function openTool(tool) {
    firstBot().then(function (b) {
      if (!b) { location.hash = '#/dashboard'; return; }
      location.hash = '#/web?bot=' + encodeURIComponent(b.id) + '&tool=' + encodeURIComponent(tool);
    });
  }

  function open() {
    if (!sheet) buildSheet();
    sheet.classList.add('show');
    document.body.classList.add('appsheet-open');
  }

  function close() {
    if (!sheet) return;
    sheet.classList.remove('show');
    document.body.classList.remove('appsheet-open');
  }

  function refresh() {
    if (!ON) return;
    var p = page();
    var authed = loggedIn();
    // The console is full-bleed; the app bar and tab bar step aside there.
    var chrome = authed && p !== '/web';
    document.documentElement.setAttribute('data-app-chrome', chrome ? '1' : '0');
    if (bar) bar.hidden = !chrome;
    if (tabs) tabs.hidden = !chrome;
    if (titleEl) titleEl.textContent = TITLES[p] || 'Ladybug Cloud';
    if (tabs) {
      var map = { '/dashboard': 'home', '/web': 'chats', '/storage': 'drive', '/activity': 'activity' };
      var want = map[p] || '';
      tabs.querySelectorAll('[data-tab]').forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-tab') === want);
      });
    }
    var n = document.getElementById('appBellN');
    var src = document.getElementById('navActN');
    if (n && src) {
      var u = src.style.display === 'none' ? 0 : parseInt(src.textContent, 10) || 0;
      n.hidden = !u;
    }
  }

  function init() {
    buildBar();
    buildTabs();
    refresh();
    // navigate() sets body.dataset.page on every route change; mirror it into the app chrome.
    new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ['data-page'] });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
    window.addEventListener('hashchange', close);
  }

  window.LBAPP = { on: true, open: open, close: close, refresh: refresh, tools: TOOLS, pages: PAGES };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
