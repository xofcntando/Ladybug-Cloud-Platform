/* Ladybug Chat — Notes & Follow-ups.
   A private little CRM on top of the console: a note per chat plus dated follow-up
   reminders. Stored with the rest of the platform book (db.data.waBook), so it follows
   the number across browsers and redeploys and works while the bot is offline. Nothing
   is ever written to WhatsApp and no reminder is sent to the contact.
   Loaded before app.js; app.js calls WACRM.init(ctx) once the console is on screen. */
(function () {
  'use strict';

  let C = null;
  let cache = { notes: [], followups: [], due: 0 };
  let badgeTimer = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M5 3h11l4 4v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm10 1.5V8h3.5L15 4.5zM7 11h10v2H7v-2zm0 4h10v2H7v-2zm0-8h5v2H7V7z"/></svg>';

  const pad2 = (n) => String(n).padStart(2, '0');
  const toLocalInput = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const fmtWhen = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const nameFor = (jid, saved) => saved || (C.S.chats.find((c) => c.jid === jid) || {}).name || String(jid || '').split('@')[0];

  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }

  async function refreshBadge() {
    try {
      const r = await C.api(C.base + '/notes');
      cache = r;
      const b = document.getElementById('wacBadge');
      if (b) {
        const n = Number(r.due) || 0;
        b.textContent = n > 99 ? '99+' : String(n);
        b.hidden = !n;
      }
      return r;
    } catch (e) { return cache; }
  }

  function chatOptions(selected) {
    const list = C.S.chats.slice(0, 120);
    return list.map((c) => `<option value="${esc(c.jid)}" ${c.jid === selected ? 'selected' : ''}>${esc(c.name)}${c.isGroup ? ' (group)' : ''}</option>`).join('');
  }

  function addNoteDialog(jid) {
    jid = jid || C.S.jid || '';
    const d = dlg(`<h3>Note for a chat</h3>
      <p class="wa-note">Private to you. Notes are stored on the platform and never sent to WhatsApp.</p>
      <label class="wac-label">Chat</label>
      <select class="wa-dialog-input" id="wacNoteJid">${chatOptions(jid) || '<option value="">No chats loaded</option>'}</select>
      <label class="wac-label">Note</label>
      <textarea id="wacNoteText" rows="5" maxlength="2000" placeholder="Context, preferences, what was agreed…"></textarea>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Save note</button></div>`);
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('[data-ok]').onclick = async () => {
      const j = d.querySelector('#wacNoteJid').value;
      const text = d.querySelector('#wacNoteText').value.trim();
      if (!j) return C.toast('Pick a chat', 'err');
      if (!text) return C.toast('Write the note first', 'err');
      const btn = d.querySelector('[data-ok]'); btn.disabled = true;
      try {
        await C.api(C.base + '/notes', { method: 'POST', body: { jid: j, text, chatName: nameFor(j) } });
        C.toast('Note saved'); d.remove(); refreshBadge(); openPanel('notes');
      } catch (e) { C.toast(e.message, 'err'); btn.disabled = false; }
    };
    d.querySelector('#wacNoteText').focus();
  }

  function addFollowupDialog(jid) {
    jid = jid || C.S.jid || '';
    const d = dlg(`<h3>New follow-up</h3>
      <p class="wa-note">A reminder for you. It shows up in this panel when it is due; nobody is messaged automatically.</p>
      <label class="wac-label">Chat</label>
      <select class="wa-dialog-input" id="wacFuJid">${chatOptions(jid) || '<option value="">No chats loaded</option>'}</select>
      <label class="wac-label">What to follow up on</label>
      <input class="wa-dialog-input" id="wacFuText" maxlength="300" placeholder="Ask about the invoice" />
      <label class="wac-label">When</label>
      <input class="wa-dialog-input" type="datetime-local" id="wacFuWhen" />
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-x>Cancel</button><button class="wa-btn" data-ok>Add follow-up</button></div>`);
    const when = d.querySelector('#wacFuWhen');
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
    when.min = toLocalInput(Date.now() + 60_000);
    when.value = toLocalInput(t.getTime());
    d.querySelector('[data-x]').onclick = () => d.remove();
    d.querySelector('[data-ok]').onclick = async () => {
      const j = d.querySelector('#wacFuJid').value;
      const text = d.querySelector('#wacFuText').value.trim();
      const dueAt = new Date(when.value).getTime();
      if (!j) return C.toast('Pick a chat', 'err');
      if (!text) return C.toast('Write what to follow up on', 'err');
      if (!Number.isFinite(dueAt)) return C.toast('Pick a date and time', 'err');
      const btn = d.querySelector('[data-ok]'); btn.disabled = true;
      try {
        await C.api(C.base + '/followups', { method: 'POST', body: { jid: j, text, dueAt, chatName: nameFor(j) } });
        C.toast('Follow-up added'); d.remove(); refreshBadge(); openPanel('followups');
      } catch (e) { C.toast(e.message, 'err'); btn.disabled = false; }
    };
    d.querySelector('#wacFuText').focus();
  }

  function noteRow(n) {
    return `<div class="wac-row" data-note="${esc(n.jid)}">
      <div class="wac-row-top"><b>${esc(nameFor(n.jid, n.chatName))}</b><small>${esc(new Date(n.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</small></div>
      <div class="wac-row-text">${esc(n.text)}</div>
      <div class="wac-row-act"><button class="wa-btn ghost" data-open="${esc(n.jid)}">Open chat</button><button class="wa-btn ghost danger" data-delnote="${esc(n.jid)}">Delete</button></div>
    </div>`;
  }

  function fuRow(f) {
    const overdue = !f.done && f.dueAt <= Date.now();
    return `<div class="wac-row ${f.done ? 'done' : ''} ${overdue ? 'overdue' : ''}" data-fu="${esc(f.id)}">
      <div class="wac-row-top"><b>${esc(nameFor(f.jid, f.chatName))}</b><small>${f.done ? 'done' : overdue ? 'overdue · ' : 'due '}${esc(fmtWhen(f.dueAt))}</small></div>
      <div class="wac-row-text">${esc(f.text)}</div>
      <div class="wac-row-act">
        <button class="wa-btn ghost" data-done="${esc(f.id)}" data-val="${f.done ? '0' : '1'}">${f.done ? 'Reopen' : 'Mark done'}</button>
        <button class="wa-btn ghost" data-open="${esc(f.jid)}">Open chat</button>
        <button class="wa-btn ghost danger" data-delfu="${esc(f.id)}">Delete</button>
      </div>
    </div>`;
  }

  async function openPanel(tab) {
    tab = tab || 'followups';
    const d = dlg('<h3>Notes & Follow-ups</h3><div class="chat-empty">Loading…</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-gal-dialog', 'wac-wide');

    const draw = (r) => {
      const notes = r.notes || [];
      const fus = r.followups || [];
      const open = fus.filter((f) => !f.done);
      const done = fus.filter((f) => f.done);
      const due = open.filter((f) => f.dueAt <= Date.now());
      const body = tab === 'notes'
        ? (notes.length ? notes.map(noteRow).join('') : '<div class="chat-empty">No notes yet. Add one from a chat to keep context.</div>')
        : (open.length ? open.map(fuRow).join('') : '<div class="chat-empty">Nothing to follow up on. Nice.</div>') +
          (done.length ? `<h4 class="wac-sub">Done <i>${done.length}</i></h4>` + done.slice(0, 30).map(fuRow).join('') : '');

      box.innerHTML = `<div class="wa-gal-head"><h3>Notes & Follow-ups</h3><button class="wa-icon-btn" data-x title="Close">✕</button></div>
        <div class="wac-tabs"><button data-t="followups" class="${tab === 'followups' ? 'on' : ''}">Follow-ups <i>${open.length}</i></button><button data-t="notes" class="${tab === 'notes' ? 'on' : ''}">Notes <i>${notes.length}</i></button></div>
        ${due.length ? `<div class="wac-due">${due.length} follow-up${due.length === 1 ? '' : 's'} due now.</div>` : ''}
        <div class="wac-body">${body}</div>
        <div class="wa-dialog-act"><button class="wa-btn ghost" data-addnote>Add note</button><button class="wa-btn" data-addfu>New follow-up</button><button class="wa-btn ghost" data-x>Done</button></div>`;

      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      box.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { tab = b.dataset.t; draw(cache); }; });
      box.querySelector('[data-addnote]').onclick = () => { d.remove(); addNoteDialog(C.S.jid); };
      box.querySelector('[data-addfu]').onclick = () => { d.remove(); addFollowupDialog(C.S.jid); };
      box.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { d.remove(); C.openChat(b.dataset.open); }; });
      box.querySelectorAll('[data-delnote]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Delete this note?')) return;
          try { await C.api(C.base + '/notes/delete', { method: 'POST', body: { jid: b.dataset.delnote } }); await refreshBadge(); draw(cache); }
          catch (e) { C.toast(e.message, 'err'); }
        };
      });
      box.querySelectorAll('[data-delfu]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Delete this follow-up?')) return;
          try { await C.api(C.base + '/followups/' + encodeURIComponent(b.dataset.delfu), { method: 'DELETE' }); await refreshBadge(); draw(cache); }
          catch (e) { C.toast(e.message, 'err'); }
        };
      });
      box.querySelectorAll('[data-done]').forEach((b) => {
        b.onclick = async () => {
          try { await C.api(C.base + '/followups/' + encodeURIComponent(b.dataset.done), { method: 'PUT', body: { done: b.dataset.val === '1' } }); await refreshBadge(); draw(cache); }
          catch (e) { C.toast(e.message, 'err'); }
        };
      });
    };

    try { draw(await refreshBadge()); }
    catch (e) {
      box.innerHTML = `<div class="wa-gal-head"><h3>Notes & Follow-ups</h3><button class="wa-icon-btn" data-x>✕</button></div><div class="chat-empty">${esc(e.message)}</div>`;
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
    }
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    const grow = rail && rail.querySelector('.wa-rail-grow');
    if (rail && grow && !document.getElementById('wacBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'wacBtn'; b.title = 'Notes & follow-ups'; b.innerHTML = ICON + '<i class="wa-rad-badge wac-badge" id="wacBadge" hidden></i>';
      b.onclick = () => openPanel('followups');
      rail.insertBefore(b, grow);
    }
    refreshBadge();
    clearInterval(badgeTimer);
    badgeTimer = setInterval(() => { if (!document.getElementById('waApp')) { clearInterval(badgeTimer); return; } refreshBadge(); }, 120_000);
  }

  window.WACRM = { init, open: openPanel, addNote: addNoteDialog, addFollowup: addFollowupDialog, refresh: refreshBadge };
})();
