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
  'https://github.com/kids-codentando/Ladybug-Mini/archive/refs/heads/main.zip';

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
    await download(url, tmp);
    setState({ step: 'extract', message: 'Extracting files...', progress: 45 });
    const buffer = fs.readFileSync(tmp);
    const { count, skipped } = extractInto(buffer);
    const gate = ensurePremiumGate();
    const customCmds = ensureCustomCommands();
    const webBridge = ensureWebBridge();
    const sessionFix = ensureSessionFix();
    setState({
      step: 'done',
      message:
        `Installed ${count} files from GitHub` +
        (skipped.length ? ` — kept ${skipped.length} protected file(s)` : '') +
        (gate === 'reapplied' ? ' — premium gate re-applied' : '') +
        (gate === 'no-anchor' ? ' — WARNING: premium gate NOT applied' : '') +
        (customCmds === 'no-anchor' ? ' — WARNING: custom commands hook NOT applied' : '') +
        (webBridge === 'no-anchor' ? ' — WARNING: web console hook NOT applied' : '') +
        (/no-anchor|error/.test(sessionFix) ? ' — WARNING: session fix NOT applied (' + sessionFix + ')' : ''),
      progress: 100,
      installing: false,
      lastInstalledAt: new Date().toISOString(),
    });
    // Self-healing: a fresh checkout never has node_modules, so start the
    // dependency install straight away instead of waiting for the admin.
    if (!depsInstalled()) ensureDependencies().catch(() => {});
    return { ok: true, files: count, skipped, gate, customCmds, depsInstalling: !depsInstalled() };
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
        (/no-anchor|error/.test(sessionFix) ? ' — WARNING: session fix NOT applied (' + sessionFix + ')' : ''),
      progress: 100,
      installing: false,
      lastInstalledAt: new Date().toISOString(),
    });
    // Self-healing: a fresh checkout never has node_modules, so start the
    // dependency install straight away instead of waiting for the admin.
    if (!depsInstalled()) ensureDependencies().catch(() => {});
    return { ok: true, files: count, skipped, gate, customCmds, depsInstalling: !depsInstalled() };
  } catch (e) {
    setState({ step: 'error', message: e.message, progress: 0, installing: false });
    throw e;
  }
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
      depsPromise = null;
      if (code === 0 && depsInstalled()) {
        setState({ depsInstalling: false, step: 'done', message: 'Dependencies installed', progress: 100 });
        resolve({ ok: true });
      } else {
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
  ensureCustomCommands,
  ensureWebBridge,
  ensureSessionFix,
};
