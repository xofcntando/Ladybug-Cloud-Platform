/**
 * Bot Code Installer
 * Installs / updates the Ladybug Mini bot source into BOT_DIR.
 *  - from GitHub archive (zip)
 *  - from an uploaded zip
 *  - installs npm dependencies
 * Preserves per-bot session folders and node_modules during updates.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const BOT_DIR = process.env.BOT_DIR || path.join(__dirname, '..', 'bots', 'ladybug');
const DEFAULT_REPO_ZIP =
  process.env.BOT_ZIP_URL ||
  'https://github.com/xofcntando/Ladybug-Mini/archive/refs/heads/main.zip';

/**
 * GitHub archives move around (owner renames, default branch changes), and a
 * dead URL used to make "Install from GitHub" fail with a bare HTTP 404.
 * Try the configured URL first, then known-good mirrors/branches.
 */
const REPO_ZIP_FALLBACKS = [
  'https://github.com/xofcntando/Ladybug-Mini/archive/refs/heads/main.zip',
  'https://github.com/xofcntando/Ladybug-Mini/archive/refs/heads/master.zip',
  'https://github.com/kids-codentando/Ladybug-Mini/archive/refs/heads/main.zip',
];

const state = {
  installing: false,
  step: 'idle',
  message: '',
  progress: 0,
  lastInstalledAt: null,
  depsInstalling: false,
};

function setState(patch) {
  Object.assign(state, patch);
}

function getState() {
  return {
    ...state,
    botDir: BOT_DIR,
    installed: fs.existsSync(path.join(BOT_DIR, 'index.js')),
    depsInstalled: depsInstalled(),
    native: nativeStatus(),
  };
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'LadybugCloud-Installer/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return download(next, dest, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (err) => {
        try {
          fs.unlinkSync(dest);
        } catch (e) {
          /* ignore */
        }
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Download timed out')));
  });
}

/** Try each candidate URL until one downloads successfully. */
async function downloadFirstAvailable(urls, dest) {
  const tried = [];
  for (const url of urls) {
    try {
      await download(url, dest);
      return url;
    } catch (e) {
      tried.push(`${url} -> ${e.message}`);
      try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
    }
  }
  throw new Error(`Could not download bot source. Tried: ${tried.join(' | ')}`);
}

/** Extract zip buffer, stripping the top-level folder, into BOT_DIR. */
/**
 * Files that carry the paid-command gate. An upstream zip must never silently
 * replace these, otherwise every `premium: true` command becomes free.
 */
const PROTECTED = [
  'utils/premium.js',
  'utils/fastFetch.js',
  'commands/premium/',
  'commands/owner/premium.js',
];

function isProtected(name) {
  const n = name.replace(/\\/g, '/');
  return PROTECTED.some((p) => (p.endsWith('/') ? n.startsWith(p) : n === p));
}

function allowProtectedOverwrite() {
  return /^(1|true|yes)$/i.test(String(process.env.ALLOW_PROTECTED_OVERWRITE || ''));
}

/**
 * The premium gate lives in handler.js, which upstream owns. Rather than freeze
 * the whole file, re-apply just the gate if a fresh download lost it.
 */
const GATE_ANCHOR = '    // Auto-typing';
const GATE_BLOCK = `    // Premium (paid) gate — owners bypass so the bot owner can always test.
    if (command.premium && !isOwner(sender)) {
      const premium = require('./utils/premium');
      if (!premium.isPremium(sender)) {
        return sock.sendMessage(from, {
          text:
            \`⭐ *\${command.name}* is a premium command.\\n\\n\` +
            \`Unlock the full premium pack (glitchtext, banner, matrixrain, vhs, corrupt, typewriter) \` +
            \`from your Ladybug Cloud dashboard.\\n\\n\` +
            \`Already paid? Ask the owner to activate your number.\`,
        }, { quoted: msg });
      }
    }

`;

