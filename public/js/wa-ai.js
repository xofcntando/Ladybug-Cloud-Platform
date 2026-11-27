/* Ladybug Chat - AI assistant for the WhatsApp console (bring your own key).
   ------------------------------------------------------------------------
   Three things stock WhatsApp Web cannot do:
     1. Suggest replies for the chat you are reading (three ready-to-send options).
     2. Summarise a long conversation: what was said, what is still open, what was promised.
     3. Rewrite your draft in a chosen tone before you send it.
   Plus voice-note transcription: an "AI text" button on incoming voice notes.

   Everything is opt-in. The key belongs to the account and is stored on the platform; the
   browser never sees it again after saving (the server returns only the last four characters).
   If no key is set the panel shows a short setup form instead of failing silently.

   Loaded before app.js; app.js calls WAAI.init(ctx) when the console is on screen. */
(function () {
  'use strict';

  let C = null;
  let cfg = null; // { configured, baseUrl, model, keyMask }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SPARK = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm6.5 11l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z"/></svg>';

  const TONES = ['shorter', 'friendlier', 'more formal', 'more apologetic', 'more confident'];

  /* One panel at a time, same rule the rest of the console follows. */
  function dlg(html) {
    document.querySelectorAll('#waApp > .wa-dialog-back').forEach((n) => n.remove());
    return C.dialog(html);
  }

  const chatName = () => {
    const c = (C.S.chats || []).find((x) => x.jid === C.S.jid);
    return (c && c.name) || C.S.jid || 'this chat';
  };

  /* ------------------------------------------------------------------ settings form */

  function settingsBlock() {
    if (cfg && cfg.configured) {
      return `<section class="wa-ai-sec">
        <div class="wa-ai-provider">
          <div><b>${esc(cfg.model)}</b><small>${esc(cfg.baseUrl)} &middot; key ${esc(cfg.keyMask)}</small></div>
          <button class="wa-btn ghost sm" id="aiEdit">Change</button>
        </div>
        <p class="wa-note">Requests go straight from this server to your provider. Message text is only sent when you press a button below.</p>
      </section>`;
    }
    return `<section class="wa-ai-sec">
      <h4>Connect a provider</h4>
      <p class="wa-note">Ladybug does not ship an AI key. Paste your own OpenAI-compatible provider and the console will use it for this account only.</p>
      <label class="wa-field"><span>Base URL</span><input id="aiUrl" placeholder="https://api.openai.com/v1" value="${esc((cfg && cfg.baseUrl) || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="wa-field"><span>Model</span><input id="aiModel" placeholder="gpt-4o-mini" value="${esc((cfg && cfg.model) || '')}" autocomplete="off" spellcheck="false"></label>
      <label class="wa-field"><span>API key</span><input id="aiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false"></label>
      <div class="wa-ai-act"><button class="wa-btn" id="aiSave">Save provider</button>${cfg && cfg.configured ? '<button class="wa-btn ghost" id="aiRemove">Remove key</button>' : ''}</div>
      <p class="wa-note">Works with OpenAI, Groq, Together, OpenRouter, Fireworks, vLLM, LM Studio and anything else that speaks <code>/chat/completions</code>. https is required; http is allowed only for a local model on 127.0.0.1.</p>
    </section>`;
  }

  function wireSettings(box, redraw) {
    const save = async () => {
      const body = {
        baseUrl: (box.querySelector('#aiUrl') || {}).value || '',
        model: (box.querySelector('#aiModel') || {}).value || '',
        apiKey: (box.querySelector('#aiKey') || {}).value || '',
      };
      const btn = box.querySelector('#aiSave');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
      try {
        cfg = await C.api('/api/ai/settings', { method: 'POST', body });
        C.toast(cfg.configured ? 'AI provider saved' : 'Saved');
        redraw();
      } catch (e) {
        C.toast(e.message, 'err');
        if (btn) { btn.disabled = false; btn.textContent = 'Save provider'; }
      }
    };
    const s = box.querySelector('#aiSave'); if (s) s.onclick = save;
    const e2 = box.querySelector('#aiEdit'); if (e2) e2.onclick = () => { cfg = Object.assign({}, cfg, { configured: false }); redraw(); };
    const r = box.querySelector('#aiRemove');
    if (r) r.onclick = async () => {
      if (!confirm('Remove the saved AI key? The AI buttons stop working until you add it again.')) return;
      try { cfg = await C.api('/api/ai/settings', { method: 'POST', body: { clear: true } }); C.toast('Key removed'); redraw(); }
      catch (e) { C.toast(e.message, 'err'); }
    };
  }

  /* ------------------------------------------------------------------ actions */

  function insertDraft(text) {
    const ta = document.getElementById('waText');
    if (!ta) return C.toast('Open a chat first', 'err');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    C.toast('Added to your message box');
  }

  async function run(box, action, extra) {
    const body = Object.assign({ action, jid: C.S.jid }, extra || {});
    return C.api(C.base + '/ai', { method: 'POST', body });
  }

  function open() {
    const d = dlg('<h3>AI assistant</h3><div class="chat-empty">Loading...</div>');
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-ai-dialog');

    const draw = () => {
      const hasChat = !!C.S.jid;
      box.innerHTML = `
        <div class="wa-gal-head"><h3>AI assistant</h3><button class="wa-icon-btn" data-x title="Close">&#10005;</button></div>
        ${settingsBlock()}
        ${cfg && cfg.configured ? `<section class="wa-ai-sec">
          <h4>This chat ${hasChat ? '<span class="wap-count">' + esc(chatName()) + '</span>' : ''}</h4>
          ${hasChat ? '' : '<p class="wa-note bad">Open a conversation to use these.</p>'}
          <div class="wa-ai-act">
            <button class="wa-btn" id="aiReply" ${hasChat ? '' : 'disabled'}>Suggest replies</button>
            <button class="wa-btn ghost" id="aiSum" ${hasChat ? '' : 'disabled'}>Summarise chat</button>
          </div>
          <div class="wa-ai-out" id="aiOut"></div>
          <div class="wa-ai-rewrite">
            <label class="wa-field inline"><span>Rewrite my draft</span>
              <select id="aiTone">${TONES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
            </label>
            <button class="wa-btn ghost sm" id="aiRw">Rewrite</button>
          </div>
          <p class="wa-note">Only the messages in this chat are sent, and only when you press one of these buttons.</p>
        </section>` : ''}
        <div class="wa-dialog-act"><button class="wa-btn" data-x>Done</button></div>`;

      box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      wireSettings(box, draw);

      const out = box.querySelector('#aiOut');
      const busy = (btn, label) => { if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = label; } };
      const done = (btn) => { if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || btn.textContent; } };

      const rep = box.querySelector('#aiReply');
      if (rep) rep.onclick = async () => {
        busy(rep, 'Thinking...');
        out.innerHTML = '<div class="wa-ai-wait">Writing suggestions...</div>';
        try {
          const r = await run(box, 'reply', { count: 3 });
          out.innerHTML = `<div class="wa-ai-label">Tap one to put it in the message box</div>` +
            r.replies.map((t) => `<button class="wa-ai-chip" data-t="${esc(t)}">${esc(t)}</button>`).join('') +
            `<div class="wa-ai-meta">${esc(r.model || '')}${r.sampled ? ' &middot; ' + r.sampled + ' messages read' : ''}</div>`;
          out.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => insertDraft(b.dataset.t); });
        } catch (e) { out.innerHTML = `<div class="wa-ai-err">${esc(e.message)}</div>`; }
        done(rep);
      };

      const sum = box.querySelector('#aiSum');
      if (sum) sum.onclick = async () => {
        busy(sum, 'Reading...');
        out.innerHTML = '<div class="wa-ai-wait">Summarising...</div>';
        try {
          const r = await run(box, 'summarize');
          out.innerHTML = `<div class="wa-ai-sum">${esc(r.text).replace(/\n/g, '<br>')}</div>
            <div class="wa-ai-act"><button class="wa-btn ghost sm" id="aiCopy">Copy</button></div>
            <div class="wa-ai-meta">${esc(r.model || '')}${r.sampled ? ' &middot; ' + r.sampled + ' messages read' : ''}</div>`;
          const cp = out.querySelector('#aiCopy');
          if (cp) cp.onclick = () => { navigator.clipboard.writeText(r.text).then(() => C.toast('Copied'), () => C.toast('Copy failed', 'err')); };
        } catch (e) { out.innerHTML = `<div class="wa-ai-err">${esc(e.message)}</div>`; }
        done(sum);
      };

      const rw = box.querySelector('#aiRw');
      if (rw) rw.onclick = async () => {
        const ta = document.getElementById('waText');
        const text = ta ? ta.value.trim() : '';
        if (!text) return C.toast('Type a draft in the message box first', 'err');
        busy(rw, 'Rewriting...');
        try {
          const r = await run(box, 'rewrite', { text, tone: box.querySelector('#aiTone').value });
          out.innerHTML = `<div class="wa-ai-label">${esc(r.tone)}</div><div class="wa-ai-sum">${esc(r.text).replace(/\n/g, '<br>')}</div>
            <div class="wa-ai-act"><button class="wa-btn sm" id="aiUse">Use this</button></div>`;
          out.querySelector('#aiUse').onclick = () => insertDraft(r.text);
        } catch (e) { out.innerHTML = `<div class="wa-ai-err">${esc(e.message)}</div>`; }
        done(rw);
      };
    };

    C.api('/api/ai/settings').then((r) => { cfg = r; draw(); })
      .catch((e) => { box.innerHTML = `<div class="wa-gal-head"><h3>AI assistant</h3><button class="wa-icon-btn" data-x>&#10005;</button></div><div class="chat-empty">${esc(e.message)}</div>`; box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); }); });
  }

  /* ------------------------------------------------------------------ voice transcription */

  function transcribe(id) {
    const m = (C.S.msgs || []).find((x) => x.id === id);
    if (!m) return C.toast('That voice note is no longer in view', 'err');
    const d = dlg(`<h3>Transcribe voice note</h3><div class="chat-empty">Fetching the audio...</div>`);
    const box = d.querySelector('.wa-dialog');
    box.classList.add('wa-ai-dialog');
    (async () => {
      try {
        const media = await C.api(`${C.base}/media?jid=${encodeURIComponent(C.S.jid)}&id=${encodeURIComponent(id)}`);
        const data = media && (media.data || media.base64);
        if (!data) throw new Error('This voice note could not be downloaded (it may have expired).');
        box.innerHTML = `<div class="wa-gal-head"><h3>Transcribe voice note</h3><button class="wa-icon-btn" data-x>&#10005;</button></div><div class="chat-empty">Listening...</div>`;
        box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
        const r = await C.api(C.base + '/ai', { method: 'POST', body: { action: 'transcribe', data, mime: (media && media.mime) || 'audio/ogg', name: 'voice.ogg' } });
        box.innerHTML = `<div class="wa-gal-head"><h3>Transcribe voice note</h3><button class="wa-icon-btn" data-x>&#10005;</button></div>
          <div class="wa-ai-sum">${esc(r.text).replace(/\n/g, '<br>')}</div>
          <div class="wa-dialog-act"><button class="wa-btn ghost" id="aiTrCopy">Copy</button><button class="wa-btn" data-x>Done</button></div>
          <div class="wa-ai-meta">${esc(r.model || '')}</div>`;
        box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
        box.querySelector('#aiTrCopy').onclick = () => navigator.clipboard.writeText(r.text).then(() => C.toast('Copied'), () => C.toast('Copy failed', 'err'));
      } catch (e) {
        box.innerHTML = `<div class="wa-gal-head"><h3>Transcribe voice note</h3><button class="wa-icon-btn" data-x>&#10005;</button></div><div class="wa-ai-err">${esc(e.message)}</div>`;
        box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => d.remove(); });
      }
    })();
  }

  /** Adds the "AI text" button under incoming voice notes, and keeps it out of the way otherwise. */
  function decorate(root) {
    if (!root || !cfg || !cfg.configured) return;
    root.querySelectorAll('.wa-voice[data-voice]').forEach((el) => {
      if (el.querySelector('.wa-ai-tr')) return;
      const id = el.dataset.voice;
      const m = (C.S.msgs || []).find((x) => x.id === id);
      if (!m || m.fromMe) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wa-ai-tr';
      b.title = 'Transcribe this voice note with your AI provider';
      b.textContent = 'AI text';
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); transcribe(id); };
      el.appendChild(b);
    });
  }

  function init(ctx) {
    C = ctx;
    const rail = document.querySelector('.wa-rail');
    if (rail && !document.getElementById('waAiBtn')) {
      const b = document.createElement('button');
      b.className = 'wa-rail-btn'; b.id = 'waAiBtn'; b.title = 'AI assistant (replies, summary, rewrite, transcription)';
      b.innerHTML = SPARK;
      b.onclick = open;
      rail.insertBefore(b, rail.querySelector('.wa-rail-grow'));
    }
    // Refresh the cached settings once, so voice bubbles can be decorated without opening the panel.
    C.api('/api/ai/settings').then((r) => { cfg = r; decorate(document.getElementById('waThread')); }).catch(() => {});
    if (window.WAX && typeof window.WAX.afterPaint === 'function') {
      const after = window.WAX.afterPaint;
      window.WAX.afterPaint = function (root) { try { after.apply(this, arguments); } catch (e) { /* ignore */ } decorate(root); };
    }
  }

  window.WAAI = { init, open, transcribe, decorate };
})();
