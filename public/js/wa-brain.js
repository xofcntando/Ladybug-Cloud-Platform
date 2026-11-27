/* Ladybug Chat - the built-in brain.
   ---------------------------------
   The AI assistant needs a provider key. This panel does not: you fill in your business once
   (name, hours, prices, payment details, delivery, FAQs) and the bot answers customers from
   it, in the bot process, with no key and no per-message cost.

   The "try it" box runs the exact engine the bot runs, so what you see here is what a
   customer gets - plus the reasoning trace, which shows why an answer was chosen. Anything
   the bot could not answer is listed as a gap; one tap turns a gap into a FAQ.

   Stored in db.data.waBook[botId].auto.brain, pushed to the bot with the same autoSet RPC as
   the other automation settings. Loaded before app.js; app.js calls WABRAIN.init(ctx). */
(function () {
  'use strict';

  let C = null;
  let cfg = null;      // { enabled, profile, escalateAfter, cooldownSec, maxPerHour }
  let gaps = [];
  let busy = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a4 4 0 0 0-4 4v1a4 4 0 0 0-3 3.9V13a4 4 0 0 0 1.2 2.8A4 4 0 0 0 9 22h1v-4a1 1 0 0 1 2 0v4h1a4 4 0 0 0 2.8-6.2A4 4 0 0 0 19 13v-2.1A4 4 0 0 0 16 7V6a4 4 0 0 0-4-4zm-2 4a2 2 0 1 1 4 0v1h-4V6zM8 9h8a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2z"/></svg>';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    const back = C.dialog(html);
    // The brain panel is wider than a standard dialog; let the dialog grow to fit it
    // instead of clipping the panel's left edge.
    const card = back && back.querySelector ? back.querySelector('.wa-dialog') : null;
    if (card) card.classList.add('wa-dialog-brain');
    return back;
  }

  function blank() {
    return {
      enabled: false,
      escalateAfter: 2,
      cooldownSec: 30,
      maxPerHour: 15,
      profile: {
        name: '', about: '', tone: 'friendly', currency: 'USD',
        location: '', phone: '', email: '', website: '',
        payments: '', delivery: '', refunds: '', escalateTo: '',
        hours: null, prices: [], faqs: [],
      },
    };
  }

  function normalise(raw) {
    const b = blank();
    if (!raw || typeof raw !== 'object') return b;
    b.enabled = raw.enabled === true;
    b.escalateAfter = Number(raw.escalateAfter) || 2;
    b.cooldownSec = raw.cooldownSec === 0 ? 0 : (Number(raw.cooldownSec) || 30);
    b.maxPerHour = Number(raw.maxPerHour) || 15;
    const p = raw.profile || {};
    for (const k of Object.keys(b.profile)) if (p[k] !== undefined && p[k] !== null) b.profile[k] = p[k];
    if (!Array.isArray(b.profile.prices)) b.profile.prices = [];
    if (!Array.isArray(b.profile.faqs)) b.profile.faqs = [];
    if (!b.profile.hours) b.profile.hours = null;
    return b;
  }

  async function load() {
    const r = await C.api(C.base + '/brain');
    cfg = normalise(r.brain);
    gaps = Array.isArray(r.gaps) ? r.gaps : [];
    return r;
  }

  /* ------------------------------------------------------------------ rendering */

  function field(label, key, opts) {
    const o = opts || {};
    const v = cfg.profile[key] == null ? '' : cfg.profile[key];
    const tag = o.area
      ? `<textarea class="wa-brain-input" data-p="${key}" rows="${o.rows || 3}" maxlength="${o.max || 400}" placeholder="${esc(o.ph || '')}">${esc(v)}</textarea>`
      : `<input class="wa-brain-input" data-p="${key}" maxlength="${o.max || 120}" placeholder="${esc(o.ph || '')}" value="${esc(v)}">`;
    return `<label class="wa-brain-field"><span>${esc(label)}</span>${tag}</label>`;
  }

  function hoursBlock() {
    const h = cfg.profile.hours;
    const on = !!h;
    const days = h ? h.days : [1, 2, 3, 4, 5];
    const chips = DAYS.map((d, i) => `<button type="button" class="wa-brain-day${days.includes(i) ? ' on' : ''}" data-day="${i}">${d}</button>`).join('');
    return `<div class="wa-brain-card">
      <div class="wa-brain-card-head">
        <b>Opening hours</b>
        <label class="wa-brain-switch"><input type="checkbox" id="bHoursOn"${on ? ' checked' : ''}><span></span></label>
      </div>
      <div id="bHoursBody" style="${on ? '' : 'display:none'}">
        <div class="wa-brain-days">${chips}</div>
        <div class="wa-brain-row2">
          <label class="wa-brain-field"><span>Opens</span><input class="wa-brain-input" id="bOpen" type="time" value="${esc(h ? h.open : '08:00')}"></label>
          <label class="wa-brain-field"><span>Closes</span><input class="wa-brain-input" id="bClose" type="time" value="${esc(h ? h.close : '17:00')}"></label>
          <label class="wa-brain-field"><span>Time zone (hours from UTC)</span><input class="wa-brain-input" id="bTz" type="number" min="-12" max="14" step="0.5" value="${h ? (h.tzOffsetMin / 60) : 2}"></label>
        </div>
        <p class="wa-brain-hint">The bot uses this to answer "are you open now?" correctly.</p>
      </div>
    </div>`;
  }

  function pricesBlock() {
    const rows = cfg.profile.prices.map((r, i) => `<div class="wa-brain-row">
      <input class="wa-brain-input" data-price="${i}:item" maxlength="60" placeholder="Item or service" value="${esc(r.item)}">
      <input class="wa-brain-input wa-brain-amt" data-price="${i}:amount" maxlength="20" placeholder="Amount" value="${esc(r.amount)}">
      <input class="wa-brain-input" data-price="${i}:note" maxlength="60" placeholder="Note (optional)" value="${esc(r.note)}">
      <button type="button" class="wa-icon-btn" data-delprice="${i}" title="Remove">&times;</button>
    </div>`).join('');
    return `<div class="wa-brain-card">
      <div class="wa-brain-card-head"><b>Prices</b><span class="wa-brain-count">${cfg.profile.prices.length}/40</span></div>
      ${rows || '<p class="wa-brain-hint">No prices yet. Add the ones you quote most often - the bot will only ever repeat what you type here.</p>'}
      <button type="button" class="wa-brain-add" id="bAddPrice">+ Add a price</button>
    </div>`;
  }

  function faqsBlock() {
    const rows = cfg.profile.faqs.map((f, i) => `<div class="wa-brain-faq">
      <div class="wa-brain-row">
        <input class="wa-brain-input" data-faq="${i}:q" maxlength="140" placeholder="Question, e.g. Do you deliver to Bulawayo?" value="${esc(f.q)}">
        <button type="button" class="wa-icon-btn" data-delfaq="${i}" title="Remove">&times;</button>
      </div>
      <textarea class="wa-brain-input" data-faq="${i}:a" rows="2" maxlength="600" placeholder="Answer the bot will send">${esc(f.a)}</textarea>
      <input class="wa-brain-input wa-brain-keys" data-faq="${i}:keys" maxlength="120" placeholder="Extra keywords (optional): bulawayo, delivery, out of town" value="${esc(f.keys)}">
    </div>`).join('');
    return `<div class="wa-brain-card">
      <div class="wa-brain-card-head"><b>Questions &amp; answers</b><span class="wa-brain-count">${cfg.profile.faqs.length}/60</span></div>
      ${rows || '<p class="wa-brain-hint">Anything you write here is answered word-for-word. Add the awkward questions you keep retyping.</p>'}
      <button type="button" class="wa-brain-add" id="bAddFaq">+ Add a question</button>
    </div>`;
  }

  function gapsBlock() {
    if (!gaps.length) return '';
    const rows = gaps.slice(0, 8).map((g, i) => `<div class="wa-brain-gap">
      <div class="wa-brain-gap-q">${esc(g.q)}</div>
      <div class="wa-brain-gap-meta">${g.count > 1 ? g.count + ' times \u00b7 ' : ''}${esc(g.intent || 'unknown')}</div>
      <button type="button" class="wa-brain-mini" data-gap="${i}">Turn into a FAQ</button>
    </div>`).join('');
    return `<div class="wa-brain-card">
      <div class="wa-brain-card-head"><b>What the bot could not answer</b><button type="button" class="wa-brain-mini" id="bClearGaps">Clear</button></div>
      ${rows}
      <p class="wa-brain-hint">These are real messages from customers. Answering them makes the bot smarter immediately.</p>
    </div>`;
  }

  function panel() {
    const on = cfg.enabled;
    const p = cfg.profile;
    const ready = !!(p.name || p.about || p.location || p.faqs.length || p.prices.length || p.hours);
    return `<div class="wa-brain">
      <div class="wa-brain-head">
        <div class="wa-brain-title">
          <span class="wa-brain-ico">${ICON}</span>
          <div><b>Ladybug Brain</b><small>Built-in auto-responder \u00b7 no API key needed</small></div>
        </div>
        <label class="wa-brain-switch"><input type="checkbox" id="bOn"${on ? ' checked' : ''}><span></span></label>
      </div>
      ${ready ? '' : '<p class="wa-brain-warn">Fill in at least a business name, an about line, hours or one FAQ before switching the brain on.</p>'}

      <div class="wa-brain-scroll">
        <div class="wa-brain-card">
          <div class="wa-brain-card-head"><b>Your business</b></div>
          ${field('Business name', 'name', { ph: 'e.g. Ladybug Cloud', max: 60 })}
          ${field('What you do (one or two lines)', 'about', { area: true, rows: 3, max: 400, ph: 'We host WhatsApp bots for small businesses in Zimbabwe.' })}
          <div class="wa-brain-row2">
            <label class="wa-brain-field"><span>Tone</span>
              <select class="wa-brain-input" id="bTone">
                <option value="friendly"${p.tone === 'friendly' ? ' selected' : ''}>Friendly</option>
                <option value="professional"${p.tone === 'professional' ? ' selected' : ''}>Professional</option>
                <option value="concise"${p.tone === 'concise' ? ' selected' : ''}>Short and direct</option>
              </select>
            </label>
            ${field('Currency', 'currency', { max: 8, ph: 'USD' })}
          </div>
        </div>

        <div class="wa-brain-card">
          <div class="wa-brain-card-head"><b>Contact &amp; location</b></div>
          ${field('Address or area', 'location', { ph: 'e.g. 12 Samora Machel Ave, Harare' })}
          <div class="wa-brain-row2">
            ${field('Phone / WhatsApp', 'phone', { ph: '+263 77 000 0000' })}
            ${field('Email', 'email', { ph: 'hello@example.com' })}
          </div>
          ${field('Website', 'website', { ph: 'https://example.com' })}
        </div>

        ${hoursBlock()}

        <div class="wa-brain-card">
          <div class="wa-brain-card-head"><b>How you work</b></div>
          ${field('Payment methods', 'payments', { area: true, rows: 2, max: 300, ph: 'EcoCash 0770000000, PayNow, or bank transfer. Payment confirms the order.' })}
          ${field('Delivery / collection', 'delivery', { area: true, rows: 2, max: 300, ph: 'Same-day delivery in Harare (USD 3). 2-3 days nationwide by courier.' })}
          ${field('Refunds & returns', 'refunds', { area: true, rows: 2, max: 300, ph: '7-day refund on unused plans. Faulty items are swapped free.' })}
        </div>

        ${pricesBlock()}
        ${faqsBlock()}

        <div class="wa-brain-card">
          <div class="wa-brain-card-head"><b>Hand-off</b></div>
          ${field('Send difficult chats to', 'escalateTo', { max: 40, ph: 'e.g. Tino (sales)' })}
          <div class="wa-brain-row2">
            <label class="wa-brain-field"><span>Escalate after (unclear replies)</span>
              <input class="wa-brain-input" id="bEsc" type="number" min="1" max="5" value="${cfg.escalateAfter}">
            </label>
            <label class="wa-brain-field"><span>Min seconds between replies</span>
              <input class="wa-brain-input" id="bCool" type="number" min="0" max="3600" value="${cfg.cooldownSec}">
            </label>
          </div>
          <p class="wa-brain-hint">Complaints, angry messages and anyone asking for a human are handed over straight away, whatever the settings say.</p>
        </div>

        <div class="wa-brain-card">
          <div class="wa-brain-card-head"><b>Try it</b><span class="wa-brain-count">uses your saved profile</span></div>
          <div class="wa-brain-row">
            <input class="wa-brain-input" id="bTest" maxlength="500" placeholder="Type a message a customer might send\u2026">
            <button type="button" class="wa-brain-btn" id="bTestGo">Send</button>
          </div>
          <div class="wa-brain-chips">
            <span>No text? See what a media message gets:</span>
            <button type="button" class="wa-brain-chip" data-media="voice">Voice note</button>
            <button type="button" class="wa-brain-chip" data-media="image">Photo</button>
            <button type="button" class="wa-brain-chip" data-media="document">Document</button>
          </div>
          <div id="bTestOut" class="wa-brain-out"></div>
        </div>

        ${gapsBlock()}
      </div>

      <div class="wa-brain-foot">
        <button type="button" class="wa-brain-btn ghost" id="bCancel">Close</button>
        <button type="button" class="wa-brain-btn" id="bSave"${busy ? ' disabled' : ''}>Save</button>
      </div>
    </div>`;
  }

  async function open() {
    // Always refresh on open so the gap list and any edits from another tab are current.
    try {
      await load();
    } catch (e) {
      if (!cfg) { C.toast(e.message || 'Could not load the brain'); return null; }
    }
    const d = dlg(panel());
    wire(d);
    return d;
  }

  /* ------------------------------------------------------------------ state sync */

  function sync(d) {
    const q = (sel) => d.querySelector(sel);
    const on = q('#bOn');
    if (on) cfg.enabled = on.checked;
    d.querySelectorAll('[data-p]').forEach((el) => { cfg.profile[el.dataset.p] = el.value; });
    const tone = q('#bTone'); if (tone) cfg.profile.tone = tone.value;
    const esc2 = q('#bEsc'); if (esc2) cfg.escalateAfter = Number(esc2.value) || 2;
    const cool = q('#bCool'); if (cool) cfg.cooldownSec = Number(cool.value) || 0;
    d.querySelectorAll('[data-price]').forEach((el) => {
      const [i, k] = el.dataset.price.split(':');
      if (cfg.profile.prices[i]) cfg.profile.prices[i][k] = el.value;
    });
    d.querySelectorAll('[data-faq]').forEach((el) => {
      const [i, k] = el.dataset.faq.split(':');
      if (cfg.profile.faqs[i]) cfg.profile.faqs[i][k] = el.value;
    });
    const hOn = q('#bHoursOn');
    if (hOn) {
      if (!hOn.checked) cfg.profile.hours = null;
      else {
        const days = [...d.querySelectorAll('.wa-brain-day.on')].map((b) => Number(b.dataset.day));
        cfg.profile.hours = {
          days: days.length ? days : [1, 2, 3, 4, 5],
          open: (q('#bOpen') || {}).value || '08:00',
          close: (q('#bClose') || {}).value || '17:00',
          tzOffsetMin: Math.round((Number((q('#bTz') || {}).value) || 0) * 60),
        };
      }
    }
  }

  function rerender(d) {
    sync(d);
    const fresh = dlg(panel());
    wire(fresh);
  }

  /* ------------------------------------------------------------------ events */

  function wire(d) {
    const q = (s) => d.querySelector(s);
    const onCancel = () => d.remove();
    const cancel = q('#bCancel'); if (cancel) cancel.onclick = onCancel;

    const save = q('#bSave');
    if (save) save.onclick = async () => {
      sync(d);
      if (cfg.enabled && !(cfg.profile.name || cfg.profile.about || cfg.profile.location || cfg.profile.faqs.length || cfg.profile.prices.length || cfg.profile.hours)) {
        C.toast('Add a business name, an about line, hours or a FAQ first');
        return;
      }
      save.disabled = true;
      try {
        const r = await C.api(C.base + '/automation', { method: 'POST', body: { brain: cfg } });
        cfg = normalise((r.saved && r.saved.brain) || cfg);
        C.toast(r.applied ? 'Saved - the brain is live' : 'Saved. It starts answering when the bot starts.');
        d.remove();
      } catch (e) {
        C.toast(e.message || 'Could not save');
        save.disabled = false;
      }
    };

    const hOn = q('#bHoursOn');
    if (hOn) hOn.onchange = () => {
      const body = q('#bHoursBody');
      if (body) body.style.display = hOn.checked ? '' : 'none';
      if (hOn.checked && !cfg.profile.hours) cfg.profile.hours = { days: [1, 2, 3, 4, 5], open: '08:00', close: '17:00', tzOffsetMin: 120 };
      if (!hOn.checked) cfg.profile.hours = null;
    };

    d.querySelectorAll('.wa-brain-day').forEach((b) => {
      b.onclick = () => b.classList.toggle('on');
    });

    const addPrice = q('#bAddPrice');
    if (addPrice) addPrice.onclick = () => {
      sync(d);
      if (cfg.profile.prices.length >= 40) return C.toast('That is the maximum of 40 prices');
      cfg.profile.prices.push({ item: '', amount: '', note: '' });
      rerender(d);
    };
    d.querySelectorAll('[data-delprice]').forEach((b) => {
      b.onclick = () => { sync(d); cfg.profile.prices.splice(Number(b.dataset.delprice), 1); rerender(d); };
    });

    const addFaq = q('#bAddFaq');
    if (addFaq) addFaq.onclick = () => {
      sync(d);
      if (cfg.profile.faqs.length >= 60) return C.toast('That is the maximum of 60 questions');
      cfg.profile.faqs.push({ q: '', a: '', keys: '' });
      rerender(d);
    };
    d.querySelectorAll('[data-delfaq]').forEach((b) => {
      b.onclick = () => { sync(d); cfg.profile.faqs.splice(Number(b.dataset.delfaq), 1); rerender(d); };
    });

    d.querySelectorAll('[data-gap]').forEach((b) => {
      b.onclick = () => {
        sync(d);
        const g = gaps[Number(b.dataset.gap)];
        if (!g) return;
        if (cfg.profile.faqs.length >= 60) return C.toast('That is the maximum of 60 questions');
        cfg.profile.faqs.push({ q: g.q, a: '', keys: '' });
        C.toast('Added at the bottom - write the answer and save');
        rerender(d);
      };
    });

    const clearGaps = q('#bClearGaps');
    if (clearGaps) clearGaps.onclick = async () => {
      try { await C.api(C.base + '/brain/gaps/clear', { method: 'POST' }); gaps = []; C.toast('Cleared'); } catch (e) { C.toast('Could not clear'); }
      rerender(d);
    };

    const go = q('#bTestGo');
    const input = q('#bTest');
    const out = q('#bTestOut');
    const run = async (media) => {
      const text = (input.value || '').trim();
      if (!text && !media) return;
      sync(d);
      out.innerHTML = '<div class="wa-brain-thinking">Thinking\u2026</div>';
      try {
        const body = media ? { media, profile: cfg.profile } : { text, profile: cfg.profile };
        const r = await C.api(C.base + '/brain/test', { method: 'POST', body });
        const pct = Math.round((r.confidence || 0) * 100);
        const trace = (r.trace || []).map((t) => {
          const bits = Object.keys(t).filter((k) => k !== 'step').map((k) => k + ': ' + (typeof t[k] === 'object' ? JSON.stringify(t[k]) : t[k]));
          return `<li><b>${esc(t.step)}</b> ${esc(bits.join(' \u00b7 '))}</li>`;
        }).join('');
        out.innerHTML = `<div class="wa-brain-bubble">${esc(r.reply).replace(/\n/g, '<br>')}</div>
          <div class="wa-brain-tags">
            <span class="wa-brain-tag">${esc(r.intent)}</span>
            <span class="wa-brain-tag">${pct}% sure</span>
            <span class="wa-brain-tag${r.escalate ? ' warn' : ''}">${esc(r.action)}</span>
            ${r.mood && r.mood !== 'neutral' ? `<span class="wa-brain-tag">${esc(r.mood)}</span>` : ''}
          </div>
          <details class="wa-brain-trace"><summary>Why this answer</summary><ol>${trace}</ol></details>`;
      } catch (e) {
        out.innerHTML = `<div class="wa-brain-err">${esc(e.message || 'Test failed')}</div>`;
      }
    };
    if (go) go.onclick = () => run();
    if (input) input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
    d.querySelectorAll('[data-media]').forEach((b) => { b.onclick = () => run(b.dataset.media); });
  }

  /* ------------------------------------------------------------------ rail */

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    if (!rail || rail.querySelector('[data-rail="brain"]')) return;
    const btn = document.createElement('button');
    btn.className = 'wa-rail-btn';
    btn.dataset.rail = 'brain';
    btn.title = 'Ladybug Brain - built-in auto-responder';
    btn.innerHTML = ICON;
    btn.onclick = () => open();
    const grow = rail.querySelector('.wa-rail-grow');
    if (grow) rail.insertBefore(btn, grow); else rail.appendChild(btn);
  }

  window.WABRAIN = { init, open };
})();