function ensurePremiumGate() {
  const file = path.join(BOT_DIR, 'handler.js');
  if (!fs.existsSync(file)) return 'missing';
  if (!fs.existsSync(path.join(BOT_DIR, 'utils', 'premium.js'))) return 'no-util';
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('command.premium && !isOwner(sender)')) return 'present';
  const at = src.indexOf(GATE_ANCHOR);
  if (at === -1) return 'no-anchor';
  fs.writeFileSync(file, src.slice(0, at) + GATE_BLOCK + src.slice(at));
  return 'reapplied';
}

/**
 * Custom commands (created through the API) hook into handler.js with a single line.
 * The runtime module is copied from lib/bot-shims, and the hook is re-applied after any
 * upstream download or ZIP upload that replaced handler.js.
 */
const CC_ORIGINAL = '    const command = commands.get(commandName);';
const CC_HOOK = "    const command = require('./utils/customCommands').find(commandName) || commands.get(commandName);";

function ensureCustomCommands() {
  const file = path.join(BOT_DIR, 'handler.js');
  if (!fs.existsSync(file)) return 'missing';
  try {
    const shim = path.join(__dirname, 'bot-shims', 'customCommands.js');
    fs.mkdirSync(path.join(BOT_DIR, 'utils'), { recursive: true });
    fs.copyFileSync(shim, path.join(BOT_DIR, 'utils', 'customCommands.js'));
  } catch (e) {
    return 'no-shim';
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes("utils/customCommands')")) return 'present';
  if (!src.includes(CC_ORIGINAL)) return 'no-anchor';
  fs.writeFileSync(file, src.replace(CC_ORIGINAL, CC_HOOK));
  return 'reapplied';
}

/**
 * Web console bridge: the dashboard's "WhatsApp Web" talks to the running bot through
 * utils/webBridge.js, attached with one line in index.js right after the store is bound.
 */
const WB_ANCHOR = '  sock.store = store;';
const WB_HOOK = "\n  try { require('./utils/webBridge').attach(sock, store); } catch (e) { console.error('[web-bridge]', e.message); }";

function ensureWebBridge() {
  const file = path.join(BOT_DIR, 'index.js');
  if (!fs.existsSync(file)) return 'missing';
  try {
    fs.mkdirSync(path.join(BOT_DIR, 'utils'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'bot-shims', 'webBridge.js'), path.join(BOT_DIR, 'utils', 'webBridge.js'));
  } catch (e) {
    return 'no-shim';
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes("utils/webBridge')")) return 'present';
  if (!src.includes(WB_ANCHOR)) return 'no-anchor';
  fs.writeFileSync(file, src.replace(WB_ANCHOR, WB_ANCHOR + WB_HOOK));
  return 'reapplied';
}

/**
 * Session fixes that an upstream download would otherwise undo:
 *  1. index.js seeds the session from SESSION_ID once (utils/sessionSeed.js) instead of
 *     overwriting live credentials on every reconnect, which left the bot online but deaf.
 *  2. config.js honours SESSION_NAME (one folder per bot), PREFIX, OWNER_NUMBER and SELF_MODE.
 */
