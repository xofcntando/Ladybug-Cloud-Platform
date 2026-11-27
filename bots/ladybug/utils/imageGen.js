/**
 * Image generation for Ladybug Mini — `.img`
 * Made under Ntandomods
 *
 * The platform's promise is that a customer's content never leaves their own
 * server, so this module never ships a platform-wide secret. It tries, in order:
 *
 *   1. The owner's own endpoint, if they configured one:
 *        LADYBUG_IMG_URL   e.g. https://api.openai.com/v1/images/generations
 *                          or   https://my-gateway.example/img?prompt={prompt}
 *        LADYBUG_IMG_KEY   the key for that endpoint
 *        LADYBUG_IMG_MODEL optional model name (default: dall-e-3)
 *      Both a plain "?prompt=" URL and an OpenAI-compatible
 *      POST /images/generations body are understood.
 *
 *   2. Pollinations — a genuinely key-free public image service. This is what
 *      makes `.img` work the moment someone links a number, with no signup.
 *
 *   3. PrinceTech Flux — the endpoint the old `.imagine` command used, kept as
 *      a last resort because free services do go down.
 *
 * Everything is bounded: prompt length, download size, and a hard timeout, so a
 * slow or hostile upstream can never wedge the bot process.
 */

const axios = require('axios');

const MAX_PROMPT = 900;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 95_000;

/** Aspect presets. WhatsApp renders square best, so that is the default. */
const SIZES = {
  square: { width: 1024, height: 1024, label: 'Square 1:1', openai: '1024x1024' },
  wide: { width: 1344, height: 768, label: 'Wide 16:9', openai: '1792x1024' },
  tall: { width: 768, height: 1344, label: 'Tall 9:16', openai: '1024x1792' },
};

const ALIASES = {
  square: 'square', sq: 'square', s: 'square', 1: 'square',
  wide: 'wide', landscape: 'wide', l: 'wide', 16: 'wide', h: 'wide', horizontal: 'wide',
  tall: 'tall', portrait: 'tall', p: 'tall', 9: 'tall', v: 'tall', vertical: 'tall',
};

function env(name) {
  return String(process.env[name] || '').trim();
}

/** Owner configuration, read fresh so a restart is not needed after editing .env. */
function config() {
  return {
    url: env('LADYBUG_IMG_URL'),
    key: env('LADYBUG_IMG_KEY'),
    model: env('LADYBUG_IMG_MODEL') || 'dall-e-3',
    // Set LADYBUG_IMG_FREE=0 to stop the bot calling public free services.
    free: env('LADYBUG_IMG_FREE') !== '0',
  };
}

/** Collapse whitespace and cut the prompt to something an upstream will accept. */
function cleanPrompt(input) {
  return String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROMPT);
}

/**
 * Split ".img --wide a cat on a roof" into a prompt and options.
 * Unknown flags are treated as part of the prompt — people type `--` by accident
 * and losing their words is worse than ignoring the flag.
 */
function parseArgs(args) {
  const out = { prompt: '', size: 'square', seed: 0, nologo: true };
  const words = [];
  for (const raw of Array.isArray(args) ? args : String(args || '').split(/\s+/)) {
    const word = String(raw);
    const lower = word.toLowerCase();
    if (lower === '--nologo' || lower === '--logo') { out.nologo = lower === '--nologo'; continue; }
    if (lower.startsWith('--seed=')) { out.seed = Math.abs(parseInt(lower.slice(7), 10)) || 0; continue; }
    if (lower.startsWith('--size=')) {
      const pick = ALIASES[lower.slice(7)];
      if (pick) { out.size = pick; continue; }
    }
    if (lower.startsWith('--') && ALIASES[lower.slice(2)]) { out.size = ALIASES[lower.slice(2)]; continue; }
    words.push(word);
  }
  out.prompt = cleanPrompt(words.join(' '));
  return out;
}

