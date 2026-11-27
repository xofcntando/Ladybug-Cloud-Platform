/* Ladybug Chat - chatbot flow builder.
   -----------------------------------
   The Automation panel can answer a single keyword. A flow is the next step up: a short
   scripted conversation. "1) Prices  2) Support  3) Talk to a human" - each option moves to
   another step, so a menu can branch without writing any code.

   Flows are stored with the rest of the automation settings (db.data.waBook[botId].auto.flows),
   pushed to the bot over the same autoSet RPC as the rules, and executed inside the bot
   process by lib/bot-shims/flow-engine.js. They survive restarts, redeploys and browser
   changes, and they work while the console is closed.

   Loaded before app.js; app.js calls WAFLOW.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  let flows = [];
  let editing = null; // deep copy of the flow being edited, or null

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M4 5h6v4H4V5zm10 0h6v4h-6V5zM4 15h6v4H4v-4zm10 0h6v4h-6v-4zM9 7h6v1H9V7zm-3 4h12v1H6v-1zm3 4h6v1H9v-1z"/></svg>';

  const MAX_FLOWS = 20, MAX_STEPS = 8, MAX_OPTIONS = 6;

  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }

  const newId = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
  const blank = () => ({ id: newId(), name: '', enabled: true, match: '', exact: false, any: false, cooldownMin: 0, steps: [{ text: '', options: [] }] });

  async function load() {
    const r = await C.api(C.base + '/automation');
    flows = Array.isArray(r.flows) ? r.flows : [];
    return r;
  }

  async function persist(next, msg) {
    const r = await C.api(C.base + '/automation', { method: 'POST', body: { flows: next } });
    flows = (r.saved && r.saved.flows) || next;
    C.toast(msg || (r.applied ? 'Saved and applied' : 'Saved. It applies when the bot starts.'));
    return r;
  }

  /* ------------------------------------------------------------------ rendering */

  function renderStep(step, si, count) {
    const targets = ['<option value="next">next step</option>', '<option value="end">end the flow</option>']
      .concat(step.options.map((o, i) => `<option value="${i}">step ${i + 1}${o.label ? ': ' + esc(o.label).slice(0, 18) : ''}</option>`));
    const opts = step.options.map((o, oi) => {
      const sel = targets.map((t) => {
        const want = String(o.go);
        return t.replace('value="' + want + '"', 'value="' + want + '" selected');
      }).join('');
      return `<div class="wa-flow-opt">
        <span class="wa-flow-num">${oi + 1}</span>
        <input data-olabel="${si}:${oi}" maxlength="40" placeholder="Option label" value="${esc(o.label)}">
        <select data-ogo="${si}:${oi}">${sel}</select>
        <button class="wa-icon-btn" data-delopt="${si}:${oi}" title="Remove option">&#10005;</button>
      </div>`;
    }).join('');
    return `<div class="wa-flow-step" data-si="${si}">
      <div class="wa-flow-step-head"><b>Step ${si + 1}</b>
        ${count > 1 ? `<button class="wa-icon-btn" data-delstep="${si}" title="Remove step">&#10005;</button>` : ''}</div>
      <textarea data-stext="${si}" rows="2" maxlength="500" placeholder="What the bot says at this step">${esc(step.text)}</textarea>
      ${step.options.length ? `<div class="wa-flow-opts">${opts}</div>` : ''}
      ${step.options.length < MAX_OPTIONS ? `<button class="wa-btn ghost sm" data-addopt="${si}">+ Option</button>` : ''}
    </div>`;
  }

  function drawEditor(box) {
    const f = editing;
    const first = f.steps[0];
    const preview = first ? (first.text || '') + (first.options.length ? '\n\n' + first.options.map((o, i) => `${i + 1}) ${o.label || 'option'}`).join('\n') : '') : '';
    box.innerHTML = `
      <div class="wa-gal-head"><h3>${f.__new ? 'New flow' : 'Edit flow'}</h3><button class="wa-icon-btn" data-back title="Back">&#8592;</button></div>
      <div class="wa-flow-form">
        <label class="wa-field"><span>Flow name</span><input id="flName" maxlength="60" placeholder="Pricing menu" value="${esc(f.name)}"></label>
        <label class="wa-field"><span>Trigger keyword</span><input id="flMatch" maxlength="80" placeholder="price, prices, how much" value="${esc(f.match)}"></label>
        <label class="wa-check"><input type="checkbox" id="flExact" ${f.exact ? 'checked' : ''}> Only when the whole message matches</label>
        <label class="wa-check"><input type="checkbox" id="flAny" ${f.any ? 'checked' : ''}> Start on any message (no keyword needed)</label>
        <label class="wa-field inline"><span>Do not restart for</span>
          <select id="flCd">${[0, 15, 60, 180, 720, 1440].map((m) => `<option value="${m}" ${Number(f.cooldownMin) === m ? 'selected' : ''}>${m === 0 ? 'no cooldown' : m < 60 ? m + ' minutes' : (m / 60) + (m === 60 ? ' hour' : ' hours')}</option>`).join('')}</select>
        </label>
        <div class="wa-flow-steps">${f.steps.map((s, i) => renderStep(s, i, f.steps.length)).join('')}</div>
        ${f.steps.length < MAX_STEPS ? '<button class="wa-btn ghost sm" id="flAddStep">+ Step</button>' : ''}
        ${preview ? `<div class="wa-flow-preview"><b>First message</b><pre>${esc(preview)}</pre></div>` : ''}
      </div>
      <div class="wa-dialog-act"><button class="wa-btn ghost" data-back>Cancel</button><button class="wa-btn" id="flSave">Save flow</button></div>`;

    const read = () => {
      f.name = box.querySelector('#flName').value;
      f.match = box.querySelector('#flMatch').value;
      f.exact = box.querySelector('#flExact').checked;
      f.any = box.querySelector('#flAny').checked;
      f.cooldownMin = Number(box.querySelector('#flCd').value) || 0;
      box.querySelectorAll('[data-stext]').forEach((t) => { f.steps[Number(t.dataset.stext)].text = t.value; });
      box.querySelectorAll('[data-olabel]').forEach((i) => {
        const p = i.dataset.olabel.split(':').map(Number);
        f.steps[p[0]].options[p[1]].label = i.value;
      });
      box.querySelectorAll('[data-ogo]').forEach((s) => {
        const p = s.dataset.ogo.split(':').map(Number);
        const v = s.value;
        f.steps[p[0]].options[p[1]].go = v === 'end' || v === 'next' ? v : Number(v);
      });
    };

    box.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => { editing = null; drawList(box); }; });
    box.querySelectorAll('[data-addopt]').forEach((b) => {
      b.onclick = () => { read(); f.steps[Number(b.dataset.addopt)].options.push({ label: '', go: 'next' }); drawEditor(box); };
    });
    box.querySelectorAll('[data-delopt]').forEach((b) => {
      b.onclick = () => {
        read();
        const p = b.dataset.delopt.split(':').map(Number);
        f.steps[p[0]].options.splice(p[1], 1);
        drawEditor(box);
      };
    });
    box.querySelectorAll('[data-delstep]').forEach((b) => {
      b.onclick = () => { read(); f.steps.splice(Number(b.dataset.delstep), 1); drawEditor(box); };
    });
    const add = box.querySelector('#flAddStep');
    if (add) add.onclick = () => { read(); f.steps.push({ text: '', options: [] }); drawEditor(box); };

    box.querySelector('#flSave').onclick = async () => {
      read();
      if (!f.name.trim()) return C.toast('Give the flow a name', 'err');
      if (!f.match.trim() && !f.any) return C.toast('Add a keyword, or turn on "any message"', 'err');
      if (!f.steps.some((s) => (s.text || '').trim() || s.options.length)) return C.toast('Write at least one step', 'err');
      const clean = { id: f.id, name: f.name, enabled: f.enabled, match: f.match, exact: f.exact, any: f.any, cooldownMin: f.cooldownMin, steps: f.steps };
      const next = flows.filter((x) => x.id !== f.id).concat([clean]);
      const btn = box.querySelector('#flSave'); btn.disabled = true; btn.textContent = 'Saving...';
      try { await persist(next, 'Flow saved'); editing = null; drawList(box); }
      catch (e) { C.toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Save flow'; }
    };
  }

  function drawList(box) {
    box.innerHTML = `
      <div class="wa-gal-head"><h3>Chatbot flows <i class="wap-count">${flows.length}</i></h3><button class="wa-icon-btn" data-x title="Close">&#10005;</button></div>
      <p class="wa-note">A flow answers a keyword with a short menu. Each reply moves the conversation to another step, so people can pick their way through without typing full questions.</p>
      <div class="wa-flow-list">${flows.length ? flows.map((f) => `
        <div class="wa-flow-row ${f.enabled === false ? 'off' : ''}">
          <div class="wa-flow-info">
            <b>${esc(f.name)}</b>
            <small>${f.any ? 'any message' : '&ldquo;' + esc(f.match) + '&rdquo;'}${f.exact ? ' (exact)' : ''} &middot; ${f.steps.length} step${f.steps.length === 1 ? '' : 's'}</small>
          </div>
          <label class="wa-switch sm"><input type="checkbox" data-on="${esc(f.id)}" ${f.enabled === false ? '' : 'checked'}><i></i></label>
          <button class="wa-icon-btn" data-edit="${esc(f.id)}" title="Edit">&#9998;</button>
          <button class="wa-icon-btn" data-del="${esc(f.id)}" title="Delete">&#10005;</button>
        </div>`).join('') : '<div class="chat-empty">No flows yet. Create one to answer common questions with a menu.</div>'}</div>
      <div class="wa-dialog-act">${flows.length < MAX_FLOWS ? '<button class="wa-btn" id="flNew">New flow</button>' : '<span class="wa-note">Limit reached</span>'}<button class="wa-btn ghost" data-x>Done</button></div>`;

    box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { const back = box.closest('.wa-dialog-back'); if (back) back.remove(); }; });
    const nw = box.querySelector('#flNew');
    if (nw) nw.onclick = () => { editing = Object.assign(blank(), { __new: true }); drawEditor(box); };
    box.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const f = flows.find((x) => x.id === b.dataset.edit);
        if (f) { editing = JSON.parse(JSON.stringify(f)); drawEditor(box); }
      };
    });
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const f = flows.find((x) => x.id === b.dataset.del);
        if (!f || !confirm('Delete the flow "' + f.name + '"?')) return;
        try { await persist(flows.filter((x) => x.id !== f.id), 'Flow deleted'); drawList(box); }
        catch (e) { C.toast(e.message, 'err'); }
      };
    });
    box.querySelectorAll('[data-on]').forEach((cb) => {
      cb.onchange = async () => {
        const next = flows.map((f) => (f.id === cb.dataset.on ? Object.assign({}, f, { enabled: cb.checked }) : f));
        cb.disabled = true;
        try { await persist(next, cb.checked ? 'Flow on' : 'Flow off'); drawList(box); }
        catch (e) { cb.checked = !cb.checked; cb.disabled = false; C.toast(e.message, 'err'); }
      };
    });
  }

  function open() {
    const d = dlg('<h3>Chatbot flows</h3><div class="chat-empty">Loading...</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-flow-dialog');
    load().then(() => drawList(box)).catch((e) => {
      box.innerHTML = `<div class="wa-gal-head"><h3>Chatbot flows</h3><button class="wa-icon-btn" data-x>&#10005;</button></div><div class="chat-empty">${esc(e.message)}</div>`;
      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
    });
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waFlowBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waFlowBtn'; b.title = 'Chatbot flows (multi-step auto-replies)';
      b.innerHTML = ICON;
      b.onclick = open;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
  }

  window.WAFLOW = { init, open };
})();
