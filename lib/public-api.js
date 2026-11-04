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
  } = ctx;
  const express = require('express');
  const events = require('./events');
  const { rateLimit } = require('./security');
  const v1 = express.Router();

  // CORS: the API uses bearer tokens (no cookies), so a wildcard origin is safe.
  v1.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('X-API-Provider', 'Ntandomods Developers');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (!req.path.endsWith('/stream')) res.setHeader('Cache-Control', 'no-store');
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
      auth: 'Authorization: Bearer lbk_...',
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
    res.json({ bots: db.botsForUser(req.user.id).map(botView), limit: billing.botLimitFor(req.user) });
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
    res.json({
      logs: bots.logs(bot.id, limit).map((l) => ({ ...l, line: scrub(l.line) })),
      status: bots.status(bot.id),
    });
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
    res.json({ ok: true, job });
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

  v1.use((req, res) => fail(res, 404, 'Unknown API endpoint. See /api/v1/openapi.json'));

  app.use('/api/v1', v1);
};

function openapi() {
  const bearer = [{ bearerAuth: [] }];
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const base = { 401: { description: 'Missing or invalid key' }, 429: { description: 'Rate limited' } };
  const free = { 200: { description: 'Success' }, ...base };
  const pass = { 200: { description: 'Success' }, ...base, 402: { description: 'Needs the API Pass' }, 403: { description: 'Read-only key' } };
  const op = (summary, responses, extra) => ({ summary, security: bearer, responses, ...(extra || {}) });
  return {
    openapi: '3.0.3',
    info: {
      title: 'Ladybug Cloud API',
      version: '1.2.0',
      contact: { name: 'Ntandomods Developers' },
      description: 'Powered by Ntandomods Developers. Manage your Ladybug Cloud WhatsApp bots programmatically. Operations marked "(API Pass)" need an active API Pass.',
    },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Personal API key (lbk_...)' } } },
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
      '/session/pair': { post: op('Start WhatsApp pairing for a phone number (API Pass)', pass, { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['phone'], properties: { phone: { type: 'string' } } } } } } }) },
      '/session/pair/{id}': {
        get: op('Poll a pairing job; returns the session id when ready (API Pass)', pass, { parameters: [id] }),
        delete: op('Cancel a pairing job (API Pass)', pass, { parameters: [id] }),
      },
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