/** Pollinations URL — the key-free path. */
function pollinationsUrl(prompt, size = 'square', seed = 0) {
  const s = SIZES[size] || SIZES.square;
  const q = new URLSearchParams({
    width: String(s.width),
    height: String(s.height),
    nologo: 'true',
    model: 'flux',
  });
  if (seed) q.set('seed', String(seed));
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt(prompt))}?${q.toString()}`;
}

/** Build the owner's URL: either a {prompt} template or a "?prompt=" query. */
function customUrl(base, prompt, size = 'square') {
  const s = SIZES[size] || SIZES.square;
  const text = cleanPrompt(prompt);
  if (base.includes('{prompt}')) {
    return base
      .replace(/\{width\}/g, String(s.width))
      .replace(/\{height\}/g, String(s.height))
      .replace(/\{prompt\}/g, encodeURIComponent(text));
  }
  const u = new URL(base);
  if (!u.searchParams.has('prompt')) u.searchParams.set('prompt', text);
  return u.toString();
}

/** True when the bytes really are an image, whatever the headers claimed. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return false;
}

function tooBig(buf) {
  return !buf || !buf.length || buf.length > MAX_BYTES;
}

async function download(url, opts = {}) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: opts.timeout || TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    headers: {
      'User-Agent': 'LadybugMini/2.0 (+https://github.com/xfntando/Ladybug-Cloud-Platform)',
      Accept: 'image/*',
      ...(opts.headers || {}),
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const buf = Buffer.from(res.data || []);
  if (tooBig(buf)) throw new Error('the image came back empty or too large');
  const mime = sniffImage(buf);
  if (!mime) throw new Error('the reply was not an image');
  return { buffer: buf, mime };
}

/** Pull an image out of an OpenAI-style JSON body (url or base64). */
async function fromJson(data, key) {
  const first = (data && (data.data?.[0] || data.result || data.image || data.url)) || null;
  const url = typeof first === 'string' ? first : first && (first.url || first.image);
  const b64 = first && typeof first === 'object' ? (first.b64_json || first.base64) : null;
  if (b64) {
    const buf = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (tooBig(buf)) throw new Error('the image came back empty or too large');
    const mime = sniffImage(buf);
    if (!mime) throw new Error('the reply was not an image');
    return { buffer: buf, mime };
  }
  if (url && /^https?:\/\//i.test(url)) {
    return download(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  }
  throw new Error('the endpoint did not return an image');
}

/** 1. The owner's own endpoint. */
async function viaCustom(cfg, prompt, size) {
  const s = SIZES[size] || SIZES.square;
  const headers = cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {};
  const looksOpenAI = /\/images\/generations\/?$/i.test(cfg.url) || cfg.url.includes('openai');

  if (looksOpenAI && !cfg.url.includes('{prompt}')) {
    const res = await axios.post(cfg.url, {
      model: cfg.model,
      prompt: cleanPrompt(prompt),
      n: 1,
      size: s.openai,
    }, {
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      headers: { ...headers, 'Content-Type': 'application/json' },
      validateStatus: (st) => st >= 200 && st < 300,
    });
    return fromJson(res.data, cfg.key);
  }

  const res = await axios.get(customUrl(cfg.url, prompt, size), {
    responseType: 'arraybuffer',
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    headers: { ...headers, Accept: 'image/*,application/json' },
    validateStatus: (st) => st >= 200 && st < 300,
  });
  const type = String(res.headers['content-type'] || '');
  if (type.includes('json')) {
    let body = {};
    try {
      body = JSON.parse(Buffer.from(res.data).toString('utf8'));
    } catch (e) {
      throw new Error('the endpoint returned unreadable JSON');
    }
    return fromJson(body, cfg.key);
  }
  const buf = Buffer.from(res.data || []);
  if (tooBig(buf)) throw new Error('the image came back empty or too large');
  const mime = sniffImage(buf);
  if (!mime) throw new Error('the reply was not an image');
  return { buffer: buf, mime };
}

/**
 * How long a rate-limited service wants us to wait, in milliseconds.
 * Pollinations answers 402 with `{"error":{"message":"Free limit reached: 1 image
 * every 45 seconds per IP. Retry after 38s, ..."}}`, and sends `Retry-After` when it
 * can. Both are read here; anything unparseable falls back to a short pause.
 */
function retryAfterMs(body, headers = {}) {
  const text = String(body || '');
  const m = text.match(/retry after\s+(\d+)\s*s/i);
  if (m) return Math.min(Number(m[1]) * 1000, 60_000);
  const h = Number(headers['retry-after'] || headers['Retry-After']);
  if (Number.isFinite(h) && h > 0) return Math.min(h * 1000, 60_000);
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_WAIT_MS = 55_000;

/**
 * 2. Pollinations — key-free, but anonymous callers are limited to one image every
 * 45 seconds per IP. A shared hosting IP will hit that constantly, so a 402 is not a
 * failure: we read the advertised wait and try once more. Owners with a Pollinations
 * token can set LADYBUG_IMG_KEY (with no LADYBUG_IMG_URL) to skip the queue entirely.
 */
async function viaPollinations(cfg, prompt, size, seed) {
  const url = pollinationsUrl(prompt, size, seed);
  const headers = cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      headers: {
        'User-Agent': 'LadybugMini/2.0 (+https://github.com/xfntando/Ladybug-Cloud-Platform)',
        Accept: 'image/*',
        ...headers,
      },
      validateStatus: (st) => st >= 200 && st < 600,
    });
    // Pollinations answers a rate-limited request with 402 *and* a 3x3 placeholder
    // JPEG, so the status has to be checked before the bytes are trusted.
    if (res.status === 402 || res.status === 429) {
      const body = Buffer.from(res.data || []).toString('utf8');
      const wait = retryAfterMs(body, res.headers);
      if (attempt === 0 && wait > 0 && wait <= RETRY_WAIT_MS) {
        await sleep(wait);
        continue;
      }
      throw new Error('the free image service is busy (rate limited) — try again in a minute, or set LADYBUG_IMG_KEY');
    }
    if (res.status >= 500) {
      // A cold or overloaded worker: one short pause is usually enough.
      if (attempt === 0) { await sleep(3000); continue; }
      throw new Error(`the service is overloaded (HTTP ${res.status})`);
    }
    if (res.status >= 400) throw new Error(`the service said HTTP ${res.status}`);
    const buf = Buffer.from(res.data || []);
    if (tooBig(buf)) throw new Error('the image came back empty or too large');
    const mime = sniffImage(buf);
    if (!mime) throw new Error('the reply was not an image');
    return { buffer: buf, mime };
  }
  throw new Error('the free image service is busy (rate limited)');
}

