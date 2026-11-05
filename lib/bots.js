/**
 * Bot Process Manager
 * Spawns one `node index.js` child process per bot instance, each with its own
 * SESSION_ID and session folder. Captures logs in a ring buffer, tracks status,
 * and supports auto-restart.
 */
const { spawn } = require('child_process');
const metrics = require('./metrics');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT_DIR = process.env.BOT_DIR || path.join(__dirname, '..', 'bots', 'ladybug');
const MAX_LOG_LINES = 600;

const events = require('./events');

/** botId -> runtime */
const runtimes = new Map();

function emptyRuntime(botId) {
  return {
    botId,
    proc: null,
    status: 'stopped', // stopped | starting | running | stopping | crashed
    pid: null,
    startedAt: null,
    stoppedAt: null,
    exitCode: null,
    logs: [],
    manualStop: false,
    restarts: 0,
    lastError: null,
    // WhatsApp connection state, learned from the bot's own log lines
    wa: { state: 'unknown', number: null, since: null },
  };
}

function getRuntime(botId) {
  if (!runtimes.has(botId)) runtimes.set(botId, emptyRuntime(botId));
  return runtimes.get(botId);
}

/** Follow the bot's WhatsApp connection by reading its log lines. */
function trackWhatsApp(rt, line) {
  if (line.startsWith('[host]') || line.startsWith('[deps]')) return;
  const set = (state) => {
    if (rt.wa.state !== state) {
      rt.wa = { ...rt.wa, state, since: Date.now() };
      if (state === 'logged_out') events.emit('bot', { botId: rt.botId, type: 'logged_out' });
      else if (state === 'conflict') events.emit('bot', { botId: rt.botId, type: 'conflict' });
    }
  };
  const num = /Bot Number:\s*(\d{5,})/.exec(line);
  if (num) rt.wa.number = num[1];
  if (/Bot connected successfully/i.test(line)) set('connected');
  else if (/Logged out|not reconnecting/i.test(line)) set('logged_out');
  else if (/Session conflict/i.test(line)) set('conflict');
  else if (/Connection closed/i.test(line)) set('reconnecting');
}

function pushLog(rt, stream, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    trackWhatsApp(rt, line);
    const entry = { t: Date.now(), stream, line: line.slice(0, 2000) };
    rt.logs.push(entry);
    events.emit('log', { botId: rt.botId, ...entry });
  }
  if (rt.logs.length > MAX_LOG_LINES) {
    rt.logs.splice(0, rt.logs.length - MAX_LOG_LINES);
  }
}

function failPending(rt, msg) {
  if (!rt.pending) return;
  for (const p of rt.pending.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); }
  rt.pending.clear();
}