function ensureSessionFix() {
  const out = [];
  try {
    const idx = path.join(BOT_DIR, 'index.js');
    if (fs.existsSync(idx)) {
      fs.mkdirSync(path.join(BOT_DIR, 'utils'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'bot-shims', 'sessionSeed.js'), path.join(BOT_DIR, 'utils', 'sessionSeed.js'));
      let src = fs.readFileSync(idx, 'utf8');
      if (src.includes("utils/sessionSeed')")) out.push('seed:present');
      else {
        const a = src.indexOf('  // Check if sessionID is provided');
        const b = src.indexOf('  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);');
        if (a === -1 || b === -1 || b < a) out.push('seed:no-anchor');
        else {
          const call = "  require('./utils/sessionSeed').seed({ sessionID: config.sessionID, sessionFolder });\n\n";
          fs.writeFileSync(idx, src.slice(0, a) + call + src.slice(b));
          out.push('seed:reapplied');
        }
      }
    }
    const cfg = path.join(BOT_DIR, 'config.js');
    if (fs.existsSync(cfg)) {
      let src = fs.readFileSync(cfg, 'utf8');
      const before = src;
      if (!src.includes('process.env.SESSION_NAME')) src = src.replace("sessionName: 'session',", "sessionName: process.env.SESSION_NAME || 'session',");
      if (!src.includes('process.env.PREFIX')) src = src.replace("prefix: '.',", "prefix: process.env.PREFIX || '.',");
      if (!src.includes('process.env.OWNER_NUMBER')) src = src.replace(/ownerNumber:\s*\[([^\]]*)\],/, "ownerNumber: process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.split(',').map((n) => n.replace(/\\D/g, '')).filter(Boolean) : [$1],");
      if (!src.includes('process.env.SELF_MODE')) src = src.replace('selfMode: false,', "selfMode: /^(1|true|yes|on)$/i.test(process.env.SELF_MODE || ''),");
      if (src !== before) { fs.writeFileSync(cfg, src); out.push('config:reapplied'); } else out.push('config:present');
    }
  } catch (e) { out.push('error:' + e.message); }
  try { out.push(ensureSelfChatFix()); } catch (e) { out.push('selfchat-error:' + e.message); }
  return out.join(',');
}


/**
 * Self-chat fix ("I message my own number and the bot never answers"):
 *  1. index.js accepts fresh messages sent by this account even when WhatsApp delivers them
 *     as "append" instead of "notify" (which is how a linked device sees what you type on
 *     your phone), and logs one [msg] line per message so problems can be traced.
 *  2. handler.js treats the linked account itself as the owner, so owner commands work
 *     without OWNER_NUMBER having been set.
 */
function ensureSelfChatFix() {
  const out = [];
  try {
    const idx = path.join(BOT_DIR, 'index.js');
    if (fs.existsSync(idx)) {
      let src = fs.readFileSync(idx, 'utf8');
      const anchor = "      // Only process \"notify\" type (new messages), skip \"append\" (old messages from history)\n      if (type !== 'notify') continue;\n";
      if (src.includes('fresh (< 60s)')) out.push('selfchat-index:present');
      else if (!src.includes(anchor)) out.push('selfchat-index:no-anchor');
      else {
        const repl = fs.readFileSync(path.join(__dirname, 'bot-shims', 'selfchat-index.snippet.txt'), 'utf8');
        fs.writeFileSync(idx, src.replace(anchor, repl));
        out.push('selfchat-index:reapplied');
      }
    }
    const hnd = path.join(BOT_DIR, 'handler.js');
    if (fs.existsSync(hnd)) {
      let src = fs.readFileSync(hnd, 'utf8');
      if (src.includes('rememberSelf')) out.push('selfchat-handler:present');
      else {
        const a1 = "const isOwner = (sender) => {\n  if (!sender) return false;\n";
        const a2 = "    if (!msg.message) return;\n    rememberFromMessage(msg);\n";
        if (!src.includes(a1) || !src.includes(a2)) out.push('selfchat-handler:no-anchor');
        else {
          const helper = fs.readFileSync(path.join(__dirname, 'bot-shims', 'selfchat-handler.snippet.txt'), 'utf8');
          src = src.replace(a1, helper).replace(a2, "    if (!msg.message) return;\n    rememberSelf(sock);\n    rememberFromMessage(msg);\n");
          fs.writeFileSync(hnd, src);
          out.push('selfchat-handler:reapplied');
        }
      }
    }
  } catch (e) { out.push('error:' + e.message); }
  return out.join(',');
}

/**
 * Host hardening that must survive an upstream download.
 *
 * Upstream code does `require('ffmpeg-static')` and `require('canvas')` directly.
 * On hosts where npm blocks lifecycle scripts (npm 11.6+/12) the ffmpeg binary
 * and the canvas native binding are missing, so those requires throw and the
 * bot either fails to load a command or crashes on spawn (unhandled 'error').
 *
 * This step writes utils/ffmpeg.js and rewrites the direct requires to use it,
 * and gives tgsToWebp a @napi-rs/canvas fallback. It is idempotent.
 */
