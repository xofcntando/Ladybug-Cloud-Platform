/* Ladybug Chat - chat labels.
   Colour labels you attach to chats ("Customer", "Paid", "Follow up"...), a filter bar above the chat list,
   chips on each chat row and a manager. Labels are saved on the platform (per linked number), so they follow
   you across browsers. Loaded before app.js; app.js calls WALBL.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  const st = { labels: [], chats: {}, colors: [], max: 20, active: null, loaded: false };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TAG = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M21.4 11.6 12.4 2.6A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .5.2 1 .6 1.4l9 9a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8zM6.5 8A1.5 1.5 0 1 1 8 6.5 1.5 1.5 0 0 1 6.500 8z"/></svg>';
  const labelOf = (id) => st.labels.find((l) => l.id === id);
  const idsOf = (jid) => (st.chats[jid] || []).filter((id) => labelOf(id));
  const countOf = (id) => Object.values(st.chats).filter((arr) => arr.includes(id)).length;

  async function load() {
    try {
      const r = await C.api(C.base + '/labels');
      st.labels = r.labels || []; st.chats = r.chats || {}; st.colors = r.colors || []; st.max = r.max || 20; st.loaded = true;
      if (st.active && st.active !== 'none' && !labelOf(st.active)) st.active = null;
    } catch (e) { /* labels are optional */ }
    renderBar();
    C.paintList();
  }

  /* ---------------------------------------------------------------- chat list integration */
  function chips(jid) {
    const ids = idsOf(jid);
    if (!ids.length) return '';
    const shown = ids.slice(0, 3).map((id) => { const l = labelOf(id); return `<span class="wa-lbl" style="--c:${esc(l.color)}">${esc(l.name)}</span>`; }).join('');
    return `<div class="wa-lbl-row">${shown}${ids.length > 3 ? `<span class="wa-lbl more">+${ids.length - 3}</span>` : ''}</div>`;
  }
  function filter(list) {
    if (!st.active) return list;
    if (st.active === 'none') return list.filter((c) => !idsOf(c.jid).length);
    return list.filter((c) => (st.chats[c.jid] || []).includes(st.active));
  }
  const filtering = () => !!st.active;

  function renderBar() {
    let bar = document.getElementById('waLabelBar');
    const tabs = document.getElementById('waTabs');
    if (!tabs) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'waLabelBar'; bar.className = 'wa-lblbar';
      tabs.parentNode.insertBefore(bar, tabs.nextSibling);
      bar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-lbl]');
        if (!b) return;
        if (b.dataset.lbl === '__manage') return manage();
        st.active = st.active === b.dataset.lbl ? null : b.dataset.lbl;
        renderBar(); C.paintList();
      });
    }
    if (!st.labels.length) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = st.labels.map((l) => `<button data-lbl="${esc(l.id)}" class="${st.active === l.id ? 'on' : ''}" style="--c:${esc(l.color)}"><i></i>${esc(l.name)}<em>${countOf(l.id)}</em></button>`).join('')
      + `<button data-lbl="none" class="${st.active === 'none' ? 'on' : ''}" style="--c:#8696a0"><i></i>No label</button>`
      + `<button data-lbl="__manage" class="mg" title="Manage labels">Edit</button>`;
  }

  /* ---------------------------------------------------------------- creating / editing */
  async function create(name, color) {
    const l = await C.api(C.base + '/labels', { method: 'POST', body: { name, color } });
    st.labels.push(l);
    return l;
  }
  const swatches = (cur, attr) => st.colors.map((c) => `<button type="button" class="wa-sw ${c === cur ? 'on' : ''}" ${attr}="${esc(c)}" style="background:${esc(c)}" title="${esc(c)}"></button>`).join('');

  /** Tick labels for one chat. Each tick saves straight away. */
  function pick(jid) {
    const chat = C.S.chats.find((c) => c.jid === jid);
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    let newColor = st.colors[st.labels.length % Math.max(1, st.colors.length)] || '#00a884';
    const draw = () => {
      const mine = new Set(st.chats[jid] || []);
      box.innerHTML = `<h3>Labels${chat ? ' · ' + esc(chat.name) : ''}</h3>
        <div class="wa-lbl-list">${st.labels.length ? st.labels.map((l) => `<label class="wa-lbl-item"><input type="checkbox" data-id="${esc(l.id)}" ${mine.has(l.id) ? 'checked' : ''}><span class="wa-lbl-dot" style="background:${esc(l.color)}"></span><span>${esc(l.name)}</span></label>`).join('') : '<div class="chat-empty">No labels yet. Create your first one below.</div>'}</div>
        <div class="wa-lbl-new"><input class="wa-dialog-input" id="waLblName" maxlength="24" placeholder="New label (e.g. Customer, Paid, Follow up)" /><div class="wa-sw-row" id="waLblSw">${swatches(newColor, 'data-c')}</div></div>
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-manage>Manage</button><button class="wa-btn ghost" data-add>Add label</button><button class="wa-btn" data-done>Done</button></div>`;
      box.querySelectorAll('input[data-id]').forEach((cb) => {
        cb.onchange = async () => {
          try {
            const r = await C.api(C.base + '/labels/assign', { method: 'POST', body: { jid, labelId: cb.dataset.id, on: cb.checked } });
            if (r.labels.length) st.chats[jid] = r.labels; else delete st.chats[jid];
            renderBar(); C.paintList();
          } catch (e) { cb.checked = !cb.checked; C.toast(e.message, 'err'); }
        };
      });
      box.querySelector('#waLblSw').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; newColor = b.dataset.c; box.querySelectorAll('.wa-sw').forEach((x) => x.classList.toggle('on', x === b)); };
      const add = async () => {
        const inp = box.querySelector('#waLblName');
        const name = inp.value.trim();
        if (!name) return inp.focus();
        try {
          const l = await create(name, newColor);
          const r = await C.api(C.base + '/labels/assign', { method: 'POST', body: { jid, labelId: l.id, on: true } });
          st.chats[jid] = r.labels;
          renderBar(); C.paintList(); draw();
        } catch (e) { C.toast(e.message, 'err'); }
      };
      box.querySelector('[data-add]').onclick = add;
      box.querySelector('#waLblName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      box.querySelector('[data-done]').onclick = () => d.remove();
      box.querySelector('[data-manage]').onclick = () => { d.remove(); manage(); };
    };
    draw();
  }

  /** Rename, recolour and delete labels. */
  function manage() {
    const d = C.dialog('');
    const box = d.querySelector('.wa-dialog');
    let newColor = st.colors[st.labels.length % Math.max(1, st.colors.length)] || '#00a884';
    const draw = () => {
      box.innerHTML = `<h3>Chat labels</h3>
        <div class="wa-lbl-list">${st.labels.map((l) => `<div class="wa-lbl-edit" data-id="${esc(l.id)}">
            <span class="wa-lbl-dot" style="background:${esc(l.color)}"></span>
            <input class="wa-dialog-input" value="${esc(l.name)}" maxlength="24" data-name>
            <small>${countOf(l.id)} chat${countOf(l.id) === 1 ? '' : 's'}</small>
            <button class="wa-icon-btn" data-del title="Delete label">✕</button>
            <div class="wa-sw-row">${swatches(l.color, 'data-sw')}</div></div>`).join('') || '<div class="chat-empty">No labels yet.</div>'}</div>
        <div class="wa-lbl-new"><input class="wa-dialog-input" id="waLblName" maxlength="24" placeholder="New label" ${st.labels.length >= st.max ? 'disabled' : ''} /><div class="wa-sw-row" id="waLblSw">${swatches(newColor, 'data-c')}</div></div>
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-add ${st.labels.length >= st.max ? 'disabled' : ''}>Add label</button><button class="wa-btn" data-done>Done</button></div>`;
      box.querySelectorAll('.wa-lbl-edit').forEach((row) => {
        const id = row.dataset.id;
        const inp = row.querySelector('[data-name]');
        inp.onchange = async () => {
          try { const l = await C.api(C.base + '/labels/' + id, { method: 'PUT', body: { name: inp.value } }); Object.assign(labelOf(id), l); renderBar(); C.paintList(); }
          catch (e) { C.toast(e.message, 'err'); inp.value = labelOf(id).name; }
        };
        row.querySelector('.wa-sw-row').onclick = async (e) => {
          const b = e.target.closest('[data-sw]'); if (!b) return;
          try { const l = await C.api(C.base + '/labels/' + id, { method: 'PUT', body: { color: b.dataset.sw } }); Object.assign(labelOf(id), l); renderBar(); C.paintList(); draw(); }
          catch (er) { C.toast(er.message, 'err'); }
        };
        row.querySelector('[data-del]').onclick = async () => {
          if (!confirm('Delete the label "' + labelOf(id).name + '"? It is removed from all chats.')) return;
          try {
            await C.api(C.base + '/labels/' + id, { method: 'DELETE' });
            st.labels = st.labels.filter((l) => l.id !== id);
            for (const j of Object.keys(st.chats)) { st.chats[j] = st.chats[j].filter((x) => x !== id); if (!st.chats[j].length) delete st.chats[j]; }
            if (st.active === id) st.active = null;
            renderBar(); C.paintList(); draw();
          } catch (e) { C.toast(e.message, 'err'); }
        };
      });
      box.querySelector('#waLblSw').onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; newColor = b.dataset.c; box.querySelectorAll('#waLblSw .wa-sw').forEach((x) => x.classList.toggle('on', x === b)); };
      const add = async () => {
        const inp = box.querySelector('#waLblName'); const name = inp.value.trim();
        if (!name) return inp.focus();
        try { await create(name, newColor); newColor = st.colors[st.labels.length % Math.max(1, st.colors.length)] || newColor; renderBar(); draw(); }
        catch (e) { C.toast(e.message, 'err'); }
      };
      box.querySelector('[data-add]').onclick = add;
      box.querySelector('#waLblName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      box.querySelector('[data-done]').onclick = () => d.remove();
    };
    draw();
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waLabelsBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waLabelsBtn'; b.title = 'Chat labels'; b.innerHTML = TAG;
      b.onclick = manage;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
    renderBar();
    load();
  }

  window.WALBL = { init, chips, filter, filtering, pick, manage, active: () => st.active };
})();
