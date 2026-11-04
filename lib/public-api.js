/**
 * Ladybug Cloud public REST API  (v1)
 *
 * Auth:   Authorization: Bearer lbk_...   (create keys under API in the dashboard)
 * Base:   /api/v1
 *
 * Free:      read-only (account, bots, status, 24h uptime, logs), 1 key, 30 req/min.
 * API Pass:  write keys (start/stop/restart), bot provisioning, session pairing, env vars,
 *            signed webhooks, live log streaming, 30-day uptime + resource history,
 *            5 keys with expiry + IP allowlist, 600 req/min, usage stats.
 *
 * Deliberately a curated surface. API keys can NOT touch passwords, payments,
 * admin routes or the file drive. Cookie sessions are ignored here.
 */
module.exports = function mountPublicApi(ctx) {
  const {
    app, db, bots, billing, publicUser, botView, apikeys, webhooks, uptime, sessiongen,
    startBotFor, stopBotFor, restartBotFor, createBotFor, deleteBotFor, patchBotFor, setBotEnvFor, logScrubber,
    devices, restoreDeviceFor, pairingFor,
  } = ctx;
  const express = require('express');
  const events = require('./events');
  const { rateLimit } = require('./security');
  const v1 = express.Router();

  // CORS: the API uses bearer tokens (no cookies), so a wildcard origin is safe.
  v1.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After, X-Request-Id, Idempotent-Replay');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-API-Provider', 'Ntandomods Developers');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!req.path.endsWith('/stream')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Every response carries X-Request-Id. Errors always look like
  //   { error: "human readable", code: "machine_readable", requestId: "req_..." }
  const ERROR_CODES = {
    400: 'invalid_request', 401: 'unauthorized', 402: 'payment_required', 403: 'forbidden', 404: 'not_found',
    405: 'method_not_allowed', 409: 'conflict', 413: 'payload_too_large', 422: 'unprocessable', 429: 'rate_limited',
  };
  v1.use((req, res, next) => {
    const incoming = String(req.headers['x-request-id'] || '').replace(/[^\w.-]/g, '').slice(0, 64);
    const requestId = incoming || 'req_' + require('crypto').randomBytes(8).toString('hex');
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && body.error) {
        body = { error: body.error, code: body.code || ERROR_CODES[res.statusCode] || (res.statusCode >= 500 ? 'server_error' : 'error'), ...body, requestId };
      }
      return json(body);
    };
    next();
  });

  // Idempotency-Key on POST: retrying the same request within 10 minutes replays the first
  // successful answer instead of creating a duplicate bot or command.
  const idem = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of idem) if (v.exp <= now) idem.delete(k); }, 60_000).unref();
  v1.use((req, res, next) => {
    const key = String(req.headers['idempotency-key'] || '').trim();
    if (req.method !== 'POST' || !key || key.length > 80) return next();
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return next();
    const id = require('crypto').createHash('sha256').update(m[1] + '|' + req.path + '|' + key).digest('hex');
    const hit = idem.get(id);
    if (hit) {
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(hit.status).json(hit.body);
    }
    const json = res.json;
    res.json = function (body) {
      if (res.statusCode >= 200 && res.statusCode < 300) idem.set(id, { status: res.statusCode, body, exp: Date.now() + 600_000 });
      return json.call(this, body);
    };
    next();
  });

  const fail = (res, code, error, extra) => res.status(code).json({ error, ...(extra || {}) });
  const UPGRADE = { upgrade: '/#/pay?buy=api' };

  // Anonymous endpoints and failed logins share a per-IP limiter so key guessing is throttled.
  const ipLimiter = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many requests from this address. Slow down.' });
  const failLimiter = rateLimit({ windowMs: 60_000, max: 30, message: 'Too many failed authentication attempts. Try again in a minute.' });

  // Per-key fixed window (limit depends on the owner's plan).
  const windows = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of windows) if (v.reset <= now) windows.delete(k);
  }, 60_000).unref();

  function keyLimit(req, res, limits) {
    const now = Date.now();
    let w = windows.get(req.apiKey.id);
    if (!w || w.reset <= now) { w = { n: 0, reset: now + 60_000 }; windows.set(req.apiKey.id, w); }
    w.n++;
    res.setHeader('X-RateLimit-Limit', String(limits.perMinute));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limits.perMinute - w.n)));
    if (w.n > limits.perMinute) {
      res.setHeader('Retry-After', String(Math.ceil((w.reset - now) / 1000)));
      fail(res, 429, `Rate limit exceeded (${limits.perMinute} requests per minute on your plan).`, limits.pro ? {} : UPGRADE);
      return false;
    }
    return true;
  }

  /**
   * auth(scope, { pro })
   *   scope 'write' needs a write key AND an active API Pass.
   *   pro: true     needs an active API Pass whatever the key's scope.
   */
  function auth(scope, opts = {}) {
    return (req, res, next) => {
      const deny = (code, msg, extra) => failLimiter(req, res, () => fail(res, code, msg, extra));
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
      if (!m) return deny(401, 'Missing API key. Send "Authorization: Bearer lbk_..."');
      const found = apikeys.authenticate(m[1], req.ip);
      if (found.error) return deny(found.code, found.error);
      const limits = billing.apiLimits(found.user);
      req.user = found.user;
      req.apiKey = found.key;
      req.limits = limits;
      if (!keyLimit(req, res, limits)) return;
      if (scope === 'write' && found.key.scope !== 'write') {
        return fail(res, 403, 'This key is read-only. Create a key with the "write" scope.');
      }
      if ((scope === 'write' || opts.pro) && !limits.pro) {
        return fail(res, 402, 'This needs the API Pass ($' + billing.cfg.apiPriceUsd + '/month).', UPGRADE);
      }
      apikeys.recordUse(found.key);
      next();
    };
  }

  // API keys only ever see the owner's own bots (admin elevation does not apply).
  function ownBot(req, res) {
    const bot = db.findBotById(req.params.id);
    if (!bot || bot.userId !== req.user.id) {
      fail(res, 404, 'Bot not found');
      return null;
    }
    return bot;
  }
  const send = (res, r) => res.status(r.code).json(r.body);

  // ---- discovery (no key needed)
  v1.get('/', ipLimiter, (req, res) => {
    res.json({
      name: 'Ladybug Cloud API',
      version: 'v1',
      poweredBy: 'Ntandomods Developers',
      docs: '/#/developers',
      openapi: '/api/v1/openapi.json',
      auth: 'Authorization: Bearer lbk_..._ntandomods',
    });
  });
  v1.get('/openapi.json', ipLimiter, (req, res) => res.json(openapi()));
  v1.get('/ping', ipLimiter, (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // ---- account
  v1.get('/me', auth('read'), (req, res) => {
    res.json({
      user: publicUser(req.user),
      key: { id: req.apiKey.id, name: req.apiKey.name, scope: req.apiKey.scope, expiresAt: req.apiKey.expiresAt || null },
      plan: { apiPass: req.limits.pro, limits: req.limits },
    });
  });

  v1.get('/billing', auth('read'), (req, res) => res.json(billing.summary(req.user)));

  v1.get('/usage', auth('read'), (req, res) => {
    const u = req.apiKey.usage || {};
    res.json({
      key: req.apiKey.id,
      perMinuteLimit: req.limits.perMinute,
      totals: apikeys.usageTotals(req.apiKey),
      daily: Object.keys(u).sort().map((d) => ({ date: d, requests: u[d] })),
      allKeys: apikeys.list(req.user).map((k) => ({ id: k.id, name: k.name, ...k.usage })),
    });
  });

  // ---- bots: read
  v1.get('/bots', auth('read'), (req, res) => {
    // ?status=running|stopped|crashed  ?q=name  ?limit (1-100, default 50)  ?offset
    let list = db.botsForUser(req.user.id).map(botView);
    if (req.query.status) list = list.filter((b) => b.status === String(req.query.status));
    if (req.query.q) { const q = String(req.query.q).toLowerCase(); list = list.filter((b) => String(b.name).toLowerCase().includes(q)); }
    const total = list.length;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
    res.json({
      bots: list.slice(offset, offset + limit),
      page: { total, limit, offset, hasMore: offset + limit < total, nextOffset: offset + limit < total ? offset + limit : null },
      limit: billing.botLimitFor(req.user),
    });
  });

  v1.get('/bots/:id', auth('read'), (req, res) => {
    const bot = ownBot(req, res);
    if (bot) res.json({ bot: botView(bot) });
  });

  v1.get('/bots/:id/logs', auth('read'), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '200', 10) || 200));
    const scrub = logScrubber(bot);
    // ?since=<ms timestamp or ISO date>  ?stream=stdout|stderr  ?q=text
    let since = 0;
    if (req.query.since) since = /^\d+$/.test(req.query.since) ? Number(req.query.since) : Date.parse(req.query.since) || 0;
    const q = req.query.q ? String(req.query.q).toLowerCase().slice(0, 100) : '';
    let rows = bots.logs(bot.id, 1000).map((l) => ({ ...l, line: scrub(l.line) }));
    if (since) rows = rows.filter((l) => l.t > since);
    if (req.query.stream === 'stdout' || req.query.stream === 'stderr') rows = rows.filter((l) => l.stream === req.query.stream);
    if (q) rows = rows.filter((l) => l.line.toLowerCase().includes(q));
    rows = rows.slice(-limit);
    res.json({ logs: rows, cursor: rows.length ? rows[rows.length - 1].t : since || null, status: bots.status(bot.id) });
  });

  // 24h for everyone, 30 days + full event list with the API Pass (or the Uptime pass)
  v1.get('/bots/:id/uptime', auth('read'), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const full = billing.featureActive(req.user, 'uptime');
    res.json({ ...uptime.report(bot, full), summary: billing.featureSummary(req.user, 'uptime') });
  });

  v1.get('/bots/:id/resources', auth('read', { pro: true }), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours || '24', 10) || 24));
    res.json({ hours, current: bots.status(bot.id).resources, history: uptime.resourceReport(bot, hours) });
  });

  // Live log stream (Server-Sent Events). Use curl -N or fetch() streaming with the Authorization header.
  const streams = new Map(); // userId -> open count
  v1.get('/bots/:id/logs/stream', auth('read', { pro: true }), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const open = streams.get(req.user.id) || 0;
    if (open >= req.limits.maxStreams) {
      return fail(res, 429, `At most ${req.limits.maxStreams} log streams at the same time.`);
    }
    streams.set(req.user.id, open + 1);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (chunk) => { res.write(chunk); if (typeof res.flush === 'function') res.flush(); };
    const scrub = logScrubber(bot);
    const emitLog = (l) => write(`event: log\ndata: ${JSON.stringify({ t: l.t, stream: l.stream, line: scrub(l.line) })}\n\n`);

    write('retry: 5000\n\n');
    const tail = Math.min(200, Math.max(0, parseInt(req.query.tail || '50', 10) || 0));
    if (tail) bots.logs(bot.id, tail).forEach(emitLog);

    const onLog = (l) => { if (l.botId === bot.id) emitLog(l); };
    const onBot = (e) => {
      if (e.botId === bot.id) write(`event: bot\ndata: ${JSON.stringify({ type: e.type, detail: e.detail || null, at: new Date().toISOString() })}\n\n`);
    };
    events.bus.on('log', onLog);
    events.bus.on('bot', onBot);
    const beat = setInterval(() => write(': keep-alive\n\n'), 20_000);
    const maxAge = setTimeout(() => { write('event: end\ndata: {"reason":"max-duration"}\n\n'); res.end(); }, 30 * 60_000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      clearTimeout(maxAge);
      events.bus.off('log', onLog);
      events.bus.off('bot', onBot);
      streams.set(req.user.id, Math.max(0, (streams.get(req.user.id) || 1) - 1));
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });


  // ---- WhatsApp-safety guardrails ------------------------------------------------
  // Rapid reconnects and repeated pairing requests are the classic way automation gets
  // numbers flagged. These limits protect your customers' numbers (and the platform's IP).
  const CONNECT_COOLDOWN_MS = 30_000; // min gap between start/restart of one bot
  const CONNECT_PER_HOUR = 6; //        max start/restart calls per bot per hour
  const PAIR_PER_HOUR = 5; //           max pairing requests per account per hour
  const PAIR_PER_PHONE_HOUR = 2; //     max pairing requests per phone number per hour
  const connectHits = new Map(); // botId -> [timestamps]
  const pairHits = new Map(); //    key -> [timestamps]

  function hit(map, key, windowMs, max, minGapMs) {
    const now = Date.now();
    const arr = (map.get(key) || []).filter((t) => now - t < windowMs);
    if (minGapMs && arr.length && now - arr[arr.length - 1] < minGapMs) {
      return { ok: false, wait: Math.ceil((minGapMs - (now - arr[arr.length - 1])) / 1000), why: 'cooldown' };
    }
    if (arr.length >= max) return { ok: false, wait: Math.ceil((windowMs - (now - arr[0])) / 1000), why: 'hourly' };
    arr.push(now);
    map.set(key, arr);
    return { ok: true };
  }
  setInterval(() => {
    const now = Date.now();
    for (const m of [connectHits, pairHits]) for (const [k, v] of m) if (!v.some((t) => now - t < 3600_000)) m.delete(k);
  }, 10 * 60_000).unref();

  function guardConnect(req, res, bot) {
    const g = hit(connectHits, bot.id, 3600_000, CONNECT_PER_HOUR, CONNECT_COOLDOWN_MS);
    if (g.ok) return true;
    res.setHeader('Retry-After', String(g.wait));
    fail(res, 429,
      g.why === 'cooldown'
        ? `Wait ${g.wait}s before starting or restarting this bot again. Rapid reconnects can get a WhatsApp number flagged.`
        : `This bot was started or restarted ${CONNECT_PER_HOUR} times in the last hour. Try again in ${Math.ceil(g.wait / 60)} min. Reconnect loops can get a WhatsApp number banned.`,
      { guardrail: 'whatsapp-safety', retryAfter: g.wait });
    return false;
  }

  function guardPair(req, res) {
    const phone = String((req.body || {}).phone || '').replace(/\D/g, '');
    const a = hit(pairHits, 'u:' + req.user.id, 3600_000, PAIR_PER_HOUR);
    const b = phone ? hit(pairHits, 'p:' + phone, 3600_000, PAIR_PER_PHONE_HOUR) : { ok: true };
    if (a.ok && b.ok) return true;
    const wait = Math.max(a.wait || 0, b.wait || 0);
    res.setHeader('Retry-After', String(wait));
    fail(res, 429,
      `Too many pairing attempts. Retry in ${Math.ceil(wait / 60)} min. Repeated pairing requests for the same number are a common trigger for WhatsApp restrictions.`,
      { guardrail: 'whatsapp-safety', retryAfter: wait });
    return false;
  }

  // ---- bots: control (API Pass + write key)
  v1.post('/bots/:id/start', auth('write'), (req, res) => { const b = ownBot(req, res); if (b && guardConnect(req, res, b)) send(res, startBotFor(b, req.user)); });
  v1.post('/bots/:id/stop', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) send(res, stopBotFor(b)); });
  v1.post('/bots/:id/restart', auth('write'), (req, res) => { const b = ownBot(req, res); if (b && guardConnect(req, res, b)) send(res, restartBotFor(b, req.user)); });

  // ---- provisioning (API Pass + write key)
  v1.post('/bots', auth('write'), (req, res) => send(res, createBotFor(req.user, req.body || {})));
  v1.patch('/bots/:id', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) send(res, patchBotFor(b, req.body)); });
  v1.delete('/bots/:id', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) send(res, deleteBotFor(b)); });

  v1.get('/bots/:id/env', auth('read', { pro: true }), (req, res) => {
    const b = ownBot(req, res);
    if (b) res.json({ env: b.env || {}, max: ctx.envvars.MAX_VARS });
  });
  v1.put('/bots/:id/env', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) send(res, setBotEnvFor(b, req.body && req.body.env)); });

  // ---- web console: read and send WhatsApp messages as the bot's number (API Pass)
  const wc = require('./webconsole');
  v1.get('/bots/:id/web/chats', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.chats(b, req, res); });
  v1.get('/bots/:id/web/messages', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.messages(b, req, res); });
  v1.get('/bots/:id/web/presence', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.presence(b, req, res); });
  v1.get('/bots/:id/web/avatar', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.avatar(b, req, res); });
  v1.get('/bots/:id/web/info', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.info(b, req, res); });
  v1.post('/bots/:id/web/typing', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.typing(b, req, res); });
  v1.get('/bots/:id/web/stream', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.stream(b, req, res, req.user.id); });
  v1.post('/bots/:id/web/send', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.send(b, req, res); });
  v1.post('/bots/:id/web/read', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.read(b, req, res); });
  v1.get('/bots/:id/web/profile', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.profile(b, req, res); });
  v1.post('/bots/:id/web/profile', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.profileSet(b, req, res); });
  v1.get('/bots/:id/web/privacy', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.privacy(b, req, res); });
  v1.post('/bots/:id/web/privacy', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.privacySet(b, req, res); });
  v1.get('/bots/:id/web/blocklist', auth('read', { pro: true }), (req, res) => { const b = ownBot(req, res); if (b) wc.blocklist(b, req, res); });
  v1.post('/bots/:id/web/block', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.block(b, req, res); });
  v1.post('/bots/:id/web/disappearing', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.disappearing(b, req, res); });
  v1.post('/bots/:id/web/lookup', auth('write'), (req, res) => { const b = ownBot(req, res); if (b) wc.lookup(b, req, res); });

  // ---- linked devices: every number you ever linked, ready to restore (no new pairing needed)
  v1.get('/devices', auth('read'), (req, res) => res.json({ devices: devices.list(req.user), max: devices.MAX_DEVICES }));
  v1.post('/devices/:id/restore', auth('write'), (req, res) => {
    const dev = devices.find(req.user, req.params.id);
    if (!dev) return fail(res, 404, 'Device not found');
    send(res, restoreDeviceFor(req.user, dev, req.body || {}));
  });
  v1.patch('/devices/:id', auth('write'), (req, res) => {
    const d = devices.rename(req.user, req.params.id, (req.body || {}).label);
    if (!d) return fail(res, 404, 'Device not found');
    res.json({ ok: true, device: devices.view(d) });
  });
  v1.delete('/devices/:id', auth('write'), (req, res) => {
    if (!devices.remove(req.user, req.params.id)) return fail(res, 404, 'Device not found');
    res.json({ ok: true });
  });

  // ---- WhatsApp pairing so resellers can onboard their customers (API Pass + write key)
  const pairOwners = new Map(); // jobId -> userId
  v1.post('/session/pair', auth('write'), (req, res) => {
    if (!guardPair(req, res)) return;
    try {
      const job = sessiongen.start((req.body || {}).phone);
      pairOwners.set(job.id, req.user.id);
      setTimeout(() => pairOwners.delete(job.id), 30 * 60_000).unref();
      res.json({ ok: true, job });
    } catch (e) {
      fail(res, e.status || 500, e.message);
    }
  });
  v1.get('/session/pair/:id', auth('read', { pro: true }), (req, res) => {
    const job = pairOwners.get(req.params.id) === req.user.id ? sessiongen.get(req.params.id) : null;
    if (!job) return fail(res, 404, 'Pairing job not found or expired.');
    res.json({ ok: true, job: pairingFor(req.user, job) });
  });
  v1.delete('/session/pair/:id', auth('write'), (req, res) => {
    if (pairOwners.get(req.params.id) !== req.user.id) return fail(res, 404, 'Pairing job not found or expired.');
    sessiongen.cancel(req.params.id);
    pairOwners.delete(req.params.id);
    res.json({ ok: true });
  });

  // ---- webhooks (API Pass)
  v1.get('/webhooks', auth('read', { pro: true }), (req, res) => {
    res.json({ webhooks: webhooks.list(req.user), events: webhooks.BOT_EVENTS, max: req.limits.maxWebhooks });
  });
  v1.post('/webhooks', auth('write'), async (req, res) => {
    const r = await webhooks.create(req.user, req.body || {});
    if (r.error) return fail(res, r.code || 400, r.error);
    res.status(201).json({ ok: true, webhook: r.webhook, secret: r.secret, note: 'Store the secret now. It is not shown again.' });
  });
  v1.delete('/webhooks/:id', auth('write'), (req, res) => {
    if (!webhooks.remove(req.user, req.params.id)) return fail(res, 404, 'Webhook not found');
    res.json({ ok: true });
  });
  v1.post('/webhooks/:id/test', auth('write'), async (req, res) => {
    const r = await webhooks.sendTest(req.user, req.params.id);
    if (!r) return fail(res, 404, 'Webhook not found');
    res.json(r);
  });
  v1.post('/webhooks/:id/:action(enable|disable)', auth('write'), (req, res) => {
    const w = webhooks.setActive(req.user, req.params.id, req.params.action === 'enable');
    if (!w) return fail(res, 404, 'Webhook not found');
    res.json({ ok: true, webhook: w });
  });

  // ---- batch control: one call, many bots (API Pass + write key)
  // Same WhatsApp-safety guardrails apply per bot, so a batch can partly succeed.
  v1.post('/bots/actions', auth('write'), (req, res) => {
    const { action, ids } = req.body || {};
    if (!['start', 'stop', 'restart'].includes(action)) return fail(res, 400, 'action must be "start", "stop" or "restart".');
    if (!Array.isArray(ids) || !ids.length || ids.length > 25) return fail(res, 400, 'ids must be an array of 1-25 bot ids.');
    const results = [...new Set(ids.map(String))].map((id) => {
      const bot = db.findBotById(id);
      if (!bot || bot.userId !== req.user.id) return { id, ok: false, status: 404, error: 'Bot not found' };
      if (action !== 'stop') {
        const g = hit(connectHits, bot.id, 3600_000, CONNECT_PER_HOUR, CONNECT_COOLDOWN_MS);
        if (!g.ok) return { id, ok: false, status: 429, error: 'Skipped by WhatsApp-safety guardrail', retryAfter: g.wait };
      }
      const r = action === 'start' ? startBotFor(bot, req.user) : action === 'stop' ? stopBotFor(bot) : restartBotFor(bot, req.user);
      return { id, ok: r.code < 300, status: r.code, ...(r.code >= 300 ? { error: r.body.error } : {}) };
    });
    res.status(results.every((r) => r.ok) ? 200 : 207).json({ action, results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  });

  // ---- custom commands: users define commands the bot answers in WhatsApp (API Pass)
  const cc = require('./customcommands');
  const pushCommands = (bot, req) => cc.sync(db.findBotById(bot.id), req.limits.pro);

  v1.get('/commands/meta', auth('read', { pro: true }), (req, res) => {
    res.json({
      types: cc.TYPES, access: cc.ACCESS, scope: cc.SCOPES,
      maxPerBot: cc.limitFor(req.limits),
      placeholders: ['{name}', '{sender}', '{args}', '{arg1}..{arg9}', '{command}', '{group}', '{botname}', '{prefix}', '{date}', '{time}'],
      webhook: {
        method: 'POST (default) or GET, HTTPS only, 5s timeout',
        signature: 'X-Ladybug-Signature: sha256=HMAC_SHA256(body, command secret)',
        request: { command: 'string', args: ['string'], text: 'string', sender: 'phone number', pushName: 'string', isGroup: 'boolean', group: '{id,name}|null', isOwner: 'boolean', isAdmin: 'boolean', botId: 'string' },
        reply: 'Plain text, or JSON {"reply": "text"} or {"image": "https://...", "caption": "text"}',
      },
      note: 'Custom commands take priority over built-in commands with the same name. Edits go live in the running bot within a second, no restart needed.',
    });
  });

  v1.get('/bots/:id/commands', auth('read', { pro: true }), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const list = cc.list(b);
    res.json({ commands: list, total: list.length, max: cc.limitFor(req.limits) });
  });

  v1.post('/bots/:id/commands', auth('write'), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const r = cc.create(db, b, req.limits, req.body);
    if (r.error) return fail(res, r.code || 400, r.error);
    pushCommands(b, req);
    res.status(201).json({
      ok: true, command: r.command,
      ...(r.secret ? { secret: r.secret, note: 'Store the secret now. It signs every request to your webhook and is not shown again.' } : {}),
    });
  });

  // Create up to 25 at once. All-or-nothing: if one is invalid nothing is saved.
  v1.post('/bots/:id/commands/bulk', auth('write'), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const items = (req.body || {}).commands;
    if (!Array.isArray(items) || !items.length || items.length > 25) return fail(res, 400, 'commands must be an array of 1-25 command objects.');
    const max = cc.limitFor(req.limits);
    if (!max) return fail(res, 402, 'Custom commands need the API Pass.', UPGRADE);
    if ((b.customCommands || []).length + items.length > max) return fail(res, 400, `That would exceed the ${max} commands per bot limit.`);
    const before = JSON.parse(JSON.stringify(b.customCommands || []));
    const created = [];
    for (let i = 0; i < items.length; i++) {
      const fresh = db.findBotById(b.id);
      const r = cc.create(db, fresh, req.limits, items[i]);
      if (r.error) {
        db.updateBot(b.id, { customCommands: before });
        return fail(res, r.code || 400, `commands[${i}]: ${r.error}`, { index: i });
      }
      created.push({ ...r.command, ...(r.secret ? { secret: r.secret } : {}) });
    }
    pushCommands(b, req);
    res.status(201).json({ ok: true, commands: created, note: 'Webhook secrets are shown once. Store them now.' });
  });

  v1.get('/bots/:id/commands/:cid', auth('read', { pro: true }), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const c = cc.find(b, req.params.cid);
    if (!c) return fail(res, 404, 'Command not found');
    res.json({ command: cc.view(c) });
  });

  v1.patch('/bots/:id/commands/:cid', auth('write'), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const r = cc.update(db, b, req.params.cid, req.body);
    if (r.error) return fail(res, r.code || 400, r.error);
    pushCommands(b, req);
    res.json({ ok: true, command: r.command });
  });

  v1.delete('/bots/:id/commands/:cid', auth('write'), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    if (!cc.remove(db, b, req.params.cid)) return fail(res, 404, 'Command not found');
    pushCommands(b, req);
    res.json({ ok: true });
  });

  v1.post('/bots/:id/commands/:cid/:action(enable|disable)', auth('write'), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const r = cc.update(db, b, req.params.cid, { enabled: req.params.action === 'enable' });
    if (r.error) return fail(res, r.code || 400, r.error);
    pushCommands(b, req);
    res.json({ ok: true, command: r.command });
  });

  v1.post('/bots/:id/commands/:cid/rotate-secret', auth('write'), (req, res) => {
    const b = ownBot(req, res);
    if (!b) return;
    const r = cc.rotateSecret(db, b, req.params.cid);
    if (r.error) return fail(res, r.code || 400, r.error);
    pushCommands(b, req);
    res.json({ ok: true, secret: r.secret, note: 'Store the secret now. The old one no longer works.' });
  });

  v1.use((req, res) => fail(res, 404, 'Unknown API endpoint. See /api/v1/openapi.json'));

  app.use('/api/v1', v1);
};