/**
 * Per-bot state isolation.
 *
 * Every bot process runs from the same BOT_DIR. The stock bot keeps its JSON
 * database in ./database and rewrites ./config.js from owner commands, so all
 * "independent" bots shared group settings, warnings, economy data and even
 * the prefix / private-mode flag. This step points that state at
 * $BOT_DATA_DIR (unique per bot, set by the platform) and rewrites the owner
 * commands to save overrides there instead of editing config.js.
 */
function ensurePerBotState() {
  const out = [];
  const utilsDir = path.join(BOT_DIR, 'utils');
  try {
    fs.mkdirSync(utilsDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'bot-shims', 'runtimeConfig.js'), path.join(utilsDir, 'runtimeConfig.js'));
    out.push('runtimeConfig:present');
  } catch (e) {
    out.push('runtimeConfig:error:' + e.message);
  }

  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
  const write = (f, v) => { try { fs.writeFileSync(f, v); return true; } catch (_) { return false; } };

  // 1) config.js applies per-bot overrides at load time.
  const cfg = path.join(BOT_DIR, 'config.js');
  let cfgSrc = read(cfg);
  if (cfgSrc && !cfgSrc.includes('runtimeConfig')) {
    cfgSrc +=
      "\n\n// Ladybug Cloud: apply per-bot overrides saved by owner commands.\n" +
      "try {\n" +
      "  const __overrides = require('./utils/runtimeConfig').load();\n" +
      "  for (const __k of Object.keys(__overrides)) module.exports[__k] = __overrides[__k];\n" +
      "} catch (_) { /* optional */ }\n";
    if (write(cfg, cfgSrc)) out.push('config:perbot');
  } else if (cfgSrc) out.push('config:perbot-present');

  // 2) database.js -> $BOT_DATA_DIR
  const db = path.join(BOT_DIR, 'database.js');
  let dbSrc = read(db);
  if (dbSrc && !dbSrc.includes('BOT_DATA_DIR')) {
    const next = dbSrc.replace(
      "const DB_PATH = path.join(__dirname, 'database');",
      "const DB_PATH = process.env.BOT_DATA_DIR || path.join(__dirname, 'database');"
    );
    if (next !== dbSrc && write(db, next)) out.push('database:perbot');
  } else if (dbSrc) out.push('database:perbot-present');

  // 3) economy DB used by .bomb
  const bomb = path.join(BOT_DIR, 'commands', 'fun', 'bomb.js');
  let bombSrc = read(bomb);
  if (bombSrc && !bombSrc.includes('BOT_DATA_DIR')) {
    const next = bombSrc.replace(
      "const ECO_DB_PATH = path.join(__dirname, '..', '..', 'database', 'economy.json');",
      "const ECO_DB_PATH = path.join(process.env.BOT_DATA_DIR || path.join(__dirname, '..', '..', 'database'), 'economy.json');"
    );
    if (next !== bombSrc && write(bomb, next)) out.push('economy:perbot');
  } else if (bombSrc) out.push('economy:perbot-present');

  // 4) Owner commands must not rewrite the shared config.js.
  const rc = "require('../../utils/runtimeConfig')";
  const patches = [
    {
      file: path.join(BOT_DIR, 'commands', 'owner', 'setprefix.js'),
      from: /\/\/ Update config file[\s\S]*?fs\.writeFileSync\(configPath, configContent\);/,
      to: "// Save per-bot override (never edit the shared config.js)\n      " + rc + ".set('prefix', newPrefix);",
    },
    {
      file: path.join(BOT_DIR, 'commands', 'owner', 'setbotname.js'),
      from: /const configPath = path\.join\(__dirname, '\.\.\/\.\.\/config\.js'\);[\s\S]*?fs\.writeFileSync\(configPath, configContent, 'utf-8'\);/,
      to: rc + ".set('botName', newBotName);",
    },
    {
      file: path.join(BOT_DIR, 'commands', 'owner', 'setnewsletter.js'),
      from: /\/\/ Update config\.js[\s\S]*?fs\.writeFileSync\(configPath, configContent, 'utf8'\);/,
      to: "// Save per-bot override\n      " + rc + ".set('newsletterJid', newsletterJid);",
    },
    {
      file: path.join(BOT_DIR, 'commands', 'owner', 'anticall.js'),
      from: /const configPath = path\.join\(__dirname, '\.\.\/\.\.\/config\.js'\);[\s\S]*?fs\.writeFileSync\(configPath, configFile\);/,
      to: "const __rc = " + rc + ";\n      const __next = option === 'on';\n      __rc.set('anticall', __next);\n      config.anticall = __next;\n    try {",
    },
    {
      file: path.join(BOT_DIR, 'commands', 'owner', 'mode.js'),
      from: /function updateConfig\(key, value\) \{[\s\S]*?\n\}/,
      to: "function updateConfig(key, value) {\n  try {\n    require('../../utils/runtimeConfig').set(key, value);\n  } catch (error) {\n    console.error('Error saving config:', error);\n  }\n}",
    },
  ];

  let cmdPatched = 0;
  for (const pt of patches) {
    const src = read(pt.file);
    if (!src) continue;
    if (src.includes("utils/runtimeConfig")) { out.push(path.basename(pt.file) + ':present'); continue; }
    const next = src.replace(pt.from, pt.to);
    if (next !== src && write(pt.file, next)) { cmdPatched += 1; out.push(path.basename(pt.file) + ':patched'); }
    else out.push(path.basename(pt.file) + ':no-anchor');
  }
  out.push('ownerCmds:' + cmdPatched);
  return out.join(',');
}

