/* Ladybug Cloud — saved replies in the WhatsApp console.
 *
 * One tap opens a searchable list of your saved replies. Picking one fills the
 * composer with the reply already personalised ({name}, {group}, {me} …) so an
 * owner answering the same five questions all day can stop retyping them.
 *
 * Replies belong to the account, not the number, so they follow you between bots.
 * Exposed as window.LBSNIPS = { attach, open, manage, insert }.
 */
(function () {
  'use strict';

  var esc = window.esc || function (s) { return String(s == null ? '' : s); };
  var api = window.api;
  var cache = null;
  var panel = null;
  var query = '';

  function toastMsg(m, k) { if (typeof window.toast === 'function') window.toast(m, k); }

  /* ------------------------------------------------------------ context */
  // Fill the placeholders the server knows about, from what is on screen.
  function context() {
    var top = document.querySelector('#waTop');
    var name = '';
    if (top) {
      var t = top.querySelector('.wa-title, .wa-name, h2, b');
      name = (t ? t.textContent : top.textContent) || '';
    }
    name = name.trim().split('\n')[0].slice(0, 60);
    return {
      name: name,
      first: name.split(/\s+/)[0] || '',
      group: /group/i.test(document.querySelector('#waInfo') ? document.querySelector('#waInfo').textContent : '') ? name : '',
      bot: (document.title || '').replace(/\s*-\s*by Ntandomods.*$/, '').trim(),
      me: 'me',
    };
  }

  function localRender(text, ctx) {
    return String(text || '').replace(/\{(name|first|group|bot|me|date|time)\}/g, function (m, k) {
      if (k === 'date') return new Date().toLocaleDateString('en-GB');
      if (k === 'time') return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return ctx[k] != null ? ctx[k] : '';
    });
  }

  /* ------------------------------------------------------------ insert */
  async function insert(s) {
    var ta = document.getElementById('waText');
    if (!ta) return;
    var text = s.body;
    try {
      var r = await api('/api/snippets/' + encodeURIComponent(s.id) + '/use', { method: 'POST', body: { context: context() } });
      if (r && r.text) text = r.text;
    } catch (e) {
      text = localRender(s.body, context());
    }
    ta.value = text;
    ta.focus();
    ta.dispatchEvent(new Event('input'));
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    hide();
    toastMsg('Reply inserted', 'ok');
  }

  /* ------------------------------------------------------------ panel */
  function hide() {
    if (panel) panel.hidden = true;
  }

  function rows(list) {
    if (!list.length) {
      return '<div class="snip-empty">' +
        (query ? 'No reply matches “' + esc(query) + '”.' : 'No saved replies yet.') +
        '<button class="btn btn-sm" data-snip-manage="1">Create one</button></div>';
    }
    return list.map(function (s) {
      return '<button type="button" class="snip-row" data-snip="' + esc(s.id) + '">' +
        '<span class="snip-key">/' + esc(s.shortcut) + '</span>' +
        '<span class="snip-main"><b>' + esc(s.title) + '</b>' +
          '<span class="snip-body">' + esc(String(s.body).replace(/\s+/g, ' ').slice(0, 110)) + '</span></span>' +
        (s.uses ? '<span class="snip-uses">' + s.uses + '×</span>' : '') +
      '</button>';
    }).join('');
  }

  function paint() {
    if (!panel) return;
    var list = (cache && cache.snippets) || [];
    if (query) {
      var q = query.toLowerCase();
      list = list.filter(function (s) {
        return (s.title + ' ' + s.shortcut + ' ' + s.body + ' ' + (s.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0;
      });
    }
    panel.innerHTML = '' +
      '<div class="snip-head"><input id="snipQ" class="input" placeholder="Search saved replies" value="' + esc(query) + '" autocomplete="off" />' +
        '<button class="btn btn-sm" data-snip-manage="1" title="Create, edit and delete replies">Manage</button></div>' +
      '<div class="snip-list">' + rows(list) + '</div>' +
      '<div class="snip-foot">' + (cache ? (cache.total + ' of ' + cache.max + ' replies') : '') + '</div>';

    var q = panel.querySelector('#snipQ');
    q.oninput = function () {
      query = q.value;
      paint();
      var n = panel.querySelector('#snipQ');
      if (n) { n.focus(); n.selectionStart = n.selectionEnd = n.value.length; }
    };
    panel.querySelectorAll('[data-snip]').forEach(function (b) {
      b.onclick = function () {
        var s = (cache.snippets || []).find(function (x) { return x.id === b.getAttribute('data-snip'); });
        if (s) insert(s);
      };
    });
    panel.querySelectorAll('[data-snip-manage]').forEach(function (b) { b.onclick = manage; });
  }

  async function load() {
    try {
      cache = await api('/api/snippets' + (query ? '?q=' + encodeURIComponent(query) : ''));
    } catch (e) {
      cache = { snippets: [], total: 0, max: 0 };
    }
    paint();
  }

  async function toggle() {
    if (!panel) return;
    if (!panel.hidden) return hide();
    panel.hidden = false;
    panel.innerHTML = '<div class="snip-empty">Loading…</div>';
    await load();
  }

  /* ------------------------------------------------------------ manage modal */
  function form(s) {
    s = s || { shortcut: '', title: '', body: '', tags: [] };
    var vars = (cache && cache.variables) || ['name', 'first', 'group', 'bot', 'me', 'date', 'time'];
    return '' +
      '<div class="snip-form" data-id="' + esc(s.id || '') + '">' +
        '<div class="field"><label>Shortcut</label>' +
          '<input class="input" id="sfKey" value="' + esc(s.shortcut) + '" placeholder="price" maxlength="24" />' +
          '<div class="hint">Type it in the composer as /' + (esc(s.shortcut) || 'price') + ' and it expands. Letters, numbers, - and _.</div></div>' +
        '<div class="field"><label>Title</label>' +
          '<input class="input" id="sfTitle" value="' + esc(s.title) + '" placeholder="Price list" maxlength="80" /></div>' +
        '<div class="field"><label>Reply</label>' +
          '<textarea class="input" id="sfBody" rows="6" maxlength="2000" placeholder="Hi {first}, our plans start at …">' + esc(s.body) + '</textarea>' +
          '<div class="hint">Placeholders: ' + vars.map(function (v) { return '<code>{' + esc(v) + '}</code>'; }).join(' ') + '</div></div>' +
        '<div class="field"><label>Tags</label>' +
          '<input class="input" id="sfTags" value="' + esc((s.tags || []).join(', ')) + '" placeholder="sales, pricing" />' +
          '<div class="hint">Up to 5, comma separated. Used by search.</div></div>' +
        '<div class="snip-form-actions"><button class="btn btn-primary" id="sfSave">Save reply</button>' +
          (s.id ? '<button class="btn btn-danger" id="sfDel">Delete</button>' : '') + '</div>' +
      '</div>';
  }

  function manage() {
    hide();
    var list = (cache && cache.snippets) || [];
    window.openModal('' +
      '<h3 style="margin:0 0 4px">Saved replies</h3>' +
      '<p class="hint" style="margin:0 0 14px">Answers you reuse. Insert them from the composer with the ⚡ button.</p>' +
      '<div class="snip-manage">' +
        '<div class="snip-manage-list">' +
          (list.length ? list.map(function (s) {
            return '<button type="button" class="snip-manage-row" data-edit="' + esc(s.id) + '">' +
              '<span class="snip-key">/' + esc(s.shortcut) + '</span><b>' + esc(s.title) + '</b></button>';
          }).join('') : '<p class="hint">Nothing saved yet — write your first reply on the right.</p>') +
          '<button type="button" class="btn btn-sm" id="snipNew">+ New reply</button>' +
        '</div>' +
        '<div class="snip-manage-edit" id="snipEdit"></div>' +
      '</div>');

    var edit = document.getElementById('snipEdit');
    function show(s) {
      edit.innerHTML = form(s);
      var save = document.getElementById('sfSave');
      save.onclick = async function () {
        var body = {
          shortcut: document.getElementById('sfKey').value,
          title: document.getElementById('sfTitle').value,
          body: document.getElementById('sfBody').value,
          tags: document.getElementById('sfTags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
        };
        save.disabled = true;
        try {
          if (s && s.id) await api('/api/snippets/' + encodeURIComponent(s.id), { method: 'PATCH', body: body });
          else await api('/api/snippets', { method: 'POST', body: body });
          toastMsg('Reply saved', 'ok');
          cache = null;
          await load();
          manage();
        } catch (e) {
          toastMsg(e.message, 'err');
          save.disabled = false;
        }
      };
      var del = document.getElementById('sfDel');
      if (del) del.onclick = async function () {
        if (!confirm('Delete “' + (s.title || s.shortcut) + '”?')) return;
        try {
          await api('/api/snippets/' + encodeURIComponent(s.id), { method: 'DELETE' });
          toastMsg('Reply deleted');
          cache = null;
          await load();
          manage();
        } catch (e) { toastMsg(e.message, 'err'); }
      };
    }
    show(null);

    document.getElementById('snipNew').onclick = function () { show(null); };
    document.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () {
        var s = list.find(function (x) { return x.id === b.getAttribute('data-edit'); });
        if (s) show(s);
      };
    });
  }

  /* ------------------------------------------------------------ attach */
  function attach() {
    var btn = document.getElementById('waSnipBtn');
    panel = document.getElementById('waSnips');
    if (!btn || !panel) return;
    btn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); toggle(); };
    document.addEventListener('click', function (e) {
      if (panel.hidden) return;
      if (e.target.closest('#waSnips') || e.target.closest('#waSnipBtn')) return;
      hide();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) hide();
    });
  }

  window.LBSNIPS = { attach: attach, open: toggle, manage: manage, insert: insert };
})();