function openapi() {
  const bearer = [{ bearerAuth: [] }];
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const base = { 401: { description: 'Missing or invalid key' }, 429: { description: 'Rate limited' } };
  const free = { 200: { description: 'Success' }, ...base };
  const pass = { 200: { description: 'Success' }, ...base, 402: { description: 'Needs the API Pass' }, 403: { description: 'Read-only key' } };
  const cid = { name: 'cid', in: 'path', required: true, description: 'Command id or name', schema: { type: 'string' } };
  const cmdSchema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', example: 'hello', description: 'Without the prefix. a-z, 0-9, - and _' },
      aliases: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      type: { type: 'string', enum: ['text', 'image', 'webhook'], default: 'text' },
      response: { type: 'string', example: 'Hi {name}! You said: {args}', description: 'Reply text (text) or caption (image). Max 2000 characters.' },
      imageUrl: { type: 'string', description: 'Required for type "image"' },
      url: { type: 'string', description: 'Required for type "webhook" (HTTPS)' },
      method: { type: 'string', enum: ['POST', 'GET'], default: 'POST' },
      description: { type: 'string', maxLength: 120 },
      access: { type: 'string', enum: ['everyone', 'admins', 'owner'], default: 'everyone' },
      scope: { type: 'string', enum: ['any', 'group', 'private'], default: 'any' },
      cooldownSeconds: { type: 'integer', minimum: 0, maximum: 3600, default: 0 },
      enabled: { type: 'boolean', default: true },
    },
  };
  const op = (summary, responses, extra) => ({ summary, security: bearer, responses, ...(extra || {}) });
  return {
    openapi: '3.0.3',
    info: {
      title: 'Ladybug Cloud API',
      version: '1.3.0',
      contact: { name: 'Ntandomods Developers' },
      description: 'Powered by Ntandomods Developers. Manage your Ladybug Cloud WhatsApp bots programmatically. Operations marked "(API Pass)" need an active API Pass.',
    },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Personal API key (lbk_..._ntandomods)' } } },
    paths: {
      '/ping': { get: { summary: 'Health check (no key needed)', responses: { 200: { description: 'pong' } } } },
      '/me': { get: op('Current account, key and plan limits', free) },
      '/billing': { get: op('Coins, trial and pass status', free) },
      '/usage': { get: op('Request counts for this key', free) },
      '/bots': {
        get: op('List your bots', free),
        post: op('Create a bot (API Pass)', pass, { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'sessionId'], properties: { name: { type: 'string' }, sessionId: { type: 'string' } } } } } } }),
      },
      '/bots/{id}': {
        get: op('Get one bot', free, { parameters: [id] }),
        patch: op('Rename / change session / auto-restart (API Pass)', pass, { parameters: [id] }),
        delete: op('Delete a bot (API Pass)', pass, { parameters: [id] }),
      },
      '/bots/{id}/logs': { get: op('Recent log lines (secrets hidden)', free, { parameters: [id, { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 1000 } }] }) },
      '/bots/{id}/logs/stream': { get: op('Live logs via Server-Sent Events (API Pass)', pass, { parameters: [id, { name: 'tail', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } }] }) },
      '/bots/{id}/uptime': { get: op('Uptime report: 24h free, 30 days with a pass', free, { parameters: [id] }) },
      '/bots/{id}/resources': { get: op('Hourly memory / CPU history, up to 7 days (API Pass)', pass, { parameters: [id, { name: 'hours', in: 'query', schema: { type: 'integer', default: 24, maximum: 168 } }] }) },
      '/bots/{id}/env': {
        get: op('Read custom env vars (API Pass)', pass, { parameters: [id] }),
        put: op('Replace custom env vars (API Pass)', pass, { parameters: [id], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { env: { type: 'object', additionalProperties: { type: 'string' } } } } } } } }),
      },
      '/bots/{id}/start': { post: op('Start a bot (API Pass)', pass, { parameters: [id] }) },
      '/bots/{id}/stop': { post: op('Stop a bot (API Pass)', pass, { parameters: [id] }) },
      '/bots/{id}/restart': { post: op('Restart a bot (API Pass)', pass, { parameters: [id] }) },
      '/bots/{id}/web/chats': { get: op('WhatsApp Web: chats of the bot number, newest first (API Pass)', pass, { parameters: [id, { name: 'q', in: 'query', schema: { type: 'string' } }] }) },
      '/bots/{id}/web/messages': { get: op('WhatsApp Web: messages of one chat (API Pass)', pass, { parameters: [id, { name: 'jid', in: 'query', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } }, { name: 'before', in: 'query', description: 'Unix seconds, for older pages', schema: { type: 'integer' } }] }) },
      '/bots/{id}/web/send': { post: op('Send text, a reply (quotedId) or a reaction (react + quotedId); 20/min per bot (API Pass)', pass, { parameters: [id], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['jid'], properties: { jid: { type: 'string', example: '27821234567@s.whatsapp.net' }, text: { type: 'string' }, quotedId: { type: 'string' }, react: { type: 'string' } } } } } } }) },
      '/bots/{id}/web/read': { post: op('Mark a chat as read (API Pass)', pass, { parameters: [id] }) },
      '/bots/{id}/web/lookup': { post: op('Check a phone number is on WhatsApp and get its chat id (API Pass)', pass, { parameters: [id] }) },
      '/bots/{id}/web/stream': { get: op('Live messages as Server-Sent Events (API Pass)', pass, { parameters: [id] }) },
      '/devices': { get: op('Every WhatsApp number you have linked, with status', free) },
      '/devices/{id}/restore': { post: op('Restore a saved device onto a new bot ({name}) or an existing stopped bot ({botId}) without pairing again (API Pass)', pass, { parameters: [id] }) },
      '/devices/{id}': {
        patch: op('Rename a saved device (API Pass)', pass, { parameters: [id] }),
        delete: op('Forget a saved device (API Pass)', pass, { parameters: [id] }),
      },
      '/session/pair': { post: op('Start WhatsApp pairing for a phone number (API Pass)', pass, { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['phone'], properties: { phone: { type: 'string' } } } } } } }) },
      '/session/pair/{id}': {
        get: op('Poll a pairing job; returns the session id when ready (API Pass)', pass, { parameters: [id] }),
        delete: op('Cancel a pairing job (API Pass)', pass, { parameters: [id] }),
      },
      '/bots/actions': { post: op('Start, stop or restart up to 25 bots in one call (API Pass)', pass, { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['action', 'ids'], properties: { action: { type: 'string', enum: ['start', 'stop', 'restart'] }, ids: { type: 'array', items: { type: 'string' }, maxItems: 25 } } } } } } }) },
      '/commands/meta': { get: op('Command types, placeholders and webhook format (API Pass)', pass) },
      '/bots/{id}/commands': {
        get: op('List custom commands (API Pass)', pass, { parameters: [id] }),
        post: op('Create a custom command the bot answers in WhatsApp (API Pass)', pass, { parameters: [id], requestBody: { content: { 'application/json': { schema: cmdSchema } } } }),
      },
      '/bots/{id}/commands/bulk': { post: op('Create up to 25 commands at once, all or nothing (API Pass)', pass, { parameters: [id] }) },
      '/bots/{id}/commands/{cid}': {
        get: op('Get one command (API Pass)', pass, { parameters: [id, cid] }),
        patch: op('Update a command; changes go live without a restart (API Pass)', pass, { parameters: [id, cid], requestBody: { content: { 'application/json': { schema: cmdSchema } } } }),
        delete: op('Delete a command (API Pass)', pass, { parameters: [id, cid] }),
      },
      '/bots/{id}/commands/{cid}/enable': { post: op('Enable a command (API Pass)', pass, { parameters: [id, cid] }) },
      '/bots/{id}/commands/{cid}/disable': { post: op('Disable a command (API Pass)', pass, { parameters: [id, cid] }) },
      '/bots/{id}/commands/{cid}/rotate-secret': { post: op('New webhook signing secret (API Pass)', pass, { parameters: [id, cid] }) },
      '/webhooks': {
        get: op('List webhooks (API Pass)', pass),
        post: op('Create a signed webhook; secret shown once (API Pass)', pass, { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } } } } } } }),
      },
      '/webhooks/{id}': { delete: op('Delete a webhook (API Pass)', pass, { parameters: [id] }) },
      '/webhooks/{id}/test': { post: op('Send a test event (API Pass)', pass, { parameters: [id] }) },
      '/webhooks/{id}/enable': { post: op('Re-enable a webhook (API Pass)', pass, { parameters: [id] }) },
      '/webhooks/{id}/disable': { post: op('Pause a webhook (API Pass)', pass, { parameters: [id] }) },
    },
  };
}
