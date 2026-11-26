/* Ladybug Cloud — Activity Timeline.
 *
 * One page that answers "what happened on my account?" — bot lifecycle, billing, storage,
 * security and account changes in a single feed. Also drives the bell in the nav bar.
 *
 * Exposed as window.LBACT so app.js can render the route and refresh the bell.
 */
(function () {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var api = function (path, opts) {
    return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) throw new Error(d.error || 'Request failed (' + res.status + ')');
          return d;
        });
      });
  };

  var ICON = { bot: '🤖', billing: '💳', storage: '🗂', security: '🔐', account: '👤' };
  var LABEL = { bot: 'Bots', billing: 'Billing', storage: 'Storage', security: 'Security', account: 'Account' };

  var S = { type: '', q: '', items: [], before: 0, hasMore: false, total: 0, unseen: 0, loading: false, types: [] };

  function hashQuery() {
    var m = /[?&]([^#]*)/.exec(location.hash);
    var out = {};
    if (!m) return out;
    m[1].split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      out[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return out;
  }

  function setHash() {
    var parts = [];
    if (S.type) parts.push('type=' + encodeURIComponent(S.type));
    if (S.q) parts.push('q=' + encodeURIComponent(S.q));
    var next = '#/activity' + (parts.length ? '?' + parts.join('&') : '');
    if (location.hash !== next) history.replaceState(null, '', next);
  }

  function dayLabel(ts) {
    var d = new Date(ts);
    var today = new Date();
    var midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    if (ts >= midnight) return 'Today';
    if (ts >= midnight - 86400000) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function clock(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function rowsHTML(items) {
    var out = '';
    var lastDay = null;
    items.forEach(function (i) {
      var day = dayLabel(i.t);
      if (day !== lastDay) {
        out += '<div class="act-day">' + esc(day) + '</div>';
        lastDay = day;
      }
      var meta = i.meta
        ? Object.keys(i.meta).map(function (k) {
            return '<span class="act-tag">' + esc(k) + ': ' + esc(i.meta[k]) + '</span>';
          }).join('')
        : '';
      out +=
        '<article class="act-item' + (i.seen ? '' : ' is-new') + '" data-id="' + esc(i.id) + '">' +
          '<span class="act-ic act-ic-' + esc(i.type) + '" aria-hidden="true">' + (ICON[i.type] || '•') + '</span>' +
          '<div class="act-body">' +
            '<div class="act-top"><b>' + esc(i.title) + '</b>' +
              '<time datetime="' + new Date(i.t).toISOString() + '" title="' + esc(new Date(i.t).toLocaleString()) + '">' + esc(clock(i.t)) + '</time>' +
            '</div>' +
            (i.detail ? '<p>' + esc(i.detail) + '</p>' : '') +
            '<div class="act-meta"><span class="act-kind">' + esc(LABEL[i.type] || i.type) + '</span>' + meta +
              (i.botId ? '<a class="act-tag act-link" href="#/web?bot=' + encodeURIComponent(i.botId) + '">open bot →</a>' : '') +
            '</div>' +
          '</div>' +
        '</article>';
    });
    return out;
  }

  function chipsHTML(types) {
    var all = [{ id: '', label: 'Everything' }].concat(types || []);
    return all.map(function (t) {
      return '<button type="button" class="act-chip' + (S.type === t.id ? ' on' : '') + '" data-type="' + esc(t.id) + '">' +
        (t.id ? (ICON[t.id] || '') + ' ' : '') + esc(t.label) + '</button>';
    }).join('');
  }

  function paint() {
    var view = document.getElementById('view');
    if (!view) return;
    var list = S.items.length
      ? rowsHTML(S.items)
      : '<div class="empty"><h3>Nothing here yet</h3><p>' +
        (S.q || S.type ? 'No activity matches that filter.' : 'Start a bot, upload a file or change a setting and it will show up here.') +
        '</p></div>';
    var csvQ = [S.type ? 'type=' + encodeURIComponent(S.type) : '', S.q ? 'q=' + encodeURIComponent(S.q) : ''].filter(Boolean).join('&');

    view.innerHTML =
      '<div class="app"><div class="wrap">' +
        '<div class="app-head"><div><h1>Activity</h1>' +
          '<p>Everything that happened on your account — bots, billing, storage and security.</p></div>' +
          '<div class="app-head-actions">' +
            '<button class="btn btn-sm" id="actMark">Mark all read</button>' +
            '<a class="btn btn-sm" id="actCsv" href="/api/activity/export.csv' + (csvQ ? '?' + csvQ : '') + '">Export CSV</a>' +
          '</div>' +
        '</div>' +
        '<div class="stats-row">' +
          '<div class="stat"><div class="k">Entries</div><div class="v">' + S.total + '</div></div>' +
          '<div class="stat"><div class="k">Unread</div><div class="v">' + S.unseen + '</div></div>' +
          '<div class="stat"><div class="k">Showing</div><div class="v">' + S.items.length + '</div></div>' +
        '</div>' +
        '<div class="act-bar">' +
          '<div class="act-chips" id="actChips">' + chipsHTML(S.types) + '</div>' +
          '<div class="act-search"><input type="search" id="actQ" placeholder="Search activity…" value="' + esc(S.q) + '" autocomplete="off"></div>' +
        '</div>' +
        '<div class="act-list" id="actList">' + list + '</div>' +
        (S.hasMore ? '<div class="act-more"><button class="btn" id="actMore">Load older</button></div>' : '') +
      '</div></div>';

    var chips = document.getElementById('actChips');
    if (chips) chips.onclick = function (e) {
      var b = e.target.closest('[data-type]');
      if (!b) return;
      S.type = b.getAttribute('data-type');
      S.items = []; S.before = 0; S.hasMore = false;
      setHash();
      load(true);
    };
    var q = document.getElementById('actQ');
    if (q) {
      var timer = null;
      q.oninput = function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          S.q = q.value.trim();
          S.items = []; S.before = 0; S.hasMore = false;
          setHash();
          load(true);
        }, 260);
      };
    }
    var more = document.getElementById('actMore');
    if (more) more.onclick = function () { load(false); };
    var mark = document.getElementById('actMark');
    if (mark) mark.onclick = function () {
      api('/api/activity/seen', { method: 'POST', body: JSON.stringify({}) })
        .then(function (r) {
          S.unseen = r.unseen || 0;
          S.items.forEach(function (i) { i.seen = true; });
          paint();
          refreshBell();
        })
        .catch(function (e) { alert(e.message); });
    };
  }

  function load(reset) {
    if (S.loading) return;
    S.loading = true;
    var qs = ['limit=40'];
    if (S.type) qs.push('type=' + encodeURIComponent(S.type));
    if (S.q) qs.push('q=' + encodeURIComponent(S.q));
    if (!reset && S.before) qs.push('before=' + S.before);
    api('/api/activity?' + qs.join('&'))
      .then(function (r) {
        S.types = r.types || S.types;
        S.total = r.total || 0;
        S.unseen = r.unseen || 0;
        S.hasMore = !!r.hasMore;
        S.before = r.nextBefore || 0;
        S.items = reset ? r.items : S.items.concat(r.items);
        S.loading = false;
        paint();
      })
      .catch(function (e) {
        S.loading = false;
        var view = document.getElementById('view');
        if (view) view.innerHTML = '<div class="app"><div class="wrap"><div class="alert alert-error show">' + esc(e.message) + '</div></div></div>';
      });
  }

  function refreshBell() {
    var n = document.getElementById('navActN');
    if (!n) return;
    api('/api/activity?limit=1')
      .then(function (r) {
        var u = r.unseen || 0;
        n.textContent = u > 99 ? '99+' : u;
        n.style.display = u ? '' : 'none';
        var bell = document.getElementById('navActBell');
        if (bell) bell.classList.toggle('has-new', !!u);
      })
      .catch(function () {});
  }

  function render() {
    var h = hashQuery();
    S.type = h.type || '';
    S.q = h.q || '';
    S.items = []; S.before = 0; S.hasMore = false;
    var view = document.getElementById('view');
    if (view) view.innerHTML = '<div class="app"><div class="wrap"><div class="empty">Loading activity…</div></div></div>';
    load(true);
  }

  window.LBACT = { render: render, refreshBell: refreshBell, open: function () { location.hash = '#/activity'; } };
})();