function ensureBotHardening() {
  const out = [];
  try {
    fs.mkdirSync(path.join(BOT_DIR, 'utils'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'bot-shims', 'ffmpeg.js'), path.join(BOT_DIR, 'utils', 'ffmpeg.js'));
    out.push('ffmpeg:present');
  } catch (e) {
    out.push('ffmpeg:error:' + e.message);
  }

  const skipDirs = new Set(['node_modules', '.git', 'session']);
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (skipDirs.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.js')) files.push(p);
    }
  };
  walk(BOT_DIR);

  let patched = 0;
  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const before = src;

    if (src.includes("require('ffmpeg-static')") || src.includes('require("ffmpeg-static")')) {
      const rel = path.relative(path.dirname(file), path.join(BOT_DIR, 'utils', 'ffmpeg')).replace(/\\/g, '/');
      const spec = rel.startsWith('.') ? rel : './' + rel;
      src = src.replace(/require\(['"]ffmpeg-static['"]\)/g, `require('${spec}').getFfmpegPath() || 'ffmpeg'`);
    }

    if (src.includes("const { Canvas } = require('canvas');")) {
      src = src.replace(
        "const { Canvas } = require('canvas');",
        "let Canvas;\ntry { ({ Canvas } = require('canvas')); }\ncatch (_) { ({ Canvas } = require('@napi-rs/canvas')); }\nif (typeof Canvas !== 'function') throw new Error('No usable canvas backend found (install canvas or @napi-rs/canvas)');"
      );
    }

    if (src !== before) {
      try { fs.writeFileSync(file, src); patched += 1; } catch (_) { /* ignore */ }
    }
  }
  out.push(`patched:${patched}`);
  try { out.push(ensurePerBotState()); } catch (e) { out.push('perbot-error:' + e.message); }
  return out.join(',');
}

function extractInto(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('Zip archive is empty');

  // Detect common top-level prefix (e.g. "Ladybug-Mini-main/")
  const first = entries[0].entryName;
  const slash = first.indexOf('/');
  const prefix = slash > 0 ? first.slice(0, slash + 1) : '';

  fs.mkdirSync(BOT_DIR, { recursive: true });

  let count = 0;
  const skipped = [];
  for (const entry of entries) {
    let name = entry.entryName;
    if (prefix && name.startsWith(prefix)) name = name.slice(prefix.length);
    if (!name) continue;

    // Never overwrite runtime data
    if (name.startsWith('node_modules/')) continue;
    if (/^session_[^/]+\//.test(name)) continue;
    if (name === 'session/' || name.startsWith('session/')) continue;
    if (name.startsWith('data/')) continue;

    const target = path.join(BOT_DIR, name);

    // Never let an upstream sync clobber the monetization layer. If the file is
    // already on disk we keep ours; a fresh install still writes it. Set
    // ALLOW_PROTECTED_OVERWRITE=1 to force the upstream version through.
    if (!allowProtectedOverwrite() && isProtected(name) && fs.existsSync(target)) {
      skipped.push(name);
      continue;
    }
    // Path traversal guard
    if (!target.startsWith(path.resolve(BOT_DIR))) continue;

    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
      count += 1;
    }
  }
  return { count, skipped };
}

async function installFromGitHub(url = DEFAULT_REPO_ZIP) {
  if (state.installing) throw new Error('An installation is already in progress');
  setState({ installing: true, step: 'download', message: 'Downloading bot source...', progress: 10 });

  const tmp = path.join(os.tmpdir(), `ladybug_${Date.now()}.zip`);
  try {
    const candidates = [url, ...REPO_ZIP_FALLBACKS.filter((u) => u !== url)];
    const usedUrl = await downloadFirstAvailable(candidates, tmp);
    setState({ step: 'extract', message: 'Extracting files...', progress: 45 });
    const buffer = fs.readFileSync(tmp);
    const { count, skipped } = extractInto(buffer);
    const gate = ensurePremiumGate();
    const customCmds = ensureCustomCommands();
    const webBridge = ensureWebBridge();
    const sessionFix = ensureSessionFix();
    const hardening = ensureBotHardening();
    setState({
      step: 'done',
      message:
        `Installed ${count} files from GitHub` +
        (skipped.length ? ` — kept ${skipped.length} protected file(s)` : '') +
        (gate === 'reapplied' ? ' — premium gate re-applied' : '') +
        (gate === 'no-anchor' ? ' — WARNING: premium gate NOT applied' : '') +
        (customCmds === 'no-anchor' ? ' — WARNING: custom commands hook NOT applied' : '') +
        (webBridge === 'no-anchor' ? ' — WARNING: web console hook NOT applied' : '') +
        (/no-anchor|error/.test(sessionFix) ? ' — WARNING: session fix NOT applied (' + sessionFix + ')' : '') +
        (/error/.test(hardening) ? ' — WARNING: host hardening incomplete (' + hardening + ')' : ''),
      progress: 100,
      installing: false,
      lastInstalledAt: new Date().toISOString(),
    });
    // Self-healing: a fresh checkout never has node_modules, so start the
    // dependency install straight away instead of waiting for the admin.
    if (!depsInstalled()) ensureDependencies().catch(() => {});
    return { ok: true, files: count, skipped, gate, customCmds, hardening, source: usedUrl, depsInstalling: !depsInstalled() };
  } catch (e) {
    setState({ step: 'error', message: e.message, progress: 0, installing: false });
    throw e;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      /* ignore */
    }
  }
}