/** 3. PrinceTech Flux, the endpoint the old `.imagine` used. */
async function viaPrince(prompt) {
  const url = `https://api.princetechn.com/api/ai/fluximg?apikey=prince&prompt=${encodeURIComponent(cleanPrompt(prompt))}`;
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    validateStatus: (st) => st >= 200 && st < 300,
  });
  const data = res.data;
  if (!data || data.success === false || !data.result) {
    throw new Error((data && data.message) || 'the service did not return an image');
  }
  return download(data.result);
}

/**
 * Generate one image.
 * @param {string} prompt
 * @param {{size?:string, seed?:number}} [opts]
 * @returns {Promise<{buffer:Buffer, mime:string, provider:string}>}
 */
async function generate(prompt, opts = {}) {
  const text = cleanPrompt(prompt);
  if (!text) throw new Error('Tell me what to draw. Example: .img a ladybug on a leaf, macro photo');
  const size = SIZES[opts.size] ? opts.size : 'square';
  const cfg = config();
  const errors = [];

  const attempts = [];
  if (cfg.url) attempts.push(['your endpoint', () => viaCustom(cfg, text, size)]);
  if (cfg.free) {
    attempts.push(['pollinations', () => viaPollinations(cfg, text, size, opts.seed || 0)]);
    attempts.push(['prince', () => viaPrince(text)]);
  }

  if (!attempts.length) {
    throw new Error('Image generation is switched off. Set LADYBUG_IMG_FREE=1, or point LADYBUG_IMG_URL at your own endpoint.');
  }

  for (const [name, run] of attempts) {
    try {
      const out = await run();
      return { ...out, provider: name };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`Every image service failed. ${errors.join(' | ')}`);
}

module.exports = {
  generate,
  parseArgs,
  cleanPrompt,
  pollinationsUrl,
  customUrl,
  sniffImage,
  retryAfterMs,
  config,
  SIZES,
  ALIASES,
  MAX_PROMPT,
  MAX_BYTES,
};
