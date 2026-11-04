/* Ladybug Chat - console extras: themes, voice notes, formatting, emoji, quick replies,
   message search, drafts, @mentions, chat export, keyboard shortcuts.
   Loaded after app.js. app.js calls WAX.init(ctx) once the console is on screen. */
(function () {
  'use strict';

  const LOOK_KEY = 'wa_look';
  const QUICK_KEY = 'wa_quick';
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };

  /* ================================================================ themes */
  const D = (o) => Object.assign({ mode: 'dark', doodle: 0.04, banner: o.panel }, o);
  const L = (o) => Object.assign({ mode: 'light', doodle: 0.06, banner: o.panel }, o);
  const THEMES = {
    dark: D({ name: 'Midnight', bg: '#111b21', panel: '#202c33', panel2: '#2a3942', hover: '#202c33', active: '#2a3942', line: '#222d34', text: '#e9edef', muted: '#8696a0', accent: '#00a884', accent2: '#25d366', in: '#202c33', out: '#005c4b', chat: '#0b141a', rail: '#111b21', link: '#53bdeb', banner: '#1d282f' }),
    light: L({ name: 'Daylight', bg: '#ffffff', panel: '#f0f2f5', panel2: '#f0f2f5', hover: '#f5f6f6', active: '#f0f2f5', line: '#e9edef', text: '#111b21', muted: '#667781', accent: '#00a884', accent2: '#25d366', in: '#ffffff', out: '#d9fdd3', chat: '#efeae2', rail: '#f0f2f5', link: '#027eb5', banner: '#f7f8fa' }),
    amoled: D({ name: 'AMOLED', bg: '#000000', panel: '#101012', panel2: '#1b1b1e', hover: '#101012', active: '#1c1c1f', line: '#1a1a1d', text: '#f2f2f3', muted: '#8b8b92', accent: '#00c389', accent2: '#2be58e', in: '#151517', out: '#00634a', chat: '#000000', rail: '#000000', link: '#5bc0ff', banner: '#101012', doodle: 0.03 }),
    ladybug: D({ name: 'Ladybug', bg: '#1a0d10', panel: '#2a1519', panel2: '#3a1d23', hover: '#2a1519', active: '#3a1d23', line: '#34191e', text: '#fbeeee', muted: '#b6898f', accent: '#ff4d4d', accent2: '#ff7a6b', in: '#2a1519', out: '#8f1d2c', chat: '#12080a', rail: '#1a0d10', link: '#ff9a8f', banner: '#241216' }),
    ocean: D({ name: 'Ocean', bg: '#0b1a26', panel: '#112636', panel2: '#19364b', hover: '#112636', active: '#19364b', line: '#16303f', text: '#e6f1f8', muted: '#7fa0b5', accent: '#1da1f2', accent2: '#4cc2ff', in: '#112636', out: '#0b5c8f', chat: '#08131c', rail: '#0b1a26', link: '#6fd0ff', banner: '#0f2231' }),
    forest: D({ name: 'Forest', bg: '#0f1a14', panel: '#16261d', panel2: '#1f3629', hover: '#16261d', active: '#1f3629', line: '#1b2f23', text: '#e8f2ea', muted: '#86a592', accent: '#3fb56a', accent2: '#6fe09a', in: '#16261d', out: '#1f6b40', chat: '#0a120d', rail: '#0f1a14', link: '#8be3ac', banner: '#13211a' }),
    violet: D({ name: 'Violet', bg: '#171326', panel: '#221c38', panel2: '#2e2650', hover: '#221c38', active: '#2e2650', line: '#2a2347', text: '#efeaff', muted: '#9a90c0', accent: '#8b5cf6', accent2: '#b197ff', in: '#221c38', out: '#5b34c7', chat: '#100d1d', rail: '#171326', link: '#b8a4ff', banner: '#1d1832' }),
    graphite: D({ name: 'Graphite', bg: '#17181c', panel: '#222429', panel2: '#2c2f36', hover: '#222429', active: '#2c2f36', line: '#2a2d33', text: '#eceef2', muted: '#8d93a0', accent: '#7c8cff', accent2: '#a3afff', in: '#222429', out: '#3b4470', chat: '#101114', rail: '#17181c', link: '#a3afff', banner: '#1d1f24' }),
    sunset: L({ name: 'Sunset', bg: '#fffaf5', panel: '#fdeee0', panel2: '#f9e3d0', hover: '#fff3e8', active: '#f9e3d0', line: '#f3dfcf', text: '#3b2418', muted: '#8f6f5c', accent: '#f2711c', accent2: '#ff9a4d', in: '#ffffff', out: '#ffd9b8', chat: '#fbeadb', rail: '#fdeee0', link: '#c2410c', banner: '#fff3e8' }),
    mint: L({ name: 'Mint', bg: '#fcfffd', panel: '#eaf6f0', panel2: '#dcefe6', hover: '#f2faf6', active: '#dcefe6', line: '#d8eadf', text: '#10261c', muted: '#5f7f70', accent: '#0f9d75', accent2: '#2cc395', in: '#ffffff', out: '#c9f2df', chat: '#e3f0ea', rail: '#eaf6f0', link: '#0b7a5a', banner: '#f2faf6' }),
    rose: L({ name: 'Rose', bg: '#fffafb', panel: '#fdeef2', panel2: '#fadde6', hover: '#fff2f5', active: '#fadde6', line: '#f6dfe6', text: '#3a1722', muted: '#946777', accent: '#e11d68', accent2: '#fb5a92', in: '#ffffff', out: '#ffd3e1', chat: '#f9e6ec', rail: '#fdeef2', link: '#be185d', banner: '#fff2f5' }),
  };
  const WALLPAPERS = {
    doodle: { name: 'Doodle', css: null },
    plain: { name: 'Plain', css: null, noDoodle: true },
    dots: { name: 'Dots', css: 'radial-gradient(circle, rgba(128,128,128,.22) 1.3px, transparent 1.8px)', size: '22px 22px' },
    aurora: { name: 'Aurora', css: 'linear-gradient(135deg, rgba(0,210,170,.28), rgba(80,90,255,.24) 55%, rgba(255,80,160,.2))' },
    dusk: { name: 'Dusk', css: 'linear-gradient(160deg, rgba(255,150,80,.26), rgba(130,60,210,.3))' },
    ember: { name: 'Ember', css: 'radial-gradient(circle at 20% 10%, rgba(255,90,60,.3), transparent 55%), radial-gradient(circle at 85% 90%, rgba(255,190,60,.22), transparent 50%)' },
    lagoon: { name: 'Lagoon', css: 'radial-gradient(circle at 80% 15%, rgba(40,200,255,.28), transparent 55%), radial-gradient(circle at 10% 90%, rgba(40,255,170,.2), transparent 55%)' },
    custom: { name: 'My photo', css: null },
  };
  const DEFAULT_LOOK = { theme: 'dark', system: false, accent: '', outBubble: '', inBubble: '', wallpaper: 'doodle', wpImage: '', wpDim: 35, font: 14.2, radius: 8, compact: false, enterSends: true, sounds: true };
  let look = Object.assign({}, DEFAULT_LOOK, store.get(LOOK_KEY, null) || (() => {
    // first run: keep whatever the old light/dark switch had
    try { return localStorage.getItem('wa_theme') === 'light' ? { theme: 'light' } : {}; } catch (e) { return {}; }
  })());
  if (!THEMES[look.theme]) look.theme = 'dark';
  if (!WALLPAPERS[look.wallpaper]) look.wallpaper = 'doodle';

  const hexOk = (h) => /^#[0-9a-f]{6}$/i.test(h || '');
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(n >> 16) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
  const mix = (hex, to, k) => { const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16); const ch = (s) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k); return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join(''); };
  const sysDark = () => !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);

  function effectiveThemeId() {
    if (look.system) return sysDark() ? 'dark' : 'light';
    return look.theme;
  }

  function applyLook(app) {
    app = app || document.getElementById('waApp');
    if (!app) return;
    const t = THEMES[effectiveThemeId()];
    const set = (k, v) => app.style.setProperty(k, v);
    const unset = (k) => app.style.removeProperty(k);
    app.dataset.theme = t.mode;
    app.dataset.look = effectiveThemeId();
    const map = { bg: '--wa-bg', panel: '--wa-panel', panel2: '--wa-panel-2', hover: '--wa-hover', active: '--wa-active', line: '--wa-line', text: '--wa-text', muted: '--wa-muted', accent: '--wa-accent', accent2: '--wa-accent-2', in: '--wa-in', out: '--wa-out', chat: '--wa-chat-bg', rail: '--wa-rail', link: '--wa-link', banner: '--wa-banner' };
    for (const k in map) set(map[k], t[k]);
    let accent = t.accent, accent2 = t.accent2;
    if (hexOk(look.accent)) { accent = look.accent; accent2 = mix(look.accent, '#ffffff', t.mode === 'dark' ? 0.28 : 0.1); set('--wa-accent', accent); set('--wa-accent-2', accent2); }
    set('--wa-accent-ink', lum(accent2) > 0.4 ? '#0b141a' : '#ffffff');
    const bubble = (hex, v, ink) => {
      if (hexOk(hex)) { set(v, hex); set(ink, lum(hex) > 0.42 ? '#111b21' : '#ffffff'); } else unset(ink);
    };
    bubble(look.outBubble, '--wa-out', '--wa-out-ink');
    bubble(look.inBubble, '--wa-in', '--wa-in-ink');
    // wallpaper
    const wp = WALLPAPERS[look.wallpaper] || WALLPAPERS.doodle;
    set('--wa-doodle', look.wallpaper === 'doodle' ? t.doodle : 0);
    if (look.wallpaper === 'custom' && look.wpImage) {
      const dim = Math.max(0, Math.min(80, +look.wpDim || 0)) / 100;
      set('--wa-wp', `linear-gradient(rgba(0,0,0,${t.mode === 'dark' ? dim : dim / 2}), rgba(0,0,0,${t.mode === 'dark' ? dim : dim / 2})), url("${look.wpImage}")`);
      set('--wa-wp-size', 'cover');
    } else if (wp.css) { set('--wa-wp', wp.css); set('--wa-wp-size', wp.size || 'cover'); } else { unset('--wa-wp'); unset('--wa-wp-size'); }
    set('--wa-msg-size', (+look.font || 14.2) + 'px');
    set('--wa-radius', (+look.radius >= 0 ? +look.radius : 8) + 'px');
    app.classList.toggle('wa-compact', !!look.compact);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
  }
  function saveLook() { store.set(LOOK_KEY, look); }

  if (window.matchMedia) {
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (look.system) applyLook(); }); } catch (e) { /* old browser */ }
  }

  /* ================================================================ text formatting */
  // *bold* _italic_ ~strike~ `mono` ```block``` and links, applied to text that is ALREADY html-escaped.
  function fmt(safe) {
    const hold = [];
    const keep = (html) => { hold.push(html); return '\u0000' + (hold.length - 1) + '\u0000'; };
    let s = String(safe);
    s = s.replace(/```([\s\S]+?)```/g, (_, c) => keep('<pre class="wa-code">' + c.replace(/^\n|\n$/g, '') + '</pre>'));
    s = s.replace(/`([^`\n]+)`/g, (_, c) => keep('<code class="wa-mono">' + c + '</code>'));
    s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/gi, (u) => keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer nofollow">' + u + '</a>'));
    s = s.replace(/@(\d{6,15})\b/g, (_, n) => keep('<span class="wa-mention">@' + n + '</span>'));
    const wrap = (ch, tag) => {
      const e = ch.replace(/[*_~]/g, '\\$&');
      const re = new RegExp('(^|[\\s(>\\u0000])' + e + '(?=\\S)([^' + e + '\\n]*?\\S)' + e + '(?=$|[\\s).,!?:;<\\u0000])', 'g');
      s = s.replace(re, (_, pre, inner) => pre + '<' + tag + '>' + inner + '</' + tag + '>');
    };
    wrap('*', 'strong'); wrap('_', 'em'); wrap('~', 'del');
    s = s.replace(/\n/g, '<br>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => hold[+i]);
  }

  /* ================================================================ emoji */
  const EMOJI = {
    '🕑': 'Recent',
    '😀': '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖',
    '👍': '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💅 💪 🦾 👏 🙌 👐 🤲 🫶 🫡 🫰 🫵 🙋 🙇 🤦 🤷 💁 🙅 🙆 🚶 🏃 💃 🕺',
    '❤️': '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 😻 💋 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🏆 🥇 🎁',
    '🐞': '🐞 🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🦆 🦅 🦉 🦋 🐝 🐛 🐌 🐢 🐍 🐙 🦀 🐠 🐬 🐳 🦈 🌹 🌷 🌻 🌸 🌼 🌳 🌴 🍀 🍁 🌍 🌙 ☀️ ⛅ 🌈 ❄️',
    '🍕': '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🥕 🥔 🍞 🧀 🍳 🥞 🥓 🍔 🍟 🍕 🌭 🌮 🌯 🍝 🍜 🍣 🍤 🍦 🍩 🍪 🎂 🍰 🍫 🍬 ☕ 🍵 🍺 🍻 🥂 🍷 🥤',
    '⚽': '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🎯 🎮 🎲 🎧 🎤 🎸 🎹 🥁 🎬 📷 🚗 🚕 🚌 🏍️ ✈️ 🚀 🚢 🏠 🏢 ⏰ 📱 💻 🖥️ 📞 💡 🔑 🔒 💰 💳 📦 📌 📎 ✏️ 📚',
    '✅': '✅ ❌ ⭕ ❗ ❓ ‼️ ⚠️ 🚫 ✔️ ☑️ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔄 🔔 🔕 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🆗 🆕 🆒 🔝 ℹ️ ©️ ®️ ™️',
  };
  const recentEmoji = () => store.get('wa_recent_emoji', []);
  function buildEmoji(pop, onPick) {
    pop.classList.add('wa-emoji-big');
    pop.innerHTML = '<div class="wa-emoji-tabs"></div><div class="wa-emoji-grid"></div>';
    const tabs = pop.querySelector('.wa-emoji-tabs'), grid = pop.querySelector('.wa-emoji-grid');
    let cur = recentEmoji().length ? '🕑' : '😀';
    const draw = () => {
      tabs.innerHTML = Object.keys(EMOJI).map((k) => `<button type="button" data-cat="${k}" class="${k === cur ? 'on' : ''}">${k}</button>`).join('');
      const list = cur === '🕑' ? recentEmoji() : EMOJI[cur].split(' ');
      grid.innerHTML = list.length ? list.map((e) => `<button type="button" data-e="${e}">${e}</button>`).join('') : '<div class="wa-emoji-none">Emoji you use show up here</div>';
    };
    pop.onclick = (e) => {
      e.stopPropagation();
      const c = e.target.closest('[data-cat]');
      if (c) { cur = c.dataset.cat; draw(); return; }
      const b = e.target.closest('[data-e]');
      if (!b) return;
      const em = b.dataset.e;
      store.set('wa_recent_emoji', [em, ...recentEmoji().filter((x) => x !== em)].slice(0, 28));
      onPick(em);
    };
    draw();
    return draw;
  }

  /* ================================================================ voice notes: player */
  const ICON = {
    play: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm6-4a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.9V22h2v-3.1A8 8 0 0 0 20 11z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M1.1 21.8 23 12 1.1 2.2 1 9.8 16 12 1 14.2z"/></svg>',
    palette: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 3a9 9 0 0 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1.100.9-2 2-2h2.400A4.600 4.600 0 0 0 22 10c0-4-4.500-7-10-7zM6.500 12a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3zm3-4a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3zm5 0a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3zm3 4a1.500 1.500 0 1 1 0-3 1.500 1.500 0 0 1 0 3z"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M11 21h-1l1-7H7.500c-.6 0-.6-.3-.4-.7L13 3h1l-1 7h3.500c.5 0 .6.300.4.700z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M15.500 14h-.8l-.3-.3A6.500 6.500 0 1 0 14 15.500l.3.300v.8l5 5 1.500-1.500zm-6 0a4.500 4.500 0 1 1 0-9 4.500 4.500 0 0 1 0 9z"/></svg>',
    kbd: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm-9 3h2v2h-2zm0 3h2v2h-2zM8 8h2v2H8zm0 3h2v2H8zM6 14h12v2H6zm10-3h2v2h-2zm0-3h2v2h-2z"/></svg>',
    fmt: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M9 4v3h2.200l-2.400 10H6v3h8v-3h-2.200l2.400-10H17V4z"/></svg>',
  };
  const players = new Map(); // message id -> { audio, speed } (kept outside the DOM so a repaint never cuts playback)
  const BARS = 34;
  function barsFor(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    const out = [];
    for (let i = 0; i < BARS; i++) { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; out.push(0.22 + ((h >>> 0) % 100) / 100 * 0.78); }
    return out;
  }
  const fmtT = (sec) => { sec = Math.max(0, Math.round(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); };
  const durOf = (m, pl) => (pl && isFinite(pl.audio.duration) && pl.audio.duration > 0 ? pl.audio.duration : (m.media && m.media.seconds) || 0);

  function voiceHtml(m) {
    const pl = players.get(m.id);
    const dur = durOf(m, pl);
    const cur = pl ? pl.audio.currentTime : 0;
    const playing = !!(pl && !pl.audio.paused);
    const on = dur ? Math.round((cur / dur) * BARS) : 0;
    const bars = barsFor(m.id).map((h, i) => `<i class="${i < on ? 'on' : ''}" style="height:${Math.round(h * 100)}%"></i>`).join('');
    return `<div class="wa-voice${playing ? ' playing' : ''}${m._loading ? ' loading' : ''}" data-voice="${escH(m.id)}">` +
      `<button type="button" class="wa-vplay" aria-label="${playing ? 'Pause' : 'Play'} voice message">${m._loading ? '<span class="wa-vspin"></span>' : playing ? ICON.pause : ICON.play}</button>` +
      `<div class="wa-vwave" data-seek>${bars}</div>` +
      `<div class="wa-vside"><span class="wa-vtime">${fmtT(playing || cur ? cur : dur)}</span><button type="button" class="wa-vspeed" title="Playback speed">${(pl && pl.speed) || 1}×</button></div></div>`;
  }
  function refreshVoice(id) {
    const el = document.querySelector('.wa-voice[data-voice="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    const pl = players.get(id);
    if (!el || !pl) return;
    const m = (CTX && CTX.S.msgs.find((x) => x.id === id)) || {};
    const dur = durOf(m, pl);
    const playing = !pl.audio.paused;
    el.classList.toggle('playing', playing);
    const btn = el.querySelector('.wa-vplay');
    btn.innerHTML = playing ? ICON.pause : ICON.play;
    const on = dur ? Math.round((pl.audio.currentTime / dur) * BARS) : 0;
    el.querySelectorAll('.wa-vwave i').forEach((b, i) => b.classList.toggle('on', i < on));
    el.querySelector('.wa-vtime').textContent = fmtT(playing || pl.audio.currentTime ? pl.audio.currentTime : dur);
  }
  function makePlayer(id, src) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    const pl = { audio, speed: 1 };
    const r = () => refreshVoice(id);
    ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange'].forEach((ev) => audio.addEventListener(ev, r));
    audio.addEventListener('ended', () => { audio.currentTime = 0; r(); });
    audio.addEventListener('error', () => { CTX && CTX.toast('This browser cannot play that voice note', 'err'); players.delete(id); });
    players.set(id, pl);
    return pl;
  }
  async function toggleVoice(id) {
    const m = CTX.S.msgs.find((x) => x.id === id);
    if (!m) return;
    let pl = players.get(id);
    if (!pl) {
      let got = CTX.MEDIA[id];
      if (!got) { await CTX.fetchMedia(m); got = CTX.MEDIA[id]; }
      if (!got) return;
      pl = players.get(id) || makePlayer(id, got.data);
    }
    if (pl.audio.paused) {
      players.forEach((o, k) => { if (k !== id && !o.audio.paused) { o.audio.pause(); } });
      pl.audio.playbackRate = pl.speed;
      try { await pl.audio.play(); } catch (e) { CTX.toast('Could not play that voice note', 'err'); }
    } else pl.audio.pause();
    refreshVoice(id);
  }
  function wireVoice(root) {
    root.querySelectorAll('.wa-voice[data-voice]').forEach((el) => {
      const id = el.dataset.voice;
      el.querySelector('.wa-vplay').onclick = (e) => { e.stopPropagation(); toggleVoice(id); };
      el.querySelector('.wa-vspeed').onclick = (e) => {
        e.stopPropagation();
        const pl = players.get(id);
        if (!pl) return CTX.toast('Press play first, then change the speed');
        pl.speed = pl.speed === 1 ? 1.5 : pl.speed === 1.5 ? 2 : 1;
        pl.audio.playbackRate = pl.speed;
        e.currentTarget.textContent = pl.speed + '×';
      };
      el.querySelector('[data-seek]').onclick = (e) => {
        const pl = players.get(id);
        if (!pl || !isFinite(pl.audio.duration)) return toggleVoice(id);
        const r = e.currentTarget.getBoundingClientRect();
        pl.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * pl.audio.duration;
        refreshVoice(id);
      };
    });
  }

  /* ================================================================ voice notes: recorder */
  let REC = null;
  const MAX_REC_S = 300;
  function recMime() {
    if (!window.MediaRecorder) return null;
    return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }
  function toDataUrl(blob) {
    return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(new Error('Could not read the recording')); f.readAsDataURL(blob); });
  }
  async function startRecording() {
    if (REC || !CTX || !CTX.S.jid) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || recMime() === null) return CTX.toast('This browser cannot record audio. Try Chrome, Edge, Firefox or Safari 14.1+ over https.', 'err');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { return CTX.toast(e && e.name === 'NotFoundError' ? 'No microphone found' : 'Microphone blocked. Allow it from the lock icon in the address bar.', 'err'); }
    const mime = recMime();
    let rec;
    try { rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, { audioBitsPerSecond: 48000 })); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); return CTX.toast('Could not start the recorder', 'err'); }
    const form = CTX.$('#waForm');
    const bar = document.createElement('div');
    bar.className = 'wa-rec';
    bar.innerHTML = `<button type="button" class="wa-icon-btn wa-rec-x" title="Discard (Esc)">${ICON.trash}</button><span class="wa-rec-dot"></span><span class="wa-rec-time">0:00</span><canvas class="wa-rec-cv" width="360" height="40"></canvas><button type="button" class="wa-send wa-rec-send" title="Send voice note">${ICON.send}</button>`;
    form.appendChild(bar);
    form.classList.add('recording');
    const R = REC = { rec, stream, chunks: [], t0: Date.now(), jid: CTX.S.jid, levels: [], raf: 0, send: false, bar, ac: null, pulse: 0, tick: 0, mime: rec.mimeType || mime || 'audio/webm' };
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      R.ac = new AC();
      const an = R.ac.createAnalyser(); an.fftSize = 512;
      R.ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const cv = bar.querySelector('canvas'), g = cv.getContext('2d');
      const col = getComputedStyle(CTX.waApp).getPropertyValue('--wa-accent-2').trim() || '#25d366';
      let last = 0;
      const draw = (ts) => {
        if (REC !== R) return;
        an.getByteTimeDomainData(buf);
        let peak = 0; for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
        if (ts - last > 70) { R.levels.push(Math.min(1, peak / 70)); if (R.levels.length > 60) R.levels.shift(); last = ts; }
        g.clearRect(0, 0, cv.width, cv.height);
        g.fillStyle = col;
        const w = cv.width / 60;
        R.levels.forEach((v, i) => { const h = Math.max(3, v * cv.height); g.fillRect(i * w + 1, (cv.height - h) / 2, w - 3, h); });
        R.raf = requestAnimationFrame(draw);
      };
      R.raf = requestAnimationFrame(draw);
    } catch (e) { /* no level meter, recording still works */ }
    R.tick = setInterval(() => {
      const s = (Date.now() - R.t0) / 1000;
      const t = bar.querySelector('.wa-rec-time'); if (t) t.textContent = fmtT(s);
      if (s >= MAX_REC_S) stopRecording(true);
    }, 250);
    const ping = () => CTX.api(CTX.base + '/typing', { method: 'POST', body: { jid: R.jid, on: true, mode: 'recording' } }).catch(() => {});
    ping(); R.pulse = setInterval(ping, 5000);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) R.chunks.push(e.data); };
    rec.onstop = () => finishRecording(R);
    bar.querySelector('.wa-rec-x').onclick = () => stopRecording(false);
    bar.querySelector('.wa-rec-send').onclick = () => stopRecording(true);
    rec.start(250);
  }
  function stopRecording(send) {
    const R = REC;
    if (!R) return;
    R.send = !!send;
    if (R.rec.state !== 'inactive') R.rec.stop(); else finishRecording(R);
  }
  async function finishRecording(R) {
    if (REC !== R) return;
    REC = null;
    cancelAnimationFrame(R.raf); clearInterval(R.tick); clearInterval(R.pulse);
    R.stream.getTracks().forEach((t) => t.stop());
    try { R.ac && R.ac.close(); } catch (e) { /* closed */ }
    const form = CTX && CTX.$('#waForm');
    if (form) form.classList.remove('recording');
    R.bar.remove();
    CTX.api(CTX.base + '/typing', { method: 'POST', body: { jid: R.jid, on: false } }).catch(() => {});
    if (!R.send) return;
    const secs = (Date.now() - R.t0) / 1000;
    if (secs < 1) return CTX.toast('Hold on a little longer: voice notes must be at least 1 second');
    const blob = new Blob(R.chunks, { type: R.mime.split(';')[0] || 'audio/webm' });
    if (blob.size > 3.8 * 1048576) return CTX.toast('That voice note is too large', 'err');
    CTX.toast('Sending voice note…');
    try {
      const dataUrl = await toDataUrl(blob);
      const r = await CTX.api(CTX.base + '/sendvoice', { method: 'POST', body: { jid: R.jid, data: dataUrl.split(',')[1], mime: R.mime, seconds: Math.round(secs), quotedId: CTX.S.replyTo && CTX.S.jid === R.jid ? CTX.S.replyTo.id : undefined } });
      if (r && r.message) CTX.MEDIA[r.message.id] = { mime: blob.type, data: dataUrl };
      CTX.setReply(null);
    } catch (e) { CTX.toast(e.message || 'Could not send the voice note', 'err'); }
  }
  function syncMic() {
    const ta = CTX && CTX.$('#waText');
    const mic = CTX && CTX.$('#waMic');
    const send = CTX && CTX.$('#waForm .wa-send:not(.wa-rec-send):not(.wa-mic)');
    if (!ta || !mic || !send) return;
    const empty = !ta.value.trim();
    mic.hidden = !empty; send.hidden = empty;
  }

  /* ================================================================ suggestions popup (quick replies, @mentions) */
  const SUG = { items: [], i: 0, open: false, pick: null };
  function sugClose() { SUG.open = false; const el = CTX && CTX.$('#waSug'); if (el) el.hidden = true; }
  function sugShow(items, pick) {
    const el = CTX.$('#waSug');
    if (!items.length) return sugClose();
    SUG.items = items; SUG.i = 0; SUG.open = true; SUG.pick = pick;
    el.hidden = false;
    el.innerHTML = items.slice(0, 8).map((it, i) => `<div class="wa-sug${i === 0 ? ' on' : ''}" data-i="${i}"><b>${escH(it.label)}</b><span>${escH(it.sub || '')}</span></div>`).join('');
    el.onmousedown = (e) => { const d = e.target.closest('[data-i]'); if (!d) return; e.preventDefault(); SUG.pick(SUG.items[+d.dataset.i]); sugClose(); };
  }
  function sugMove(d) {
    const n = Math.min(8, SUG.items.length);
    SUG.i = (SUG.i + d + n) % n;
    CTX.$('#waSug').querySelectorAll('.wa-sug').forEach((x, i) => x.classList.toggle('on', i === SUG.i));
  }

  /* quick replies */
  const quick = () => store.get(QUICK_KEY, []);
  function quickDialog() {
    const d = CTX.dialog('');
    const box = d.firstElementChild;
    const draw = () => {
      const list = quick();
      box.innerHTML = `<h3>Quick replies</h3><p class="wa-hint">Type <b>/</b> in any chat and pick a shortcut to drop the text in. Saved in this browser.</p>
        <div class="wa-quick-list">${list.map((q, i) => `<div class="wa-quick-row"><b>/${escH(q.k)}</b><span>${escH(q.t)}</span><button type="button" data-del="${i}" title="Delete">✕</button></div>`).join('') || '<div class="chat-empty">No quick replies yet.</div>'}</div>
        <input class="wa-dialog-input" id="qrK" maxlength="20" placeholder="Shortcut, e.g. thanks" />
        <textarea class="wa-dialog-input" id="qrT" rows="3" maxlength="1000" placeholder="Message, e.g. Thanks for reaching out! We will get back to you shortly." style="margin-top:8px"></textarea>
        <div class="wa-dialog-act"><button type="button" class="wa-btn ghost" id="qrClose">Close</button><button type="button" class="wa-btn" id="qrAdd">Add</button></div>`;
      box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { const l = quick(); l.splice(+b.dataset.del, 1); store.set(QUICK_KEY, l); draw(); }; });
      box.querySelector('#qrClose').onclick = () => d.remove();
      box.querySelector('#qrAdd').onclick = () => {
        const k = box.querySelector('#qrK').value.trim().replace(/^\/+/, '').replace(/[^\w-]/g, '').toLowerCase();
        const t = box.querySelector('#qrT').value.trim();
        if (!k || !t) return CTX.toast('Add a shortcut and a message', 'err');
        const l = quick().filter((q) => q.k !== k);
        l.push({ k, t });
        if (l.length > 50) return CTX.toast('Up to 50 quick replies', 'err');
        store.set(QUICK_KEY, l); draw();
      };
    };
    draw();
  }

  /* @mentions */
  const groupCache = new Map(); // jid -> participants
  let mentionMap = {}; // '@Name' text -> phone, for the message being written
  async function loadParticipants(jid) {
    if (groupCache.has(jid)) return groupCache.get(jid);
    groupCache.set(jid, []);
    try {
      const g = await CTX.api(`${CTX.base}/group?jid=${encodeURIComponent(jid)}`);
      const list = (g.participants || []).filter((p) => !p.me && p.phone && /^\d{5,20}$/.test(p.phone));
      groupCache.set(jid, list);
      return list;
    } catch (e) { groupCache.delete(jid); return []; }
  }
  async function updateSuggest() {
    const ta = CTX.$('#waText');
    if (!ta || !CTX.S.jid) return sugClose();
    const caret = ta.selectionStart, before = ta.value.slice(0, caret);
    const q = /^\/([\w-]*)$/.exec(before);
    if (q) {
      const items = quick().filter((x) => x.k.startsWith(q[1].toLowerCase())).map((x) => ({ label: '/' + x.k, sub: x.t.slice(0, 70), t: x.t }));
      if (!items.length) return sugClose();
      return sugShow(items, (it) => { ta.value = it.t + ta.value.slice(caret); ta.focus(); ta.setSelectionRange(it.t.length, it.t.length); syncMic(); });
    }
    const mm = CTX.S.chat && CTX.S.chat.isGroup ? /(^|\s)@([^\s@]{0,24})$/.exec(before) : null;
    if (mm) {
      const jid = CTX.S.jid;
      const list = await loadParticipants(jid);
      if (CTX.S.jid !== jid) return;
      const f = mm[2].toLowerCase();
      const items = list.filter((p) => !f || (p.name || '').toLowerCase().includes(f) || p.phone.includes(f)).slice(0, 8).map((p) => ({ label: p.name || '+' + p.phone, sub: p.name ? '+' + p.phone : '', p }));
      return sugShow(items, (it) => {
        const nm = it.p.name ? it.p.name.replace(/\s+/g, ' ').trim() : it.p.phone;
        const ins = '@' + nm + ' ';
        const start = caret - mm[2].length - 1;
        ta.value = ta.value.slice(0, start) + ins + ta.value.slice(caret);
        mentionMap['@' + nm] = it.p.phone;
        ta.focus(); ta.setSelectionRange(start + ins.length, start + ins.length); syncMic();
      });
    }
    sugClose();
  }
  function prepareSend(text) {
    const mentions = [];
    const names = Object.keys(mentionMap).sort((a, b) => b.length - a.length);
    for (const nm of names) {
      if (!text.includes(nm)) continue;
      const ph = mentionMap[nm];
      text = text.split(nm).join('@' + ph);
      mentions.push(ph);
    }
    // numbers typed by hand (@2782...) are mentions too
    (text.match(/@\d{6,15}\b/g) || []).forEach((x) => { if (!mentions.includes(x.slice(1))) mentions.push(x.slice(1)); });
    mentionMap = {};
    return { text, mentions: mentions.length ? mentions : undefined };
  }

  /* ================================================================ appearance dialog */
  const ACCENTS = ['#00a884', '#25d366', '#1da1f2', '#8b5cf6', '#e11d68', '#ff4d4d', '#f2711c', '#eab308', '#14b8a6', '#64748b'];
  function shrinkWallpaper(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          let max = 1600, q = 0.8, out = '';
          for (let i = 0; i < 4; i++) {
            const k = Math.min(1, max / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            out = c.toDataURL('image/jpeg', q);
            if (out.length < 1.3e6) break;
            max = Math.round(max * 0.75); q -= 0.1;
          }
          resolve(out);
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not a readable image')); };
      img.src = url;
    });
  }
  function appearanceDialog() {
    const d = CTX.dialog('');
    const box = d.firstElementChild;
    box.classList.add('wa-look-dialog');
    const change = (patch) => { Object.assign(look, patch); saveLook(); applyLook(CTX.waApp); render(); };
    const live = (patch) => { Object.assign(look, patch); saveLook(); applyLook(CTX.waApp); };
    function render() {
      const keep = box.scrollTop;
      const cur = effectiveThemeId();
      const t = THEMES[cur];
      const acc = hexOk(look.accent) ? look.accent : t.accent;
      box.innerHTML = `
      <div class="wa-look-head"><h3>Appearance</h3><button type="button" class="wa-icon-btn" id="lkX" title="Close">✕</button></div>
      <section>
        <h4>Theme</h4>
        <label class="wa-check"><input type="checkbox" id="lkSys" ${look.system ? 'checked' : ''}> Follow my device (Midnight at night, Daylight in the day)</label>
        <div class="wa-themes ${look.system ? 'off' : ''}">${Object.entries(THEMES).map(([id, th]) => `
          <button type="button" class="wa-theme ${look.theme === id ? 'on' : ''}" data-theme-id="${id}" title="${th.name}">
            <span class="wa-theme-prev" style="background:${th.chat}"><i style="background:${th.in}"></i><i style="background:${th.out}"></i><b style="background:${th.accent}"></b></span>
            <span>${th.name}</span></button>`).join('')}</div>
      </section>
      <section>
        <h4>Accent colour</h4>
        <div class="wa-swatches">${ACCENTS.map((c) => `<button type="button" class="wa-sw ${look.accent.toLowerCase() === c ? 'on' : ''}" data-accent="${c}" style="background:${c}" title="${c}"></button>`).join('')}
          <label class="wa-sw wa-sw-custom ${look.accent && !ACCENTS.includes(look.accent.toLowerCase()) ? 'on' : ''}" title="Pick any colour"><input type="color" id="lkAccent" value="${acc}">+</label>
          <button type="button" class="wa-link" id="lkAccentReset" ${look.accent ? '' : 'disabled'}>Theme default</button></div>
      </section>
      <section>
        <h4>Chat bubbles</h4>
        <div class="wa-row2">
          <label>Your messages <input type="color" id="lkOut" value="${hexOk(look.outBubble) ? look.outBubble : (hexOk(t.out) ? t.out : '#005c4b')}"></label>
          <label>Their messages <input type="color" id="lkIn" value="${hexOk(look.inBubble) ? look.inBubble : (hexOk(t.in) ? t.in : '#202c33')}"></label>
          <button type="button" class="wa-link" id="lkBubReset" ${look.outBubble || look.inBubble ? '' : 'disabled'}>Reset</button>
        </div>
        <label class="wa-range">Corner roundness <input type="range" id="lkRadius" min="0" max="20" value="${look.radius}"><span>${look.radius}px</span></label>
      </section>
      <section>
        <h4>Chat wallpaper</h4>
        <div class="wa-wps">${Object.entries(WALLPAPERS).filter(([id]) => id !== 'custom').map(([id, w]) => `<button type="button" class="wa-wp ${look.wallpaper === id ? 'on' : ''}" data-wp="${id}" title="${w.name}" style="background-color:${t.chat};${w.css ? `background-image:${w.css};background-size:${w.size || 'cover'}` : ''}"><span>${w.name}</span></button>`).join('')}
          <button type="button" class="wa-wp ${look.wallpaper === 'custom' ? 'on' : ''}" id="lkWpUp" title="Use your own photo" style="${look.wpImage ? `background-image:url(${look.wpImage});background-size:cover` : ''}"><span>${look.wpImage ? 'My photo' : '+ Upload'}</span></button>
          <input type="file" id="lkWpFile" accept="image/jpeg,image/png,image/webp" hidden></div>
        ${look.wallpaper === 'custom' && look.wpImage ? `<label class="wa-range">Dim photo <input type="range" id="lkDim" min="0" max="80" value="${look.wpDim}"><span>${look.wpDim}%</span></label>` : ''}
      </section>
      <section>
        <h4>Text and layout</h4>
        <label class="wa-range">Message text size <input type="range" id="lkFont" min="12" max="19" step="0.5" value="${look.font}"><span>${look.font}px</span></label>
        <label class="wa-check"><input type="checkbox" id="lkCompact" ${look.compact ? 'checked' : ''}> Compact mode (tighter chat list and bubbles)</label>
        <label class="wa-check"><input type="checkbox" id="lkEnter" ${look.enterSends ? 'checked' : ''}> Enter sends the message (off: Ctrl+Enter sends, Enter adds a line)</label>
        <label class="wa-check"><input type="checkbox" id="lkSounds" ${look.sounds ? 'checked' : ''}> Play a sound for new messages</label>
      </section>
      <section>
        <h4>Preview</h4>
        <div class="wa-look-preview">
          <div class="wa-msg them" style="align-self:flex-start">Hey! Can you send the invoice? <div class="wa-meta">09:41</div></div>
          <div class="wa-msg me" style="align-self:flex-end"><strong>Sure</strong>, sending it now <em>right away</em> ✅<div class="wa-meta">09:42 ✓✓</div></div>
        </div>
      </section>
      <div class="wa-dialog-act"><button type="button" class="wa-btn ghost" id="lkReset">Reset everything</button><button type="button" class="wa-btn" id="lkDone">Done</button></div>`;
      box.scrollTop = keep;
      const $q = (s) => box.querySelector(s);
      $q('#lkX').onclick = $q('#lkDone').onclick = () => d.remove();
      $q('#lkSys').onchange = (e) => change({ system: e.target.checked });
      box.querySelectorAll('[data-theme-id]').forEach((b) => { b.onclick = () => change({ theme: b.dataset.themeId, system: false, outBubble: '', inBubble: '' }); });
      box.querySelectorAll('[data-accent]').forEach((b) => { b.onclick = () => change({ accent: b.dataset.accent }); });
      $q('#lkAccent').oninput = (e) => live({ accent: e.target.value });
      $q('#lkAccent').onchange = () => render();
      $q('#lkAccentReset').onclick = () => change({ accent: '' });
      $q('#lkOut').oninput = (e) => live({ outBubble: e.target.value });
      $q('#lkIn').oninput = (e) => live({ inBubble: e.target.value });
      $q('#lkOut').onchange = $q('#lkIn').onchange = () => render();
      $q('#lkBubReset').onclick = () => change({ outBubble: '', inBubble: '' });
      $q('#lkRadius').oninput = (e) => { live({ radius: +e.target.value }); e.target.nextElementSibling.textContent = e.target.value + 'px'; };
      box.querySelectorAll('[data-wp]').forEach((b) => { b.onclick = () => change({ wallpaper: b.dataset.wp }); });
      $q('#lkWpUp').onclick = () => { if (look.wpImage && look.wallpaper !== 'custom') change({ wallpaper: 'custom' }); else $q('#lkWpFile').click(); };
      $q('#lkWpFile').onchange = async (e) => {
        const f = e.target.files && e.target.files[0]; e.target.value = '';
        if (!f) return;
        try {
          const url = await shrinkWallpaper(f);
          const prev = { wpImage: look.wpImage, wallpaper: look.wallpaper };
          look.wpImage = url; look.wallpaper = 'custom';
          if (!saveLookOk()) { Object.assign(look, prev); return CTX.toast('That photo is too big for this browser to remember. Try a smaller one.', 'err'); }
          applyLook(CTX.waApp); render();
        } catch (er) { CTX.toast(er.message || 'Could not use that photo', 'err'); }
      };
      const dim = $q('#lkDim');
      if (dim) dim.oninput = (e) => { live({ wpDim: +e.target.value }); e.target.nextElementSibling.textContent = e.target.value + '%'; };
      $q('#lkFont').oninput = (e) => { live({ font: +e.target.value }); e.target.nextElementSibling.textContent = e.target.value + 'px'; };
      $q('#lkCompact').onchange = (e) => change({ compact: e.target.checked });
      $q('#lkEnter').onchange = (e) => live({ enterSends: e.target.checked });
      $q('#lkSounds').onchange = (e) => { live({ sounds: e.target.checked }); if (CTX.P) { CTX.P.sound = e.target.checked; CTX.savePrefs && CTX.savePrefs(); } };
      $q('#lkReset').onclick = () => { if (!confirm('Reset all appearance settings?')) return; look = Object.assign({}, DEFAULT_LOOK); saveLook(); applyLook(CTX.waApp); render(); };
    }
    render();
  }
  function saveLookOk() { return store.set(LOOK_KEY, look); }

  /* ================================================================ message search, export, shortcuts */
  function searchDialog() {
    const d = CTX.dialog(`<h3>Search messages</h3><input class="wa-dialog-input" id="msQ" placeholder="Search every chat (2+ letters)" autocomplete="off" /><p class="wa-hint">Looks through messages this number has seen since the bot last started.</p><div class="wa-fwd-list" id="msR"></div>`);
    const input = d.querySelector('#msQ'), out = d.querySelector('#msR');
    let t = null, seq = 0;
    const mark = (txt, q) => { const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'); return escH(txt).replace(new RegExp(escH(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (x) => '<mark>' + x + '</mark>'); };
    input.oninput = () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (q.length < 2) { out.innerHTML = ''; return; }
      t = setTimeout(async () => {
        const my = ++seq;
        try {
          const r = await CTX.api(`${CTX.base}/search?q=${encodeURIComponent(q)}`);
          if (my !== seq) return;
          out.innerHTML = r.results.length ? r.results.map((x, i) => `<div class="wa-starred" data-i="${i}"><small>${escH(x.chat)}${x.isGroup && x.sender ? ' · ' + escH(x.sender) : ''} · ${escH(new Date(x.ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}${x.fromMe ? ' · You' : ''}</small><div>${mark(x.text, q)}</div></div>`).join('') + (r.total > r.results.length ? `<div class="wa-hint">Showing ${r.results.length} of ${r.total}. Narrow the search to see more.</div>` : '') : '<div class="chat-empty">No messages found.</div>';
          out.querySelectorAll('[data-i]').forEach((el) => { el.onclick = async () => { const x = r.results[+el.dataset.i]; d.remove(); await jumpTo(x, q); }; });
        } catch (e) { out.innerHTML = `<div class="chat-empty">${escH(e.message || 'Search failed')}</div>`; }
      }, 250);
    };
    input.focus();
  }
  async function jumpTo(x, q) {
    await CTX.openChat(x.jid);
    CTX.S.find = q;
    CTX.$('#waFind').hidden = false;
    CTX.$('#waFindInput').value = q;
    CTX.paintThread(false);
    const el = CTX.$('#waThread').querySelector('[data-id="' + (window.CSS && CSS.escape ? CSS.escape(x.id) : x.id) + '"]');
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('wa-flash'); setTimeout(() => el.classList.remove('wa-flash'), 2000); }
  }
  async function exportChat(jid) {
    try {
      const r = await CTX.api(`${CTX.base}/messages?jid=${encodeURIComponent(jid)}&limit=200`);
      const name = (r.chat && r.chat.name) || jid;
      const lines = r.messages.filter((m) => m.type !== 'reaction').map((m) => {
        const when = new Date(m.ts * 1000).toLocaleString();
        const who = m.fromMe ? 'You' : (m.senderName || (r.chat && r.chat.isGroup ? '+' + m.sender : name));
        const body = m.deleted ? '<message deleted>' : (m.text ? m.text : '') + (['image', 'video', 'voice', 'audio', 'document', 'sticker'].includes(m.type) ? (m.text ? ' ' : '') + '<' + m.type + (m.media && m.media.seconds ? ' ' + fmtT(m.media.seconds) : '') + '>' : '');
        return `[${when}] ${who}: ${body}`;
      });
      if (!lines.length) return CTX.toast('Nothing to export yet');
      const blob = new Blob([`Chat with ${name}\nExported ${new Date().toLocaleString()}\n\n` + lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'chat-' + name.replace(/[^\w.-]+/g, '_').slice(0, 40) + '.txt';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      CTX.toast(`Exported ${lines.length} messages`);
    } catch (e) { CTX.toast(e.message || 'Could not export', 'err'); }
  }
  function shortcutsDialog() {
    const rows = [
      ['Ctrl K', 'Search chats'], ['Ctrl Shift F', 'Search messages in every chat'], ['Ctrl ,', 'Open appearance'], ['Alt ↑ / Alt ↓', 'Previous / next chat'],
      ['Enter', 'Send (Shift Enter for a new line)'], ['Ctrl B', 'Bold selection'], ['Ctrl I', 'Italic selection'], ['Ctrl Shift X', 'Strikethrough selection'], ['Ctrl E', 'Monospace selection'],
      ['/', 'Quick replies'], ['@', 'Mention someone in a group'], ['Esc', 'Close panels, cancel voice recording'], ['?', 'This list'],
    ];
    const d = CTX.dialog(`<h3>Keyboard shortcuts</h3><div class="wa-keys">${rows.map(([k, v]) => `<div><kbd>${escH(k)}</kbd><span>${escH(v)}</span></div>`).join('')}</div><div class="wa-dialog-act"><button type="button" class="wa-btn" id="kbOk">Close</button></div>`);
    d.querySelector('#kbOk').onclick = () => d.remove();
  }

  /* ================================================================ composer helpers */
  function wrapSelection(ta, mark) {
    const a = ta.selectionStart, b = ta.selectionEnd;
    const sel = ta.value.slice(a, b);
    if (!sel) { ta.setRangeText(mark + mark, a, b, 'end'); ta.setSelectionRange(a + mark.length, a + mark.length); }
    else {
      const already = sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2;
      const out = already ? sel.slice(mark.length, -mark.length) : mark + sel + mark;
      ta.setRangeText(out, a, b, 'select');
    }
    ta.focus(); syncMic();
  }
  const drafts = { map: {}, cur: null, key: '', timer: 0 };
  function saveDrafts() { clearTimeout(drafts.timer); drafts.timer = setTimeout(() => store.set(drafts.key, drafts.map), 400); }

  /* ================================================================ init */
  let CTX = null;
  let origIcon = null;
  function init(ctx) {
    CTX = ctx;
    const app = ctx.waApp;
    // ---- look
    applyLook(app);
    ctx.P.sound = look.sounds !== false && ctx.P.sound !== false;
    // ---- branding
    const rail = app.querySelector('.wa-rail');
    if (rail && !rail.querySelector('.wa-rail-logo')) rail.insertAdjacentHTML('afterbegin', '<img class="wa-rail-logo" src="/img/wa-logo-64.png" alt="Ladybug Chat" width="40" height="40">');
    const brand = app.querySelector('.wa-brand');
    if (brand && !brand.querySelector('img')) brand.insertAdjacentHTML('afterbegin', '<img class="wa-brand-logo" src="/img/wa-logo-64.png" alt="" width="28" height="28">');
    const emptyLogo = app.querySelector('.wa-empty-logo');
    if (emptyLogo) emptyLogo.src = '/img/wa-logo-512.png';
    const fav = document.querySelector('link[rel="icon"]');
    if (fav) { origIcon = origIcon || fav.getAttribute('href'); fav.setAttribute('href', '/img/wa-logo-64.png'); }
    window.addEventListener('hashchange', function restore() { if (!location.hash.startsWith('#/web')) { const f = document.querySelector('link[rel="icon"]'); if (f && origIcon) f.setAttribute('href', origIcon); window.removeEventListener('hashchange', restore); } });

    // ---- rail buttons
    const theme = ctx.$('#waTheme');
    if (theme) { theme.innerHTML = ICON.palette; theme.title = 'Appearance and themes (Ctrl + ,)'; theme.onclick = appearanceDialog; }
    const star = ctx.$('#waStarBtn');
    const mk = (id, icon, title, fn) => { const b = document.createElement('button'); b.className = 'wa-rail-btn'; b.id = id; b.title = title; b.innerHTML = icon; b.onclick = fn; return b; };
    if (star) {
      star.after(mk('waKeys', ICON.kbd, 'Keyboard shortcuts (?)', shortcutsDialog));
      star.after(mk('waQuickBtn', ICON.bolt, 'Quick replies', quickDialog));
      star.after(mk('waMsgSearch', ICON.search, 'Search messages (Ctrl + Shift + F)', searchDialog));
    }

    // ---- composer: emoji, mic, format bar, suggestions
    const form = ctx.$('#waForm'), ta = ctx.$('#waText');
    const pop = ctx.$('#waEmojiPop');
    if (pop) buildEmoji(pop, (em) => { const a = ta.selectionStart || ta.value.length, b = ta.selectionEnd || a; ta.setRangeText(em, a, b, 'end'); ta.focus(); ta.dispatchEvent(new Event('input')); });
    const sendBtn = form.querySelector('.wa-send');
    if (!ctx.$('#waMic')) {
      const mic = document.createElement('button');
      mic.type = 'button'; mic.id = 'waMic'; mic.className = 'wa-send wa-mic'; mic.title = 'Record a voice note'; mic.innerHTML = ICON.mic;
      mic.onclick = startRecording;
      sendBtn.before(mic);
      const fb = document.createElement('button');
      fb.type = 'button'; fb.className = 'wa-icon-btn'; fb.id = 'waFmtBtn'; fb.title = 'Text formatting'; fb.innerHTML = '<span style="font-weight:700;font-size:15px">Aa</span>';
      const ew = form.querySelector('.wa-emoji-wrap');
      ew && ew.after(fb);
      const fbar = document.createElement('div');
      fbar.className = 'wa-fmtbar'; fbar.id = 'waFmtBar'; fbar.hidden = true;
      fbar.innerHTML = '<button type="button" data-m="*"><b>B</b></button><button type="button" data-m="_"><i>I</i></button><button type="button" data-m="~"><s>S</s></button><button type="button" data-m="`"><code>&lt;/&gt;</code></button>';
      form.appendChild(fbar);
      fb.onclick = () => { fbar.hidden = !fbar.hidden; };
      fbar.onmousedown = (e) => e.preventDefault();
      fbar.onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) wrapSelection(ta, b.dataset.m); };
      const sug = document.createElement('div');
      sug.id = 'waSug'; sug.className = 'wa-sugbox'; sug.hidden = true;
      form.appendChild(sug);
    }
    ta.onkeydown = (e) => {
      if (SUG.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); return sugMove(1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); return sugMove(-1); }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const it = SUG.items[SUG.i]; sugClose(); return it && SUG.pick(it); }
        if (e.key === 'Escape') { e.preventDefault(); return sugClose(); }
      }
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === 'b') { e.preventDefault(); return wrapSelection(ta, '*'); }
      if (mod && !e.shiftKey && k === 'i') { e.preventDefault(); return wrapSelection(ta, '_'); }
      if (mod && !e.shiftKey && k === 'e') { e.preventDefault(); return wrapSelection(ta, '`'); }
      if (mod && e.shiftKey && k === 'x') { e.preventDefault(); return wrapSelection(ta, '~'); }
      if (e.key === 'Enter' && !e.isComposing) {
        const send = look.enterSends !== false ? !e.shiftKey : mod;
        if (send) { e.preventDefault(); form.requestSubmit(); }
      }
    };
    ta.addEventListener('input', () => { syncMic(); updateSuggest(); if (drafts.cur) { drafts.map[drafts.cur] = ta.value; if (!ta.value) delete drafts.map[drafts.cur]; saveDrafts(); } });
    ta.addEventListener('blur', () => setTimeout(sugClose, 150));
    form.addEventListener('submit', () => setTimeout(syncMic, 600));
    const sync = setInterval(() => { if (!document.getElementById('waApp')) { clearInterval(sync); if (REC) stopRecording(false); return; } syncMic(); }, 400);
    syncMic();

    // ---- drafts
    drafts.key = 'wa_drafts_' + ctx.bot.id;
    drafts.map = store.get(drafts.key, {}) || {};
    window.addEventListener('pagehide', () => { const t = ctx.$('#waText'); if (t && drafts.cur) { if (t.value) drafts.map[drafts.cur] = t.value; else delete drafts.map[drafts.cur]; store.set(drafts.key, drafts.map); } });

    // ---- global keys
    document.addEventListener('keydown', function waxKeys(e) {
      if (!document.getElementById('waApp')) return document.removeEventListener('keydown', waxKeys);
      const mod = e.ctrlKey || e.metaKey;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
      if (e.key === 'Escape' && REC) { e.preventDefault(); stopRecording(false); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); return searchDialog(); }
      if (mod && e.key === ',') { e.preventDefault(); return appearanceDialog(); }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const items = Array.from(document.querySelectorAll('#waList [data-jid]'));
        if (!items.length) return;
        e.preventDefault();
        const i = items.findIndex((x) => x.dataset.jid === ctx.S.jid);
        const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) { ctx.openChat(n.dataset.jid); n.scrollIntoView({ block: 'nearest' }); }
        return;
      }
      if (!typing && !mod && e.key === '?' ) { e.preventDefault(); shortcutsDialog(); }
    });
  }
  function beforeOpen(jid) {
    if (!CTX) return;
    const ta = CTX.$('#waText');
    if (!ta || drafts.cur === jid) return;
    if (REC) stopRecording(false);
    if (drafts.cur) { if (ta.value) drafts.map[drafts.cur] = ta.value; else delete drafts.map[drafts.cur]; store.set(drafts.key, drafts.map); }
    drafts.cur = jid;
    ta.value = drafts.map[jid] || '';
    mentionMap = {};
    sugClose();
    syncMic();
  }
  function afterPaint(root) { wireVoice(root); }

  window.WAX = Object.assign(window.WAX || {}, { THEMES, WALLPAPERS, applyLook, fmt, voiceHtml, afterPaint, beforeOpen, prepareSend, exportChat, init, openAppearance: () => CTX && appearanceDialog(), getLook: () => look, sounds: () => look.sounds !== false });
})();
