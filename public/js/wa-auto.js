/* Ladybug Chat - automation suite for the web console.
   Presence (always online), status helpers (auto-view / auto-save), receipts (auto-read),
   call handling (auto-reject), an away auto-reply and keyword auto-responder rules.
   Settings are saved on the platform per linked number and re-applied every time the bot starts.
   Loaded before app.js; app.js calls WAAUTO.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BOLT = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M11 21h-1l1-7H7.500c-.6 0-.6-.3-.4-.7L13 3h1l-1 7h3.500c.5 0 .6.3.5.7z"/></svg>';

  const TOGGLES = [
    { key: 'online', title: 'Always online', text: 'Keeps this number showing as Online, even when nobody is using it.', warn: 'While this is on, WhatsApp may stop notifying your phone about new messages, and contacts always see you online.' },
    { key: 'viewStatus', title: 'Auto-view status', text: 'Views your contacts\u2019 new statuses a few seconds after they post them.', warn: 'The poster only sees the view if read receipts are on (Profile > Privacy).' },
    { key: 'saveStatus', title: 'Auto-save status', text: 'Sends every new status (photo, video, text) to your own chat so you keep it after 24 hours.', warn: 'Uses the bot\u2019s status saver. Saved items arrive in the "Message yourself" chat.', needsSave: true },
    { key: 'readReceipts', title: 'Auto-read messages', text: 'Marks incoming chats as read the moment they arrive, so your contacts see blue ticks.', warn: 'Your phone will not show unread badges for these chats any more.' },
    { key: 'rejectCalls', title: 'Auto-reject calls', text: 'Declines incoming voice and video calls straight away so the bot is never interrupted.', warn: 'Callers are not told why; they simply see the call was declined.' },
  ];

  function open() {
    const d = C.dialog('<h3>Automation</h3><div class="chat-empty">Loading\u2026</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-auto-dialog');
    let st = null;

    const save = async (patch, okMsg) => {
      const r = await C.api(C.base + '/automation', { method: 'POST', body: patch });
      if (r.saved) Object.assign(st, r.saved);
      C.toast(okMsg || (r.applied ? 'Applied' : 'Saved. It applies when the bot starts.'));
      return r;
    };

    function draw() {
      const keep = box.scrollTop;
      const rules = Array.isArray(st.rules) ? st.rules : [];
      const away = st.away || { enabled: false, text: '', cooldownMin: 60 };
      box.innerHTML = `
        <div class="wa-gal-head"><h3>Automation</h3><button class="wa-icon-btn" data-x title="Close">\u2715</button></div>
        ${st.running ? '' : '<p class="wa-note bad">The bot is stopped. Changes are saved and apply the next time it starts.</p>'}
        <section class="wa-auto-sec">
          <h4>Presence and receipts</h4>
          ${TOGGLES.map((it) => {
            const off = it.needsSave && st.saveSupported === false;
            return `<div class="wa-auto-row ${off ? 'disabled' : ''}"><div><b>${it.title}</b><small>${esc(it.text)}</small>${st[it.key] ? `<small class="warn">${esc(it.warn)}</small>` : ''}${off ? '<small class="warn">This bot version has no status saver.</small>' : ''}</div>
              <label class="wa-switch"><input type="checkbox" data-k="${it.key}" ${st[it.key] ? 'checked' : ''} ${off ? 'disabled' : ''}><i></i></label></div>`;
          }).join('')}
        </section>

        <section class="wa-auto-sec">
          <h4>Away auto-reply</h4>
          <div class="wa-auto-row">
            <div><b>Reply while away</b><small>Sends one automatic reply to each person who messages you, then stays quiet for the cooldown.</small></div>
            <label class="wa-switch"><input type="checkbox" id="awOn" ${away.enabled ? 'checked' : ''}><i></i></label>
          </div>
          <label class="wa-field"><span>Message</span><textarea id="awText" rows="3" maxlength="300" placeholder="Hi! I'm away right now and will reply as soon as I'm back.">${esc(away.text || '')}</textarea></label>
          <label class="wa-field inline"><span>Do not reply again for</span>
            <select id="awCd">${[0, 15, 30, 60, 180, 360, 720, 1440].map((m) => `<option value="${m}" ${Number(away.cooldownMin) === m ? 'selected' : ''}>${m === 0 ? 'every message' : m < 60 ? m + ' minutes' : (m / 60) + (m === 60 ? ' hour' : ' hours')}</option>`).join('')}</select>
          </label>
          <div class="wa-auto-act"><button class="wa-btn" id="awSave">Save away reply</button></div>
        </section>

        <section class="wa-auto-sec">
          <h4>Keyword auto-responder <span class="wap-count">${rules.length}</span></h4>
          <small class="wa-note" style="padding:0">When a message contains a keyword, the bot replies with your text. Each rule fires at most once per chat every 5 minutes.</small>
          <div class="wa-rules">${rules.length ? rules.map((r) => `
            <div class="wa-rule ${r.enabled === false ? 'off' : ''}" data-rule="${esc(r.id)}">
              <div class="wa-rule-body">
                <b>${esc(r.match)}${r.exact ? ' <span class="wap-tag">exact</span>' : ''}</b>
                <small>${esc(r.reply)}</small>
              </div>
              <label class="wa-switch sm"><input type="checkbox" data-rt="${esc(r.id)}" ${r.enabled === false ? '' : 'checked'}><i></i></label>
              <button class="wa-icon-btn" data-rd="${esc(r.id)}" title="Delete rule">\u2715</button>
            </div>`).join('') : '<div class="chat-empty" style="padding:14px 0">No rules yet.</div>'}</div>
          <div class="wa-rule-add">
            <input id="rMatch" placeholder="keyword or phrase" maxlength="80">
            <textarea id="rReply" rows="2" placeholder="reply text" maxlength="500"></textarea>
            <label class="wa-check"><input type="checkbox" id="rExact"> Only when the whole message matches</label>
            <button class="wa-btn" id="rAdd">Add rule</button>
          </div>
        </section>

        <div class="wa-dialog-act"><button class="wa-btn" data-x>Done</button></div>`;
      box.scrollTop = keep;

      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });

      box.querySelectorAll('input[data-k]').forEach((cb) => {
        cb.onchange = async () => {
          const k = cb.dataset.k, v = cb.checked;
          cb.disabled = true;
          try {
            const r = await save({ [k]: v }, TOGGLES.find((i) => i.key === k).title + (v ? ' is on' : ' is off'));
            if (r.saveSupported === false) st.saveSupported = false;
          } catch (e) { cb.checked = !v; C.toast(e.message, 'err'); }
          draw();
        };
      });

      const awOn = box.querySelector('#awOn');
      const awText = box.querySelector('#awText');
      const awCd = box.querySelector('#awCd');
      box.querySelector('#awSave').onclick = async () => {
        const text = awText.value.trim();
        if (!text) return C.toast('Write the away message first', 'err');
        try {
          await save({ away: { enabled: awOn.checked, text, cooldownMin: Number(awCd.value) } }, 'Away reply saved');
          draw();
        } catch (e) { C.toast(e.message, 'err'); }
      };
      awOn.onchange = async () => {
        if (!awText.value.trim()) { awOn.checked = !awOn.checked; return C.toast('Write the away message first', 'err'); }
        try { await save({ away: { enabled: awOn.checked, text: awText.value.trim(), cooldownMin: Number(awCd.value) } }, awOn.checked ? 'Away reply is on' : 'Away reply is off'); draw(); }
        catch (e) { awOn.checked = !awOn.checked; C.toast(e.message, 'err'); }
      };

      box.querySelectorAll('input[data-rt]').forEach((cb) => {
        cb.onchange = async () => {
          const id = cb.dataset.rt;
          const next = rules.map((r) => (r.id === id ? Object.assign({}, r, { enabled: cb.checked }) : r));
          try { await save({ rules: next }, cb.checked ? 'Rule on' : 'Rule off'); } catch (e) { C.toast(e.message, 'err'); }
          draw();
        };
      });
      box.querySelectorAll('[data-rd]').forEach((b) => {
        b.onclick = async () => {
          const next = rules.filter((r) => r.id !== b.dataset.rd);
          try { await save({ rules: next }, 'Rule deleted'); } catch (e) { C.toast(e.message, 'err'); }
          draw();
        };
      });
      box.querySelector('#rAdd').onclick = async () => {
        const match = box.querySelector('#rMatch').value.trim();
        const reply = box.querySelector('#rReply').value.trim();
        if (!match || !reply) return C.toast('Fill in the keyword and the reply', 'err');
        const next = rules.concat([{ match, reply, exact: box.querySelector('#rExact').checked, enabled: true }]);
        try { await save({ rules: next }, 'Rule added'); draw(); } catch (e) { C.toast(e.message, 'err'); }
      };
    }

    C.api(C.base + '/automation').then((r) => { st = r; draw(); }).catch((e) => { box.innerHTML = `<div class="chat-empty">${esc(e.message)}</div>`; });
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waAutoBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waAutoBtn'; b.title = 'Automation (presence, receipts, auto-reply)'; b.innerHTML = BOLT;
      b.onclick = open;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
  }

  window.WAAUTO = { init, open };
})();