/** Ask the running bot's web bridge something. Rejects if the bot is not running. */
function rpc(botId, method, params, timeoutMs = 10000) {
  const rt = getRuntime(botId);
  if (!rt.proc || rt.status !== 'running' || !rt.proc.connected) {
    return Promise.reject(Object.assign(new Error('The bot is not running. Start it first.'), { status: 409 }));
  }
  rt.pending = rt.pending || new Map();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(id);
      reject(Object.assign(new Error('The bot did not answer in time. It may still be connecting to WhatsApp.'), { status: 504 }));
    }, timeoutMs);
    rt.pending.set(id, { resolve, reject, timer });
    try { rt.proc.send({ type: 'rpc', id, method, params: params || {} }); }
    catch (e) { rt.pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

function uptimeEvent(botId, type, note) {
  events.emit('bot', { botId, type, detail: note || null });
  try { require('./uptime').recordEvent(require('./store'), botId, type, note); } catch (e) { /* never break the manager */ }
}

/** Paid feature: crash / back-online alerts to the owner's webhook (never throws). */
function sendAlert(bot, event, detail) {
  if (!event) return;
  if (event === 'online') events.emit('bot', { botId: bot.id, type: 'online' });
  try {
    const store = require('./store');
    const owner = store.findUserById(bot.userId);
    require('./alerts').notify(owner, bot, event, detail);
  } catch (e) { /* alerts must never break the bot manager */ }
}

function botCodeInstalled() {
  return fs.existsSync(path.join(BOT_DIR, 'index.js'));
}

function sessionDirFor(bot) {
  return path.join(BOT_DIR, `session_${bot.id}`);
}

/**
 * Start a bot instance.
 * @param {object} bot  bot record from store
 */
function start(bot) {
  const rt = getRuntime(bot.id);

  if (rt.proc && !rt.proc.killed) {
    return { ok: false, error: 'Bot is already running' };
  }
  if (!botCodeInstalled()) {
    rt.status = 'crashed';
    rt.lastError = 'Bot code is not installed. Ask the admin to install Ladybug Mini.';
    pushLog(rt, 'stderr', `[host] ${rt.lastError}`);
    return { ok: false, error: rt.lastError };
  }
  if (!bot.sessionId) {
    rt.status = 'crashed';
    rt.lastError = 'No session ID configured for this bot.';
    pushLog(rt, 'stderr', `[host] ${rt.lastError}`);
    return { ok: false, error: rt.lastError };
  }

  // Self-healing: on an ephemeral filesystem (e.g. Render free plan) the bot's
  // node_modules disappear on every redeploy. Install them before spawning so
  // the bot never crash-loops with "Cannot find module 'pino'".
  const installer = require('./installer');
  if (!installer.depsInstalled()) {
    rt.status = 'starting';
    rt.lastError = null;
    rt.restarts = 0;
    pushLog(rt, 'stdout', '[host] Bot dependencies are missing — installing them now (this can take 1-2 minutes)...');
    installer
      .ensureDependencies((line) => pushLog(rt, 'stdout', `[deps] ${line}`))
      .then(() => {
        pushLog(rt, 'stdout', '[host] Dependencies ready. Starting bot...');
        if (rt.manualStop) return;
        const store = require('./store');
        const fresh = store.findBotById(bot.id) || bot;
        start(fresh);
      })
      .catch((e) => {
        rt.status = 'crashed';
        rt.lastError = `Could not install bot dependencies: ${e.message}`;
        pushLog(rt, 'stderr', `[host] ${rt.lastError}`);
        pushLog(rt, 'stderr', '[host] Fix: Admin → Bot Installer → Install Dependencies, then restart the bot.');
      });
    return { ok: true, preparing: true, message: 'Installing bot dependencies...' };
  }

  rt.manualStop = false;
  rt.wa = { state: 'connecting', number: rt.wa ? rt.wa.number : null, since: Date.now() };
  rt.status = 'starting';
  rt.startedAt = Date.now();
  rt.stoppedAt = null;
  rt.exitCode = null;
  rt.lastError = null;

  const sessionFolder = sessionDirFor(bot);
  try {
    fs.mkdirSync(sessionFolder, { recursive: true });
  } catch (e) {
    /* ignore */
  }

  const env = {
    ...process.env,
    SESSION_ID: bot.sessionId,
    SESSION_NAME: `session_${bot.id}`,
    BOT_NAME: bot.name || 'Ladybug Mini',
    NODE_ENV: process.env.NODE_ENV || 'production',
    TMPDIR: path.join(os.tmpdir(), `ladybug_${bot.id}`),
    LADYBUG_BOT_ID: bot.id,
    LADYBUG_WEB: '1',
  };
  try { env.LADYBUG_AUTO = JSON.stringify(require('./wa-book').autoFor(bot.id)); } catch (e) { /* optional */ }

  // Custom commands created through the API (live-reloaded by the bot from this file).
  try {
    const store = require('./store');
    const billing = require('./billing');
    const cc = require('./customcommands');
    const owner = store.findUserById(bot.userId);
    const active = !!(owner && billing.apiLimits(owner).pro);
    cc.sync(bot, active);
    env.CUSTOM_COMMANDS_FILE = cc.filePath(bot.id);
  } catch (e) {
    pushLog(rt, 'stderr', `[host] could not prepare custom commands: ${e.message}`);
  }

  // Paid feature: custom environment variables. Only applied while the owner's
  // pass is active; the saved values are kept if it lapses.
  try {
    const store = require('./store');
    const billing = require('./billing');
    const owner = store.findUserById(bot.userId);
    if (owner && bot.env && billing.featureActive(owner, 'envvars')) {
      const { isBlocked } = require('./envvars');
      let n = 0;
      for (const [k, v] of Object.entries(bot.env)) {
        if (isBlocked(k)) continue;
        env[k] = String(v);
        n += 1;
      }
      if (n) pushLog(rt, 'stdout', `[host] Applied ${n} custom setting${n === 1 ? '' : 's'}.`);
    }
  } catch (e) {
    pushLog(rt, 'stderr', `[host] could not apply custom settings: ${e.message}`);
  }

  pushLog(rt, 'stdout', `[host] Starting "${bot.name}" ...`);

  let proc;
  try {
    proc = spawn(process.execPath, ['index.js'], {
      cwd: BOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch (e) {
    rt.status = 'crashed';
    rt.lastError = e.message;
    pushLog(rt, 'stderr', `[host] spawn failed: ${e.message}`);
    return { ok: false, error: e.message };
  }

  rt.proc = proc;
  rt.pid = proc.pid;
  rt.status = 'running';
  uptimeEvent(bot.id, 'started');
  if (rt.alertedDown) {
    // only announce "back online" once the bot has stayed up for 30s (not mid crash-loop)
    setTimeout(() => {
      if (rt.proc === proc && rt.status === 'running') {
        rt.alertedDown = false;
        sendAlert(bot, 'online');
      }
    }, 30000).unref();
  }

  // IPC channel: web console replies and live WhatsApp events from the bot's web bridge
  proc.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'rpc' && rt.pending && rt.pending.has(m.id)) {
      const p = rt.pending.get(m.id);
      rt.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    } else if (m.type === 'wa') {
      const { type, ...rest } = m;
      events.emit('wa', { ...rest, botId: rt.botId });
    }
  });
  proc.on('disconnect', () => failPending(rt, 'Bot disconnected'));

  proc.stdout.on('data', (c) => pushLog(rt, 'stdout', c));
  proc.stderr.on('data', (c) => pushLog(rt, 'stderr', c));

  proc.on('error', (err) => {
    rt.status = 'crashed';
    rt.lastError = err.message;
    pushLog(rt, 'stderr', `[host] process error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    failPending(rt, 'Bot stopped');
    rt.exitCode = code;
    rt.pid = null;
    rt.proc = null;
    rt.stoppedAt = Date.now();
    rt.wa = { ...rt.wa, state: 'offline', since: Date.now() };

    if (rt.manualStop) {
      rt.status = 'stopped';
      pushLog(rt, 'stdout', `[host] Bot stopped (code ${code}).`);
      uptimeEvent(bot.id, 'stopped');
      return;
    }

    rt.status = 'crashed';
    rt.lastError = `Exited with code ${code}${signal ? ` (${signal})` : ''}`;
    pushLog(rt, 'stderr', `[host] Bot crashed: ${rt.lastError}`);
    rt.alertedDown = true;
    uptimeEvent(bot.id, 'crashed', rt.lastError);
    sendAlert(bot, 'crashed', rt.lastError);

    // A missing dependency will never fix itself by restarting — stop the
    // crash-loop and tell the operator exactly what to do instead.
    const tail = rt.logs.slice(-25).map((l) => l.line).join('\n');
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(tail)) {
      rt.status = 'crashed';
      rt.lastError = 'Bot dependencies are missing. Run Admin → Bot Installer → Install Dependencies.';
      pushLog(rt, 'stderr', `[host] ${rt.lastError}`);
      pushLog(rt, 'stderr', '[host] Not auto-restarting: a missing module will not resolve on its own.');
      const installer = require('./installer');
      if (!installer.depsInstalled()) {
        installer.ensureDependencies((line) => pushLog(rt, 'stdout', `[deps] ${line}`)).catch(() => {});
      }
      return;
    }

    if (bot.autoRestart !== false && rt.restarts < 5) {
      rt.restarts += 1;
      const delay = Math.min(30000, 3000 * rt.restarts);
      pushLog(rt, 'stdout', `[host] Auto-restart in ${delay / 1000}s (attempt ${rt.restarts}/5)...`);
      setTimeout(() => {
        const store = require('./store');
        const fresh = store.findBotById(bot.id);
        if (fresh && fresh.status !== 'stopped' && !rt.manualStop) start(fresh);
      }, delay);
    }
  });

  return { ok: true, pid: proc.pid };
}

function stop(botId) {
  const rt = getRuntime(botId);
  if (!rt.proc) {
    rt.status = 'stopped';
    return { ok: true, already: true };
  }
  rt.manualStop = true;
  rt.status = 'stopping';
  rt.restarts = 0;
  pushLog(rt, 'stdout', '[host] Stopping bot...');
  try {
    rt.proc.kill('SIGTERM');
    setTimeout(() => {
      if (rt.proc) {
        try {
          rt.proc.kill('SIGKILL');
        } catch (e) {
          /* ignore */
        }
      }
    }, 8000);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

function restart(bot) {
  stop(bot.id);
  setTimeout(() => start(bot), 1200);
  return { ok: true };
}

function status(botId) {
  const rt = getRuntime(botId);
  return {
    status: rt.status,
    pid: rt.pid,
    startedAt: rt.startedAt,
    stoppedAt: rt.stoppedAt,
    exitCode: rt.exitCode,
    restarts: rt.restarts,
    lastError: rt.lastError,
    running: !!(rt.proc && !rt.proc.killed),
    wa: rt.wa,
    lastLogAt: rt.logs.length ? rt.logs[rt.logs.length - 1].t : null,
    resources: rt.pid ? metrics.get(rt.pid) : null,
  };
}

// Sample CPU/memory of every running bot process.
function sampleResources() {
  const pids = [];
  for (const rt of runtimes.values()) if (rt.pid && rt.proc) pids.push(rt.pid);
  metrics.tick(pids);
  return pids.length;
}

function logs(botId, limit = 200) {
  return getRuntime(botId).logs.slice(-limit);
}

function clearLogs(botId) {
  getRuntime(botId).logs = [];
}

function stopAll() {
  for (const rt of runtimes.values()) {
    if (rt.proc) {
      rt.manualStop = true;
      try {
        rt.proc.kill('SIGTERM');
      } catch (e) {
        /* ignore */
      }
    }
  }
}

/**
 * Watchdog helper: bring back a bot that should be running but is not.
 * Auto-restart gives up after 5 quick attempts, which is exactly what happens
 * when a redeploy briefly overlaps the old instance (WhatsApp rejects the
 * second connection for a few seconds). This resets the counter and tries again,
 * with an exponential back-off so a truly broken bot cannot hammer the host.
 * Returns true when a start was attempted.
 */
function revive(bot) {
  const rt = getRuntime(bot.id);
  if (rt.proc || rt.manualStop) return false;
  if (rt.status === 'starting' || rt.status === 'stopping' || rt.status === 'running') return false;
  const now = Date.now();
  rt.reviveCount = rt.reviveCount || 0;
  const wait = Math.min(15 * 60 * 1000, 60 * 1000 * Math.pow(2, Math.min(rt.reviveCount, 4)));
  if (rt.lastReviveAt && now - rt.lastReviveAt < wait) return false;
  rt.lastReviveAt = now;
  rt.reviveCount += 1;
  rt.restarts = 0;
  pushLog(rt, 'stdout', `[host] Watchdog: bot was down, starting it again (try ${rt.reviveCount}).`);
  const r = start(bot);
  return !!(r && r.ok);
}

/** A bot that has stayed up for a while earns a clean slate for the back-off. */
function markHealthy(botId) {
  const rt = getRuntime(botId);
  if (rt.proc && rt.status === 'running' && rt.startedAt && Date.now() - rt.startedAt > 5 * 60 * 1000) {
    rt.reviveCount = 0;
    rt.lastReviveAt = 0;
  }
}

function runningCount() {
  let n = 0;
  for (const rt of runtimes.values()) if (rt.proc) n += 1;
  return n;
}

module.exports = {
  revive,
  sampleResources,
  markHealthy,
  BOT_DIR,
  start,
  stop,
  restart,
  status,
  logs,
  clearLogs,
  stopAll,
  runningCount,
  botCodeInstalled,
  sessionDirFor,
  rpc,
};
