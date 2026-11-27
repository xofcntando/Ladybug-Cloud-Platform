/* Ladybug Cloud — custom command builder.
 *
 * A modal on the dashboard that creates the same commands the public API manages:
 * text replies, image replies and webhooks, with access, scope, aliases and a
 * cooldown. No API key needed — the owner builds them by clicking.
 *
 * Exposed as window.LBCMDS = { open }.
 */
(function () {
  'use strict';

  var esc = window.esc || function (s) { return String(s == null ? '' : s); };
  var api = window.api;
  var state = { bot: null, meta: null, list: [], editing: null };

  function toastMsg(m, k) { if (typeof window.toast === 'function') window.toast(m, k); }

  function bodyFor() {
    var type = document.getElementById('cmType').value;
    var out = {
      name: document.getElementById('cmName').value,
      aliases: document.getElementById('cmAliases').value.split(/[\s,]+/).filter(Boolean),
      type: type,
      description: document.getElementById('cmDesc').value,
      access: document.getElementById('cmAccess').value,
      scope: document.getElementById('cmScope').value,
      cooldownSeconds: Number(document.getElementById('cmCool').value || 0),
      enabled: document.getElementById('cmOn').checked,
    };
    if (type === 'text') out.response = document.getElementById('cmResponse').value;
    if (type === 'image') out.imageUrl = document.getElementById('cmImage').value;
    if (type === 'webhook') {
      out.url = document.getElementById('cmUrl').value;
      out.method = document.getElementById('cmMethod').value;
    }
    return out;
  }

  function form(c) {
    c = c || { name: '', aliases: [], type: 'text', access: 'everyone', scope: 'any', cooldownSeconds: 0, enabled: true, response: '' };
    var m = state.meta || { types: ['text', 'image', 'webhook'], access: ['everyone', 'admins', 'owner'], scope: ['any', 'group', 'private'], placeholders: [] };
    return '' +
      '<div class="cm-form">' +
        '<div class="cm-row">' +
          '<div class="field"><label>Command</label>' +
            '<div class="cm-prefix"><span>!</span><input class="input" id="cmName" value="' + esc(c.name) + '" placeholder="price" maxlength="32" /></div>' +
            '<div class="hint">a-z, 0-9, - and _. Chat members type !price.</div></div>' +
          '<div class="field"><label>Aliases</label>' +
            '<input class="input" id="cmAliases" value="' + esc((c.aliases || []).join(', ')) + '" placeholder="prices, cost" />' +
            '<div class="hint">Optional, up to 5.</div></div>' +
        '</div>' +
        '<div class="cm-row">' +
          '<div class="field"><label>Type</label><select class="input" id="cmType">' +
            m.types.map(function (t) { return '<option value="' + esc(t) + '"' + (c.type === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="field"><label>Who can use it</label><select class="input" id="cmAccess">' +
            m.access.map(function (a) { return '<option value="' + esc(a) + '"' + (c.access === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') +
          '</select></div>' +
          '<div class="field"><label>Where</label><select class="input" id="cmScope">' +
            m.scope.map(function (s) { return '<option value="' + esc(s) + '"' + (c.scope === s ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        '<div class="field"><label>Description</label>' +
          '<input class="input" id="cmDesc" value="' + esc(c.description || '') + '" placeholder="What this command does (shown in the list)" maxlength="120" /></div>' +
        '<div class="field" id="cmTextWrap"><label>Reply</label>' +
          '<textarea class="input" id="cmResponse" rows="5" maxlength="2000" placeholder="Our plans start at $3 a month.">' + esc(c.response || '') + '</textarea>' +
          '<div class="hint">Placeholders: ' + (m.placeholders || []).map(function (p) { return '<code>' + esc(p) + '</code>'; }).join(' ') + '</div></div>' +
        '<div class="field" id="cmImageWrap" hidden><label>Image URL</label>' +
          '<input class="input" id="cmImage" value="' + esc(c.imageUrl || '') + '" placeholder="https://…/price.png" /></div>' +
        '<div class="field" id="cmHookWrap" hidden><label>Webhook URL</label>' +
          '<input class="input" id="cmUrl" value="' + esc(c.url || '') + '" placeholder="https://your-server.com/ladybug" />' +
          '<div class="hint">Must be https. Ladybug sends the message there and replies with whatever your JSON says.</div></div>' +
        '<div class="field" id="cmMethodWrap" hidden><label>Method</label><select class="input" id="cmMethod">' +
          '<option value="POST"' + (c.method !== 'GET' ? ' selected' : '') + '>POST</option>' +
          '<option value="GET"' + (c.method === 'GET' ? ' selected' : '') + '>GET</option></select></div>' +
        '<div class="cm-row">' +
          '<div class="field"><label>Cooldown (seconds)</label>' +
            '<input class="input" id="cmCool" type="number" min="0" max="3600" value="' + (c.cooldownSeconds || 0) + '" />' +
            '<div class="hint">0 means no cooldown. Stops spam in busy groups.</div></div>' +
          '<div class="field"><label>Status</label>' +
            '<label class="cm-switch"><input type="checkbox" id="cmOn"' + (c.enabled !== false ? ' checked' : '') + ' /> Enabled</label></div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" id="cmCancel">Cancel</button>' +
          '<button class="btn btn-primary" id="cmSave">' + (c.id ? 'Save changes' : 'Create command') + '</button></div>' +
      '</div>';
  }

  function syncType() {
    var t = document.getElementById('cmType').value;
    document.getElementById('cmTextWrap').hidden = t !== 'text';
    document.getElementById('cmImageWrap').hidden = t !== 'image';
    document.getElementById('cmHookWrap').hidden = t !== 'webhook';
    document.getElementById('cmMethodWrap').hidden = t !== 'webhook';
  }

  function listHTML() {
    if (!state.list.length) {
      return '<div class="cm-empty">No custom commands yet. They run alongside the built-in ones, on this bot only.</div>';
    }
    return state.list.map(function (c) {
      return '<div class="cm-item' + (c.enabled ? '' : ' off') + '" data-cmd="' + esc(c.id) + '">' +
        '<div class="cm-item-main"><div class="cm-item-name">!' + esc(c.name) +
          (c.aliases && c.aliases.length ? ' <span class="hint" style="margin:0">· ' + c.aliases.map(function (a) { return '!' + esc(a); }).join(' ') + '</span>' : '') +
          '<span class="pill">' + esc(c.type) + '</span>' +
          (c.enabled ? '' : '<span class="pill">off</span>') + '</div>' +
          '<div class="cm-item-desc">' + esc(c.description || (c.type === 'text' ? String(c.response || '').slice(0, 90) : c.type === 'image' ? c.imageUrl : c.url) || '') + '</div>' +
          '<div class="cm-item-meta">' + esc(c.access) + ' · ' + esc(c.scope) + (c.cooldownSeconds ? ' · ' + c.cooldownSeconds + 's cooldown' : '') + '</div></div>' +
        '<div class="cm-item-acts">' +
          '<button class="btn btn-sm btn-ghost" data-cm="toggle">' + (c.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="btn btn-sm btn-ghost" data-cm="edit">Edit</button>' +
          '<button class="btn btn-sm btn-ghost btn-danger" data-cm="del">Delete</button>' +
        '</div></div>';
    }).join('');
  }

  function paint() {
    var host = document.getElementById('cmList');
    if (host) host.innerHTML = listHTML();
    var edit = document.getElementById('cmEdit');
    if (edit) {
      edit.innerHTML = form(state.editing);
      document.getElementById('cmType').onchange = syncType;
      syncType();
      document.getElementById('cmCancel').onclick = function () { state.editing = null; paint(); };
      document.getElementById('cmSave').onclick = save;
    }
    document.querySelectorAll('[data-cmd]').forEach(function (row) {
      var id = row.getAttribute('data-cmd');
      var c = state.list.find(function (x) { return x.id === id; });
      row.querySelectorAll('[data-cm]').forEach(function (b) {
        b.onclick = function () { act(b.getAttribute('data-cm'), c, b); };
      });
    });
    var cap = document.getElementById('cmCap');
    if (cap) {
      cap.textContent = state.meta && state.meta.maxPerBot
        ? state.list.length + ' of ' + state.meta.maxPerBot + ' commands'
        : state.list.length + ' commands';
    }
    var full = state.meta && state.meta.maxPerBot && state.list.length >= state.meta.maxPerBot;
    var addBtn = document.getElementById('cmAdd');
    if (addBtn) {
      addBtn.disabled = !!full;
      addBtn.title = full ? 'Your plan is at its command limit. Upgrade for more.' : 'Create a command';
    }
  }

  async function reload() {
    var r = await api('/api/bots/' + encodeURIComponent(state.bot.id) + '/commands');
    state.list = r.commands || [];
    state.meta = r.meta || state.meta;
  }

  async function act(kind, c, btn) {
    if (!c) return;
    var url = '/api/bots/' + encodeURIComponent(state.bot.id) + '/commands/' + encodeURIComponent(c.id);
    if (kind === 'edit') { state.editing = c; return paint(); }
    if (kind === 'toggle') {
      btn.disabled = true;
      try {
        await api(url + (c.enabled ? '/disable' : '/enable'), { method: 'POST' });
        await reload();
        paint();
      } catch (e) { toastMsg(e.message, 'err'); btn.disabled = false; }
      return;
    }
    if (kind === 'del') {
      if (!confirm('Delete !' + c.name + '?')) return;
      try {
        await api(url, { method: 'DELETE' });
        toastMsg('Command deleted');
        if (state.editing && state.editing.id === c.id) state.editing = null;
        await reload();
        paint();
      } catch (e) { toastMsg(e.message, 'err'); }
    }
  }

  async function save() {
    var btn = document.getElementById('cmSave');
    var body = bodyFor();
    btn.disabled = true;
    var old = btn.innerHTML;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      var url = '/api/bots/' + encodeURIComponent(state.bot.id) + '/commands' +
        (state.editing && state.editing.id ? '/' + encodeURIComponent(state.editing.id) : '');
      var r = await api(url, { method: state.editing && state.editing.id ? 'PATCH' : 'POST', body: body });
      if (r.secret) {
        window.openModal('<h3>Webhook secret</h3><p class="hint">Store this now — it signs every request to your endpoint and is not shown again.</p>' +
          '<div class="cm-secret">' + esc(r.secret) + '</div>' +
          '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">I saved it</button></div>');
        return;
      }
      toastMsg('Command saved', 'ok');
      state.editing = null;
      await reload();
      paint();
    } catch (e) {
      toastMsg(e.message, 'err');
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  async function open(bot) {
    state.bot = bot;
    state.editing = null;
    window.openModal('<h3 style="margin:0 0 4px">Custom commands</h3>' +
      '<p class="hint" style="margin:0 0 14px">Commands for <b>' + esc(bot.name) + '</b> that run next to the built-in ones.</p>' +
      '<div class="cm-wrap"><div class="cm-list"><div class="cm-list-head"><b>Your commands</b>' +
        '<span class="hint" style="margin:0" id="cmCap"></span>' +
        '<button class="btn btn-sm btn-primary" id="cmAdd">+ New</button></div>' +
        '<div id="cmList"><div class="cm-empty">Loading…</div></div></div>' +
      '<div class="cm-edit" id="cmEdit"></div></div>');
    try {
      await reload();
    } catch (e) {
      document.getElementById('cmList').innerHTML = '<div class="cm-empty">' + esc(e.message) + '</div>';
      return;
    }
    paint();
    document.getElementById('cmAdd').onclick = function () { state.editing = null; paint(); };
  }

  window.LBCMDS = { open: open };
})();