async function installFromBuffer(buffer, filename = 'upload.zip') {
  if (state.installing) throw new Error('An installation is already in progress');
  setState({ installing: true, step: 'extract', message: 'Extracting uploaded archive...', progress: 40 });
  try {
    const { count, skipped } = extractInto(buffer);
    const gate = ensurePremiumGate();
    const customCmds = ensureCustomCommands();
    const webBridge = ensureWebBridge();
    const sessionFix = ensureSessionFix();
    const hardening = ensureBotHardening();
    if (!fs.existsSync(path.join(BOT_DIR, 'index.js'))) {
      throw new Error('Archive does not contain index.js — is this the bot source?');
    }
    setState({
      step: 'done',
      message:
        `Installed ${count} files from ${filename}` +
        (skipped.length ? ` — kept ${skipped.length} protected file(s)` : '') +
        (gate === 'reapplied' ? ' — premium gate re-applied' : '') +
        (gate === 'no-anchor' ? ' — WARNING: premium gate NOT applied' : '') +
        (customCmds === 'no-anchor' ? ' — WARNING: custom commands hook NOT applied' : '') +
        (webBridge === 'no-anchor' ? ' — WARNING: web console hook NOT applied' : '') +
        (/no-anchor|error/.test(sessionFix) ? ' — WARNING: session fix NOT applied (' + sessionFix + ')' : '') +
        (/error/.test(hardening) ? ' — WARNING: host hardening incomplete (' + hardening + ')' : ''),
      progress: 100,
      installing: false,
      lastInstalledAt: new Date().toISOString(),
    });
    // Self-healing: a fresh checkout never has node_modules, so start the
    // dependency install straight away instead of waiting for the admin.
    if (!depsInstalled()) ensureDependencies().catch(() => {});
    return { ok: true, files: count, skipped, gate, customCmds, hardening, depsInstalling: !depsInstalled() };
  } catch (e) {
    setState({ step: 'error', message: e.message, progress: 0, installing: false });
    throw e;
  }
}

