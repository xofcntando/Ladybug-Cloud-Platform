/* Ladybug Cloud — Command Palette.
 *
 * Ctrl/⌘ + K opens a jump box over any page. It finds pages and actions instantly, and asks
 * the server for bots, drive files and past activity as you type. Everything is keyboard
 * driven: type, arrow to a result, Enter to go.
 *
 * Exposed as window.LBPAL (open/close/toggle) so the nav can offer a button too.
 */
(function () {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  var MOD = isMac ? '⌘' : 'Ctrl';

  var PAGES = [
    { label: 'Dashboard', sub: 'Your bots and wallet', href: '#/dashboard', icon: '🏠', keys: 'home bots wallet' },
    { label: 'WhatsApp console', sub: 'Chats, groups, status', href: '#/web', icon: '💬', keys: 'whatsapp web chat messages' },
    { label: 'Storage', sub: 'Your drive and uploads', href: '#/storage', icon: '🗂', keys: 'drive files upload' },
    { label: 'Activity', sub: 'Audit trail and notifications', href: '#/activity', icon: '🔔', keys: 'history log events audit' },
    { label: 'Plan & usage', sub: 'Your plan, meters and invoices', href: '#/plans', icon: '\ud83d\udcca', keys: 'plan usage limits invoices receipts billing upgrade' },
    { label: 'Pay', sub: 'Coins, subscription, ZiG prices', href: '#/pay', icon: '💳', keys: 'billing payment coins subscribe' },
    { label: 'Settings', sub: 'Profile, password, sessions', href: '#/settings', icon: '⚙️', keys: 'account password security sessions' },
    { label: 'Developers', sub: 'API keys and webhooks', href: '#/developers', icon: '🧩', keys: 'api key webhook docs' },
    { label: 'Status', sub: 'Platform and bot uptime', href: '#/status', icon: '📈', keys: 'uptime health monitoring' },
    { label: 'Contact admin', sub: 'Messages and support', href: '#/support', icon: '✉️', keys: 'support help message admin' },
    { label: 'Terms', sub: 'Terms of service', href: '#/terms', icon: '📄', keys: 'legal policy' },
    { label: 'Pricing', sub: 'Plans and what you get', href: '#/pricing', icon: '🏷️', keys: 'plans cost price' },
  ];

  var ACTIONS = [
    {
      label: 'Claim daily coins',
      sub: 'Collect your free coins now',
      icon: '🪙',
      keys: 'claim free coins daily reward',
      run: function () {
        return fetch('/api/coins/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (res) {
            if (typeof toast === 'function') toast(res.ok ? 'Coins claimed' : (res.d.error || 'Could not claim'), res.ok ? 'ok' : 'err');
            if (res.ok) setTimeout(function () { location.reload(); }, 700);
          });
      },
    },
    {
      label: 'Upload a file',
      sub: 'Open the drive to add files',
      icon: '⬆️',
      keys: 'upload file drive add',
      run: function () { location.hash = '#/storage'; },
    },
    {
      label: 'Create a bot',
      sub: 'Add another WhatsApp bot',
      icon: '➕',
      keys: 'new bot create add number',
      run: function () { location.hash = '#/dashboard'; },
    },
    {
      label: 'Mark activity as read',
      sub: 'Clear the notification bell',
      icon: '✅',
      keys: 'read clear notifications bell',
      run: function () {
        return fetch('/api/activity/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: '{}' })
          .then(function () {
            if (window.LBACT) window.LBACT.refreshBell();
            if (typeof toast === 'function') toast('Activity marked as read');
          });
      },
    },
    {
      label: 'Log out',
      sub: 'End this session',
      icon: '🚪',
      keys: 'sign out logout exit',
      run: function () {
        return fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' })
          .then(function () { location.hash = '#/'; });
      },
    },
  ];

  var items = [];
  var active = 0;
  var overlay = null;
  var input = null;
  var listEl = null;
  var searchSeq = 0;
  var searchTimer = null;

  function loggedIn() {
    return typeof state !== 'undefined' && state && state.user;
  }

  function score(hay, needle) {
    var h = String(hay || '').toLowerCase();
    var n = needle.toLowerCase();
    if (!n) return 1;
    if (h === n) return 100;
    if (h.indexOf(n) === 0) return 80;
    var at = h.indexOf(n);
    if (at < 0) return 0;
    return /[\s\-_/.]/.test(h[at - 1]) ? 60 : 30;
  }

  function commands(q) {
    var out = [];
    var pool = [];
    PAGES.forEach(function (p) { pool.push({ group: 'Go to', icon: p.icon, label: p.label, sub: p.sub, href: p.href, hay: p.label + ' ' + p.sub + ' ' + p.keys }); });
    if (loggedIn()) {
      ACTIONS.forEach(function (a) { pool.push({ group: 'Actions', icon: a.icon, label: a.label, sub: a.sub, run: a.run, hay: a.label + ' ' + a.sub + ' ' + a.keys }); });
    }
    for (var i = 0; i < pool.length; i++) {
      var s = Math.max(score(pool[i].label, q), score(pool[i].hay, q) * 0.8);
      if (s) out.push(Object.assign({ score: s }, pool[i]));
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, q ? 8 : 7);
  }

  function paint() {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<div class="pal-empty">No matches. Try a bot name, a file, or “storage”.</div>';
      return;
    }
    var html = '';
    var lastGroup = null;
    items.forEach(function (it, idx) {
      if (it.group !== lastGroup) {
        html += '<div class="pal-group">' + esc(it.group) + '</div>';
        lastGroup = it.group;
      }
      html += '<button type="button" role="option" aria-selected="' + (idx === active) + '" class="pal-item' + (idx === active ? ' on' : '') + '" data-i="' + idx + '">' +
        '<span class="pal-ic">' + esc(it.icon || '•') + '</span>' +
        '<span class="pal-txt"><b>' + esc(it.label) + '</b>' + (it.sub ? '<small>' + esc(it.sub) + '</small>' : '') + '</span>' +
        (it.kind ? '<span class="pal-kind">' + esc(it.kind) + '</span>' : '') +
      '</button>';
    });
    listEl.innerHTML = html;
    var on = listEl.querySelector('.pal-item.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function setItems(next) {
    items = next;
    if (active >= items.length) active = Math.max(0, items.length - 1);
    paint();
  }

  function search(q) {
    if (!loggedIn() || q.length < 2) return;
    var seq = ++searchSeq;
    fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (seq !== searchSeq) return; // a newer keystroke already won
        var extra = (d.results || []).map(function (r) {
          return {
            group: r.kind === 'bot' ? 'Bots' : r.kind === 'file' ? 'Drive' : 'Activity',
            icon: r.kind === 'bot' ? '🤖' : r.kind === 'file' ? '📄' : '🕘',
            label: r.title,
            sub: r.sub,
            href: r.href,
            kind: r.kind,
          };
        });
        setItems(commands(q).concat(extra));
      })
      .catch(function () {});
  }

  function runItem(it) {
    if (!it) return;
    close();
    if (typeof it.run === 'function') {
      try { it.run(); } catch (e) { /* ignore */ }
      return;
    }
    if (it.href) location.hash = it.href;
  }

  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); return; }
    if (e.key === 'Enter') { e.preventDefault(); runItem(items[active]); return; }
  }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'pal-overlay';
    overlay.id = 'palOverlay';
    overlay.innerHTML =
      '<div class="pal" role="dialog" aria-modal="true" aria-label="Command palette">' +
        '<div class="pal-in">' +
          '<span class="pal-ic" aria-hidden="true">⌘</span>' +
          '<input id="palInput" type="text" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list" ' +
            'placeholder="Search pages, bots, files and activity…" autocomplete="off" spellcheck="false">' +
          '<kbd>esc</kbd>' +
        '</div>' +
        '<div class="pal-list" id="palList" role="listbox"></div>' +
        '<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span class="pal-hint">' + MOD + ' + K</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    input = overlay.querySelector('#palInput');
    listEl = overlay.querySelector('#palList');

    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', function () {
      var q = input.value.trim();
      active = 0;
      setItems(commands(q));
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { search(q); }, 180);
    });
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-i]');
      if (!b) return;
      runItem(items[Number(b.getAttribute('data-i'))]);
    });
    listEl.addEventListener('mousemove', function (e) {
      var b = e.target.closest('[data-i]');
      if (!b) return;
      var i = Number(b.getAttribute('data-i'));
      if (i !== active) { active = i; paint(); }
    });
  }

  function open(prefill) {
    if (!overlay) build();
    overlay.classList.add('show');
    document.body.classList.add('pal-open');
    input.value = prefill || '';
    active = 0;
    setItems(commands(input.value.trim()));
    if (prefill) search(prefill.trim());
    setTimeout(function () { input.focus(); }, 20);
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('show');
    document.body.classList.remove('pal-open');
    searchSeq++;
  }

  function toggle() {
    if (overlay && overlay.classList.contains('show')) close();
    else open();
  }

  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); toggle(); return; }
    // "/" focuses the palette when not already typing in a field.
    if (k === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (!typing && !(overlay && overlay.classList.contains('show'))) { e.preventDefault(); open(); }
    }
  });

  window.LBPAL = { open: open, close: close, toggle: toggle };
})();
