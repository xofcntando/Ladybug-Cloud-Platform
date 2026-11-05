/* Ladybug Chat - contacts.
   Add a new contact (name + number, checked against WhatsApp), pick contacts when starting a chat, rename or remove
   them. Names are kept on the platform and, when WhatsApp allows it, also pushed to the phone's address book.
   Loaded before app.js; app.js calls WACON.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  let cache = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BOOK = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zm-6 4a2.500 2.500 0 1 1 0 5 2.500 2.500 0 0 1 0-5zm4 11H9v-.8c0-1.700 2.700-2.600 4-2.600s4 .9 4 2.600V17z"/></svg>';
  const digitsOf = (s) => String(s || '').replace(/\D/g, '');
  const avatar = (name, jid) => {
    const c = C.S.chats.find((x) => x.jid === jid);
    return C.avatarHtml(c || { name, jid, isGroup: false });
  };

  async function load(force) {
    if (cache && !force) return cache;
    const r = await C.api(C.base + '/contacts');
    cache = r.contacts || [];
    return cache;
  }

  async function startChat(phoneOrJid) {
    try {
      let jid = phoneOrJid;
      if (!/@/.test(jid)) {
        const r = await C.api(C.base + '/lookup', { method: 'POST', body: { phone: jid } });
        if (!r.exists) return C.toast('That number is not on WhatsApp', 'err');
        jid = r.jid;
      }
      await C.loadChats();
      C.openChat(jid);
    } catch (e) { C.toast(e.message, 'err'); }
  }

  /** Add or edit one contact. */
  function form(prefill) {
    const p = prefill || {};
    const editing = !!p.jid;
    const d = C.dialog(`<h3>${editing ? 'Edit contact' : 'New contact'}</h3>
      <label class="wa-field"><span>Name</span><input class="wa-dialog-input" id="waCName" maxlength="60" placeholder="e.g. Thandi Mokoena" value="${esc(p.name || '')}" /></label>
      <label class="wa-field"><span>Phone number</span><input class="wa-dialog-input" id="waCPhone" inputmode="tel" placeholder="Country code first, e.g. 27821234567" value="${esc(p.phone || '')}" ${editing ? 'disabled' : ''} /></label>
      <label class="wa-check"><input type="checkbox" id="waCChat" checked> <span>Open a chat after saving</span></label>
      <p class="wa-note" id="waCNote">The number is checked against WhatsApp before it is saved.</p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Save contact</button></div>`);
    const name = d.querySelector('#waCName'), phone = d.querySelector('#waCPhone'), note = d.querySelector('#waCNote'), ok = d.querySelector('[data-ok]');
    d.querySelector('[data-x]').onclick = () => d.remove();
    const save = async () => {
      if (!name.value.trim()) { note.textContent = 'Enter a name.'; return name.focus(); }
      if (digitsOf(phone.value).length < 7) { note.textContent = 'Enter the number with its country code.'; return phone.focus(); }
      ok.disabled = true; ok.textContent = 'Checking…'; note.textContent = '';
      try {
        const r = await C.api(C.base + '/contacts', { method: 'POST', body: { phone: phone.value, name: name.value } });
        cache = null;
        const open = d.querySelector('#waCChat').checked;
        d.remove();
        C.toast(r.synced ? 'Contact saved and synced to the phone' : 'Contact saved');
        await C.loadChats();
        if (open) C.openChat(r.jid);
        else C.paintList();
      } catch (e) {
        note.textContent = e.message; note.classList.add('bad');
        ok.disabled = false; ok.textContent = 'Save contact';
      }
    };
    ok.onclick = save;
    d.querySelectorAll('input').forEach((i) => { i.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }; });
    (editing ? name : (p.name ? phone : name)).focus();
  }

  /** The contact picker: search, start a chat with a contact or any number, add / edit / remove. */
  function open() {
    const d = C.dialog(`<div class="wa-con-head"><h3>Contacts</h3><button class="wa-btn" data-add>+ New contact</button></div>
      <input class="wa-dialog-input" id="waConQ" placeholder="Search a name or type a number to chat" autocomplete="off" />
      <div class="wa-fwd-list wa-con-list" id="waConList"><div class="chat-empty">Loading…</div></div>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Close</button></div>`);
    const list = d.querySelector('#waConList'), q = d.querySelector('#waConQ');
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('[data-add]').onclick = () => { const n = digitsOf(q.value); d.remove(); form(n.length >= 7 ? { phone: n } : q.value.trim() ? { name: q.value.trim() } : null); };
    const draw = () => {
      const needle = q.value.trim().toLowerCase();
      const digits = digitsOf(q.value);
      const rows = (cache || []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || (digits && c.phone.includes(digits)));
      let html = '';
      if (digits.length >= 7 && !(cache || []).some((c) => c.phone === digits)) {
        html += `<div class="wa-fwd" data-num="${esc(digits)}"><div class="wa-avatar"><span>＋</span></div><span><b>Chat with +${esc(digits)}</b><small class="wa-sub">Not in your contacts</small></span><button class="wa-pill" data-save="${esc(digits)}">Save</button></div>`;
      }
      html += rows.map((c) => `<div class="wa-fwd" data-j="${esc(c.jid)}">${avatar(c.name, c.jid)}<span><b>${esc(c.name)}</b><small class="wa-sub">+${esc(c.phone)}</small></span>${c.mine ? `<button class="wa-pill" data-edit="${esc(c.jid)}">Edit</button><button class="wa-pill danger" data-del="${esc(c.jid)}">Remove</button>` : ''}</div>`).join('');
      list.innerHTML = html || `<div class="chat-empty">${cache && cache.length ? 'No contact matches.' : 'No contacts yet. Press “New contact” to add one.'}</div>`;
    };
    list.onclick = async (e) => {
      const sv = e.target.closest('[data-save]');
      if (sv) { d.remove(); return form({ phone: sv.dataset.save }); }
      const ed = e.target.closest('[data-edit]');
      if (ed) { const c = cache.find((x) => x.jid === ed.dataset.edit); d.remove(); return form({ jid: c.jid, name: c.name, phone: c.phone }); }
      const del = e.target.closest('[data-del]');
      if (del) {
        const c = cache.find((x) => x.jid === del.dataset.del);
        if (!confirm('Remove ' + c.name + ' from your contacts? Their chat stays.')) return;
        try { await C.api(C.base + '/contacts/remove', { method: 'POST', body: { jid: c.jid } }); cache = null; await load(true); draw(); C.loadChats(); C.toast('Contact removed'); }
        catch (er) { C.toast(er.message, 'err'); }
        return;
      }
      const row = e.target.closest('.wa-fwd');
      if (!row) return;
      d.remove();
      startChat(row.dataset.j || row.dataset.num);
    };
    q.oninput = draw;
    q.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const first = list.querySelector('.wa-fwd');
      if (first) { d.remove(); startChat(first.dataset.j || first.dataset.num); }
    };
    q.focus();
    load(true).then(draw).catch((e) => { list.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`; });
  }

  /** "Save contact" / "Edit contact" row inside the contact info drawer. */
  function decorateInfo(box, chat) {
    if (!box || !chat || chat.isGroup || box.querySelector('#waConSave')) return;
    const body = box.querySelector('.wa-prof-body');
    if (!body) return;
    const phone = String(chat.jid).split('@')[0].split(':')[0];
    const row = document.createElement('div');
    row.className = 'wa-con-act';
    const hasName = chat.name && !chat.name.startsWith('+');
    row.innerHTML = `<button class="wa-btn" id="waConSave">${hasName ? 'Edit contact' : 'Save to contacts'}</button>`;
    const top = body.querySelector('.wa-info-top');
    if (top) top.after(row); else body.prepend(row);
    row.querySelector('#waConSave').onclick = () => form({ name: hasName ? chat.name : '', phone, jid: undefined });
  }

  function bindStream(es) {
    es.addEventListener('contact', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        const c = C.S.chats.find((x) => x.jid === d.jid);
        if (c) { c.name = d.name; C.paintList(); if (C.S.jid === d.jid) C.paintTop(); }
        cache = null;
      } catch (e) { /* ignore */ }
    });
  }

  function init(ctx) {
    C = ctx; cache = null;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waContactsBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waContactsBtn'; b.title = 'Contacts'; b.innerHTML = BOOK;
      b.onclick = open;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
  }

  window.WACON = { init, open, form, decorateInfo, bindStream, startChat };
})();