/**
 * Check the native artifacts that npm's script policy can silently skip.
 * A missing ffmpeg binary or canvas binding does not stop `npm install` from
 * exiting 0, so the old depsInstalled() said "ready" and the bot crashed later.
 * Each item reports whether a usable fallback exists.
 */
function nativeStatus() {
  const nm = path.join(BOT_DIR, 'node_modules');
  const issues = [];

  // ffmpeg: ffmpeg-static binary, or a system ffmpeg on PATH
  let ffmpegOk = false;
  try {
    const bin = require(path.join(nm, 'ffmpeg-static'));
    ffmpegOk = Boolean(bin && fs.existsSync(bin));
  } catch (_) { /* not installed */ }
  if (!ffmpegOk) {
    try {
      const { spawnSync } = require('child_process');
      ffmpegOk = spawnSync('ffmpeg', ['-version'], { timeout: 5000 }).status === 0;
    } catch (_) { /* no system ffmpeg */ }
  }
  if (!ffmpegOk) issues.push('ffmpeg');

  // canvas: native binding, or the prebuilt @napi-rs/canvas fallback
  const canvasBinding = fs.existsSync(path.join(nm, 'canvas', 'build', 'Release', 'canvas.node'));
  const napiCanvas = fs.existsSync(path.join(nm, '@napi-rs', 'canvas'));
  if (!canvasBinding && !napiCanvas) issues.push('canvas');

  // sharp: prebuilt libvips binary
  const sharpOk = fs.existsSync(path.join(nm, 'sharp')) &&
    (fs.existsSync(path.join(nm, 'sharp', 'build', 'Release')) || fs.existsSync(path.join(nm, '@img')));
  if (!sharpOk) issues.push('sharp');

  return { ok: issues.length === 0, issues, ffmpegOk, canvasBinding, napiCanvas, sharpOk };
}

/**
 * Are the bot's runtime dependencies actually present?
 * We check the two modules the bot requires on its very first lines, so a
 * half-finished install is treated as "not installed".
 */
function depsInstalled() {
  const nm = path.join(BOT_DIR, 'node_modules');
  if (!fs.existsSync(nm)) return false;

  const pkgPath = path.join(BOT_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  let deps = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    deps = pkg.dependencies || {};
  } catch (e) {
    return false;
  }

  const names = Object.keys(deps);
  if (!names.length) return true;
  return names.every((name) => fs.existsSync(path.join(nm, name)));
}

let depsPromise = null;

/**
 * Ensure BOT_DIR/node_modules exists, installing it if needed.
 * Single-flight: concurrent callers share one npm process.
 * @param {(line:string)=>void} [onLine] optional log sink
 * @returns {Promise<{ok:boolean, skipped?:boolean}>}
 */
