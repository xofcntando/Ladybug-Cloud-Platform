/**
 * Ladybug Cloud public REST API  (v1)
 *
 * Auth:   Authorization: Bearer lbk_...   (create keys under Developers in the dashboard)
 * Base:   /api/v1
 *
 * Deliberately a small, curated surface. API keys can NOT touch passwords,
 * payments, admin routes, storage or env vars. Cookie sessions are ignored here.
 */
module.exports = function mountPublicApi(ctx) {
  const { app, db, bots, billing, rateLimit, publicUser, botView, apikeys, startBotFor, stopBotFor, restartBotFor } = ctx;
  const express = require('express');
  const v1 = express.Router();

  // CORS: the API uses bearer tokens (no cookies), so a wildcard origin is safe.
  v1.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // 120 requests / minute per key (per IP for unauthenticated calls)
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    key: (req) => {
      const h = req.headers.authorization || '';
      return h.startsWith('Bearer ') ? 'k:' + h.slice(7, 60) : 'ip:' + req.ip;
    },
    message: 'Rate limit exceeded (120 requests per minute). Retry after the time in the Retry-After header.',
  });
  v1.use(limiter);

  const fail = (res, code, error) => res.status(code).json({ error });

  function auth(scope) {
    return (req, res, next) => {
      const h = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      if (!m) return fail(res, 401, 'Missing API key. Send "Authorization: Bearer lbk_..."');
      const found = apikeys.authenticate(m[1]);
      if (!found) return fail(res, 401, 'Invalid or revoked API key');
      if (scope === 'write' && found.key.scope !== 'write') {
        return fail(res, 403, 'This key is read-only. Create a key with the "write" scope to control bots.');
      }
      req.user = found.user;
      req.apiKey = found.key;
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

  // ---- discovery (no key needed)
  v1.get('/', (req, res) => {
    res.json({
      name: 'Ladybug Cloud API',
      version: 'v1',
      docs: '/#/developers',
      openapi: '/api/v1/openapi.json',
      auth: 'Authorization: Bearer lbk_...',
    });
  });
  v1.get('/openapi.json', (req, res) => res.json(openapi()));
  v1.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // ---- account
  v1.get('/me', auth('read'), (req, res) => {
    res.json({ user: publicUser(req.user), key: { id: req.apiKey.id, name: req.apiKey.name, scope: req.apiKey.scope } });
  });

  v1.get('/billing', auth('read'), (req, res) => {
    res.json(billing.summary(req.user));
  });

  // ---- bots
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
    res.json({ logs: bots.logs(bot.id, limit), status: bots.status(bot.id) });
  });

  v1.post('/bots/:id/start', auth('write'), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const r = startBotFor(bot, req.user);
    res.status(r.code).json(r.body);
  });

  v1.post('/bots/:id/stop', auth('write'), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const r = stopBotFor(bot);
    res.status(r.code).json(r.body);
  });

  v1.post('/bots/:id/restart', auth('write'), (req, res) => {
    const bot = ownBot(req, res);
    if (!bot) return;
    const r = restartBotFor(bot, req.user);
    res.status(r.code).json(r.body);
  });

  v1.use((req, res) => fail(res, 404, 'Unknown API endpoint. See /api/v1/openapi.json'));

  app.use('/api/v1', v1);
};

function openapi() {
  const bearer = [{ bearerAuth: [] }];
  const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
  const ok = { 200: { description: 'Success' }, 401: { description: 'Missing or invalid key' }, 429: { description: 'Rate limited' } };
  return {
    openapi: '3.0.3',
    info: { title: 'Ladybug Cloud API', version: '1.0.0', description: 'Manage your Ladybug Cloud WhatsApp bots programmatically.' },
    servers: [{ url: '/api/v1' }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Personal API key (lbk_...)' } } },
    paths: {
      '/ping': { get: { summary: 'Health check (no key needed)', responses: { 200: { description: 'pong' } } } },
      '/me': { get: { summary: 'Current account and key info', security: bearer, responses: ok } },
      '/billing': { get: { summary: 'Plan, coins and pass status', security: bearer, responses: ok } },
      '/bots': { get: { summary: 'List your bots', security: bearer, responses: ok } },
      '/bots/{id}': { get: { summary: 'Get one bot', security: bearer, parameters: idParam, responses: { ...ok, 404: { description: 'Not found' } } } },
      '/bots/{id}/logs': { get: { summary: 'Recent log lines', security: bearer, parameters: [...idParam, { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 1000 } }], responses: ok } },
      '/bots/{id}/start': { post: { summary: 'Start a bot (needs write scope)', security: bearer, parameters: idParam, responses: { ...ok, 402: { description: 'No coins / pass' }, 403: { description: 'Read-only key' } } } },
      '/bots/{id}/stop': { post: { summary: 'Stop a bot (needs write scope)', security: bearer, parameters: idParam, responses: ok } },
      '/bots/{id}/restart': { post: { summary: 'Restart a bot (needs write scope)', security: bearer, parameters: idParam, responses: { ...ok, 402: { description: 'No coins / pass' } } } },
    },
  };
}
