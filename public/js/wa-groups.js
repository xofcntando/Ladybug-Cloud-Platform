/* Ladybug Chat - groups.
   Create a group, add and remove people, promote and demote admins, rename it, edit the description,
   switch it to announcement-only or locked, copy or reset the invite link, join with an invite link,
   and leave. Also the "clear chat" action, which only clears the dashboard's copy of a conversation.

   Everything here changes WhatsApp itself, so each action reports per-number results and the drawer is
   re-rendered from fresh metadata afterwards. Loaded before app.js; app.js calls WAGRP.init(ctx). */
(function () {
  'use strict';

  let C = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const digitsOf = (s) => String(s || '').replace(/\D/g, '');

  /* ---------------------------------------------------------------- helpers */
  const base = () => C.base;

  async function meta(jid) {
    return C.api(base() + '/group?jid=' + encodeURIComponent(jid));
  }

  /** One row per person, with the admin badge and a "···" button for the participant menu. */
  function peopleHtml(list, canManage) {
    const sorted = list.slice().sort((a, b) => (!!b.admin - !!a.admin) || (b.me - a.me));
    return sorted.map((p) => {
      const name = p.me ? 'You' : (p.name || '+' + p.phone);
      const badge = p.admin === 'superadmin' ? 'Group admin' : p.admin === 'admin' ? 'Admin' : '';
      return `<div class="wa-blocked wa-part" data-p="${esc(p.id)}">
        <span>${esc(name)}<small class="wa-sub">+${esc(p.phone)}</small></span>
        ${badge ? `<em class="wa-admin">${badge}</em>` : ''}
        ${canManage && !p.me ? `<button class="wa-pill" data-pmenu="${esc(p.id)}" title="Options">···</button>` : ''}
      </div>`;
    }).join('');
  }

  function participantMenu(p, run, x, y) {
    const items = [];
    if (p.admin) items.push({ label: 'Dismiss as admin', run: () => run('demote') });
    else items.push({ label: 'Make group admin', run: () => run('promote') });
    items.push({ label: 'Remove from group', danger: true, run: () => {
      if (!confirm('Remove ' + (p.name || '+' + p.phone) + ' from this group?')) return;
      run('remove');
    } });
    C.popMenu(x || 0, y || 0, items);
  }

  async function act(jid, action, participants, after) {
    try {
      const r = await C.api(base() + '/group/participants', { method: 'POST', body: { jid, action, participants } });
      if (r.failed) {
        const bad = (r.results || []).filter((x) => String(x.status) !== '200');
        C.toast(bad.length ? 'Some changes did not go through: ' + bad.map((x) => '+' + x.phone + ' (' + x.status + ')').join(', ') : 'Partly done', 'err');
      } else {
        C.toast({ add: 'Added to group', remove: 'Removed from group', promote: 'Now a group admin', demote: 'No longer an admin' }[action] || 'Done');
      }
      if (after) after();
      C.loadChats();
    } catch (e) { C.toast(e.message, 'err'); }
  }

  /* ---------------------------------------------------------------- create a group */
  async function openCreate() {
    let contacts = [];
    try { const r = await C.api(base() + '/contacts'); contacts = r.contacts || []; } catch (e) { /* picker still works by number */ }

    const d = C.dialog(`<h3>New group</h3>
      <label class="wa-field"><span>Group name</span><input class="wa-dialog-input" id="waGName" maxlength="100" placeholder="e.g. Ntandomods Support" autocomplete="off" /></label>
      <label class="wa-field"><span>Add people</span><input class="wa-dialog-input" id="waGQ" placeholder="Search contacts or type a number" autocomplete="off" /></label>
      <div class="wa-fwd-list wa-con-list" id="waGList"></div>
      <div id="waGChips" class="wa-chip-row"></div>
      <p class="wa-note" id="waGNote">Pick at least one person. You will be added automatically.</p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Create group</button></div>`);

    const q = d.querySelector('#waGQ'), list = d.querySelector('#waGList'), chips = d.querySelector('#waGChips');
    const note = d.querySelector('#waGNote'), ok = d.querySelector('[data-ok]');
    const picked = new Map(); // phone -> name

    const drawChips = () => {
      chips.innerHTML = [...picked.entries()].map(([phone, name]) =>
        `<span class="wa-chip">${esc(name || '+' + phone)}<button data-un="${esc(phone)}" title="Remove">✕</button></span>`).join('');
      chips.querySelectorAll('[data-un]').forEach((b) => { b.onclick = () => { picked.delete(b.dataset.un); drawChips(); drawList(); }; });
      ok.disabled = !picked.size;
    };

    const drawList = () => {
      const needle = q.value.trim().toLowerCase();
      const digits = digitsOf(q.value);
      const rows = contacts.filter((c) => !needle || c.name.toLowerCase().includes(needle) || (digits && c.phone.includes(digits))).slice(0, 40);
      let html = rows.map((c) => {
        const on = picked.has(c.phone);
        return `<div class="wa-fwd" data-add="${esc(c.phone)}" data-name="${esc(c.name)}">
          ${C.avatarHtml({ name: c.name, jid: c.jid, isGroup: false })}
          <span><b>${esc(c.name)}</b><small class="wa-sub">+${esc(c.phone)}</small></span>
          <button class="wa-pill">${on ? 'Added' : 'Add'}</button></div>`;
      }).join('');
      if (digits.length >= 7 && !contacts.some((c) => c.phone === digits) && !picked.has(digits)) {
        html = `<div class="wa-fwd" data-add="${esc(digits)}" data-name=""><div class="wa-avatar"><span>＋</span></div>
          <span><b>+${esc(digits)}</b><small class="wa-sub">Not in your contacts</small></span>
          <button class="wa-pill">Add</button></div>` + html;
      }
      list.innerHTML = html || '<div class="chat-empty">No contact matches. Type a full number with its country code.</div>';
    };

    list.onclick = (e) => {
      const row = e.target.closest('[data-add]');
      if (!row) return;
      const phone = row.dataset.add;
      if (picked.has(phone)) picked.delete(phone);
      else picked.set(phone, row.dataset.name || '');
      drawChips(); drawList();
    };
    q.oninput = drawList;
    d.querySelector('[data-x]').onclick = () => d.remove();
    ok.onclick = async () => {
      const subject = d.querySelector('#waGName').value.trim();
      if (!subject) { note.textContent = 'Give the group a name.'; note.classList.add('bad'); return d.querySelector('#waGName').focus(); }
      if (!picked.size) { note.textContent = 'Add at least one person.'; note.classList.add('bad'); return; }
      ok.disabled = true; ok.textContent = 'Creating…'; note.textContent = ''; note.classList.remove('bad');
      try {
        const r = await C.api(base() + '/group/create', { method: 'POST', body: { subject, participants: [...picked.keys()] } });
        d.remove();
        C.toast('Group created');
        await C.loadChats();
        if (r.jid) C.openChat(r.jid);
      } catch (e) {
        note.textContent = e.message; note.classList.add('bad');
        ok.disabled = false; ok.textContent = 'Create group';
      }
    };
    drawChips(); drawList();
    d.querySelector('#waGName').focus();
  }

  /* ---------------------------------------------------------------- join with an invite link */
  function openJoin() {
    const d = C.dialog(`<h3>Join a group</h3>
      <p class="wa-note" style="padding:0">Paste the invite link someone sent you, e.g. https://chat.whatsapp.com/ABC123…</p>
      <input class="wa-dialog-input" id="waJCode" placeholder="Invite link or code" autocomplete="off" />
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Join</button></div>`);
    const input = d.querySelector('#waJCode'), ok = d.querySelector('[data-ok]');
    d.querySelector('[data-x]').onclick = () => d.remove();
    const go = async () => {
      if (!input.value.trim()) return input.focus();
      ok.disabled = true; ok.textContent = 'Joining…';
      try {
        const r = await C.api(base() + '/group/join', { method: 'POST', body: { code: input.value } });
        d.remove();
        C.toast('Joined the group');
        await C.loadChats();
        if (r.jid) C.openChat(r.jid);
      } catch (e) { C.toast(e.message, 'err'); ok.disabled = false; ok.textContent = 'Join'; }
    };
    ok.onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
    input.focus();
  }

  /* ---------------------------------------------------------------- group settings drawer */
  async function openSettings(jid, rerender) {
    let g;
    try { g = await meta(jid); } catch (e) { return C.toast(e.message, 'err'); }
    const me = (g.participants || []).find((p) => p.me);
    const iAmAdmin = !!(me && me.admin);
    const d = C.dialog(`<div class="wa-con-head"><h3>Group settings</h3></div>
      <label class="wa-field"><span>Group name</span><div class="wa-field-row">
        <input id="waGsName" maxlength="100" value="${esc(g.subject)}" /><button class="wa-icon-btn" id="waGsNameSave" title="Save name">✓</button></div></label>
      <label class="wa-field"><span>Description</span><textarea id="waGsDesc" rows="3" maxlength="2048" class="wa-dialog-input">${esc(g.desc || '')}</textarea></label>
      <button class="wa-btn ghost" id="waGsDescSave">Save description</button>
      <h4 class="wa-sec">Who can do what</h4>
      <label class="wa-set-row"><span>Only admins can send messages</span><input type="checkbox" id="waGsAnn" ${g.announce ? 'checked' : ''} ${iAmAdmin ? '' : 'disabled'} /></label>
      <label class="wa-set-row"><span>Only admins can edit group info</span><input type="checkbox" id="waGsLock" ${g.restrict ? 'checked' : ''} ${iAmAdmin ? '' : 'disabled'} /></label>
      <h4 class="wa-sec">Invite link</h4>
      <div class="wa-field"><div class="wa-field-row"><input id="waGsLink" readonly placeholder="Press “Get link”" /><button class="wa-icon-btn" id="waGsCopy" title="Copy">⧉</button></div></div>
      <div class="wa-con-act"><button class="wa-btn" id="waGsGet">Get link</button><button class="wa-btn ghost" id="waGsRevoke">Reset link</button></div>
      <h4 class="wa-sec">Members <i>${g.size}</i></h4>
      <div class="wa-con-act"><button class="wa-btn" id="waGsAdd">+ Add people</button></div>
      <div id="waGsPeople">${peopleHtml(g.participants || [], iAmAdmin)}</div>
      <h4 class="wa-sec">Danger zone</h4>
      <div class="wa-con-act"><button class="wa-btn ghost" id="waGsLeave" style="color:#ef6c5b">Leave group</button></div>
      <p class="wa-note" id="waGsNote"></p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Close</button></div>`);

    const note = d.querySelector('#waGsNote');
    const say = (t, bad) => { note.textContent = t; note.classList.toggle('bad', !!bad); };
    d.querySelector('[data-x]').onclick = () => d.remove();

    const refresh = async () => { d.remove(); await openSettings(jid, rerender); if (rerender) rerender(); };

    d.querySelector('#waGsNameSave').onclick = async () => {
      const subject = d.querySelector('#waGsName').value.trim();
      if (!subject) return say('The name cannot be empty.', true);
      try { await C.api(base() + '/group/subject', { method: 'POST', body: { jid, subject } }); say('Name updated.'); C.loadChats(); if (rerender) rerender(); }
      catch (e) { say(e.message, true); }
    };
    d.querySelector('#waGsDescSave').onclick = async () => {
      try { await C.api(base() + '/group/desc', { method: 'POST', body: { jid, desc: d.querySelector('#waGsDesc').value } }); say('Description updated.'); }
      catch (e) { say(e.message, true); }
    };
    d.querySelector('#waGsAnn').onchange = async (e) => {
      try { await C.api(base() + '/group/setting', { method: 'POST', body: { jid, setting: e.target.checked ? 'announcement' : 'not_announcement' } }); say('Message permission updated.'); }
      catch (er) { e.target.checked = !e.target.checked; say(er.message, true); }
    };
    d.querySelector('#waGsLock').onchange = async (e) => {
      try { await C.api(base() + '/group/setting', { method: 'POST', body: { jid, setting: e.target.checked ? 'locked' : 'unlocked' } }); say('Group info permission updated.'); }
      catch (er) { e.target.checked = !e.target.checked; say(er.message, true); }
    };
    d.querySelector('#waGsGet').onclick = async () => {
      try {
        const r = await C.api(base() + '/group/invite', { method: 'POST', body: { jid } });
        d.querySelector('#waGsLink').value = r.link || '';
        say(r.link ? 'Link ready — copy it and share.' : 'WhatsApp did not return a link.');
      } catch (e) { say(e.message, true); }
    };
    d.querySelector('#waGsCopy').onclick = () => {
      const v = d.querySelector('#waGsLink').value;
      if (!v) return say('Press “Get link” first.', true);
      try { navigator.clipboard.writeText(v); C.toast('Link copied'); } catch (e) { say(v); }
    };
    d.querySelector('#waGsRevoke').onclick = async () => {
      if (!confirm('Reset the invite link? The old link stops working.')) return;
      try {
        const r = await C.api(base() + '/group/invite/revoke', { method: 'POST', body: { jid } });
        d.querySelector('#waGsLink').value = r.link || '';
        say('Old link cancelled. The new one is above.');
      } catch (e) { say(e.message, true); }
    };
    d.querySelector('#waGsAdd').onclick = () => { addPeople(jid, g, refresh); };
    d.querySelector('#waGsLeave').onclick = async () => {
      if (!confirm('Leave this group? You will stop receiving its messages.')) return;
      try {
        await C.api(base() + '/group/leave', { method: 'POST', body: { jid } });
        d.remove();
        C.toast('You left the group');
        C.S.jid = null;
        const shell = document.querySelector('#waShell');
        if (shell) shell.classList.remove('chat-open');
        await C.loadChats();
      } catch (e) { say(e.message, true); }
    };
    d.querySelectorAll('[data-pmenu]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const p = (g.participants || []).find((x) => x.id === b.dataset.pmenu);
        if (!p) return;
        const r = b.getBoundingClientRect();
        participantMenu(p, (action) => act(jid, action, [p.id], () => { d.remove(); openSettings(jid, rerender); }), r.left - 160, r.bottom + 4);
      };
    });
  }

  /* ---------------------------------------------------------------- add people to an existing group */
  async function addPeople(jid, g, after) {
    let contacts = [];
    try { const r = await C.api(base() + '/contacts'); contacts = r.contacts || []; } catch (e) { /* number entry still works */ }
    const existing = new Set((g.participants || []).map((p) => p.phone));
    const d = C.dialog(`<h3>Add people</h3>
      <input class="wa-dialog-input" id="waGpQ" placeholder="Search contacts or type a number" autocomplete="off" />
      <div class="wa-fwd-list wa-con-list" id="waGpList"></div>
      <p class="wa-note" id="waGpNote"></p>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Add</button></div>`);
    const q = d.querySelector('#waGpQ'), list = d.querySelector('#waGpList'), note = d.querySelector('#waGpNote'), ok = d.querySelector('[data-ok]');
    const picked = new Map();
    const draw = () => {
      const needle = q.value.trim().toLowerCase();
      const digits = digitsOf(q.value);
      const rows = contacts.filter((c) => !existing.has(c.phone) && (!needle || c.name.toLowerCase().includes(needle) || (digits && c.phone.includes(digits)))).slice(0, 40);
      let html = rows.map((c) => `<div class="wa-fwd" data-add="${esc(c.phone)}" data-name="${esc(c.name)}">
        ${C.avatarHtml({ name: c.name, jid: c.jid, isGroup: false })}
        <span><b>${esc(c.name)}</b><small class="wa-sub">+${esc(c.phone)}</small></span>
        <button class="wa-pill">${picked.has(c.phone) ? 'Added' : 'Add'}</button></div>`).join('');
      if (digits.length >= 7 && !existing.has(digits) && !contacts.some((c) => c.phone === digits)) {
        html = `<div class="wa-fwd" data-add="${esc(digits)}" data-name=""><div class="wa-avatar"><span>＋</span></div>
          <span><b>+${esc(digits)}</b><small class="wa-sub">Not in your contacts</small></span>
          <button class="wa-pill">${picked.has(digits) ? 'Added' : 'Add'}</button></div>` + html;
      }
      list.innerHTML = html || '<div class="chat-empty">Nothing to add. Type a full number with its country code.</div>';
    };
    list.onclick = (e) => {
      const row = e.target.closest('[data-add]');
      if (!row) return;
      const phone = row.dataset.add;
      if (picked.has(phone)) picked.delete(phone); else picked.set(phone, row.dataset.name || '');
      draw();
    };
    q.oninput = draw;
    d.querySelector('[data-x]').onclick = () => d.remove();
    ok.onclick = async () => {
      if (!picked.size) { note.textContent = 'Pick at least one person.'; note.classList.add('bad'); return; }
      ok.disabled = true; ok.textContent = 'Adding…';
      try {
        const r = await C.api(base() + '/group/participants', { method: 'POST', body: { jid, action: 'add', participants: [...picked.keys()] } });
        d.remove();
        if (r.failed) {
          const bad = (r.results || []).filter((x) => String(x.status) !== '200');
          C.toast('Some could not be added: ' + bad.map((x) => '+' + x.phone).join(', '), 'err');
        } else C.toast('Added to the group');
        if (after) after();
      } catch (e) { note.textContent = e.message; note.classList.add('bad'); ok.disabled = false; ok.textContent = 'Add'; }
    };
    draw();
    q.focus();
  }

  /* ---------------------------------------------------------------- clear chat */
  async function clearChat(jid) {
    if (!confirm('Clear this conversation in the dashboard?\n\nWhatsApp itself is not touched — this only empties the copy shown here.')) return;
    try {
      await C.api(base() + '/clear', { method: 'POST', body: { jid } });
      if (C.S.jid === jid) { C.S.msgs = []; C.paintThread(true); }
      C.toast('Chat cleared');
      C.loadChats();
    } catch (e) { C.toast(e.message, 'err'); }
  }

  /* ---------------------------------------------------------------- wiring into the existing console */
  function decorateInfo(box, chat) {
    if (!box || !chat || !chat.isGroup) return;
    const body = box.querySelector('.wa-prof-body');
    if (!body || box.querySelector('#waGrpSettings')) return;
    const row = document.createElement('div');
    row.className = 'wa-con-act';
    row.innerHTML = '<button class="wa-btn" id="waGrpSettings">Group settings</button>';
    const top = body.querySelector('.wa-info-top');
    if (top) top.after(row); else body.prepend(row);
    row.querySelector('#waGrpSettings').onclick = () => openSettings(chat.jid, () => {
      const btn = document.querySelector('#waInfoBtn');
      if (btn) btn.click();
    });
  }

  /** Extra entries for the chat context menu. */
  function menuItems(chat) {
    const items = [];
    if (chat.isGroup) items.push({ label: 'Group settings…', run: () => openSettings(chat.jid) });
    items.push({ label: 'Clear chat', run: () => clearChat(chat.jid) });
    return items;
  }

  /** Extra entries for the "new chat" button. */
  function newChatItems() {
    return [
      { label: '👥 New group', run: openCreate },
      { label: '🔗 Join with invite link', run: openJoin },
    ];
  }

  function init(ctx) { C = ctx; }

  window.WAGRP = { init, openCreate, openJoin, openSettings, addPeople, clearChat, decorateInfo, menuItems, newChatItems };
})();