function ensureDependencies(onLine) {
  if (depsInstalled()) return Promise.resolve({ ok: true, skipped: true });
  if (depsPromise) return depsPromise;

  if (!fs.existsSync(path.join(BOT_DIR, 'package.json'))) {
    return Promise.reject(new Error('Bot code is not installed yet. Install the bot first.'));
  }

  setState({ depsInstalling: true, step: 'deps', message: 'Installing npm dependencies...', progress: 5 });

  depsPromise = new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: BOT_DIR,
        env: {
          ...process.env,
          PUPPETEER_SKIP_DOWNLOAD: 'true',
          PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true',
          NODE_ENV: 'production',
          // npm 11.6+/12 blocks lifecycle scripts by default, which leaves
          // native modules (sharp, canvas, ffmpeg-static, baileys) broken.
          // The bot source is our own trusted repo, so allow its scripts.
          NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: 'true',
          npm_config_dangerously_allow_all_scripts: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      depsPromise = null;
      setState({ depsInstalling: false, step: 'error', message: e.message, progress: 0 });
      return reject(e);
    }

    let out = '';
    const onData = (c) => {
      const text = c.toString();
      out += text;
      if (out.length > 4000) out = out.slice(-4000);
      setState({ message: out.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300) });
      if (onLine) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      depsPromise = null;
      setState({ depsInstalling: false, step: 'error', message: `npm not available: ${err.message}`, progress: 0 });
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code === 0 && depsInstalled()) {
        const nat = nativeStatus();
        if (!nat.ok) {
          // npm 11.6+/12 can still skip scripts for already-installed packages.
          // Force the native modules to rebuild before declaring success.
          setState({ message: 'Rebuilding native modules (' + nat.issues.join(', ') + ')...' });
          const rebuild = spawn('npm', ['rebuild', ...nat.issues], {
            cwd: BOT_DIR,
            env: {
              ...process.env,
              PUPPETEER_SKIP_DOWNLOAD: 'true',
              PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true',
              NODE_ENV: 'production',
              NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS: 'true',
              npm_config_dangerously_allow_all_scripts: 'true',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          rebuild.stdout.on('data', onData);
          rebuild.stderr.on('data', onData);
          rebuild.on('error', () => { /* fall through below */ });
          rebuild.on('exit', () => {
            depsPromise = null;
            const after = nativeStatus();
            setState({
              depsInstalling: false,
              step: 'done',
              message: after.ok
                ? 'Dependencies installed'
                : 'Dependencies installed, but native modules still incomplete: ' + after.issues.join(', '),
              progress: 100,
            });
            resolve({ ok: true, nativeIssues: after.issues });
          });
          return;
        }
        depsPromise = null;
        setState({ depsInstalling: false, step: 'done', message: 'Dependencies installed', progress: 100 });
        resolve({ ok: true });
      } else {
        depsPromise = null;
        const msg = code === 0 ? 'npm finished but modules are still missing' : `npm install failed (code ${code})`;
        setState({ depsInstalling: false, step: 'error', message: msg, progress: 0 });
        reject(new Error(msg));
      }
    });
  });

  return depsPromise;
}

/** Admin-triggered install. Returns immediately; progress is in getState(). */
function installDependencies() {
  if (depsInstalled()) {
    setState({ step: 'done', message: 'Dependencies already installed', progress: 100 });
    return { ok: true, already: true };
  }
  if (depsPromise) return { ok: true, started: true, alreadyRunning: true };
  if (!fs.existsSync(path.join(BOT_DIR, 'package.json'))) {
    return { ok: false, error: 'Bot code not installed yet' };
  }
  ensureDependencies().catch(() => {});
  return { ok: true, started: true };
}

module.exports = {
  BOT_DIR,
  DEFAULT_REPO_ZIP,
  getState,
  installFromGitHub,
  installFromBuffer,
  installDependencies,
  ensureDependencies,
  depsInstalled,
  nativeStatus,
  ensureBotHardening,
  ensurePerBotState,
  ensureCustomCommands,
  ensureWebBridge,
  ensureSessionFix,
};
