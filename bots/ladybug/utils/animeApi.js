/**
 * Anime API compatibility layer.
 *
 * The bot used to talk to a shared public host that exposed /api/anime/<name>.
 * The current Ladybug API (config.ladybugApiUrl) exposes /v1/anime/image with a
 * ?category= parameter and returns the payload at the top level instead of
 * nesting it under { result: ... }.
 *
 * This module hides both differences: callers ask for a logical resource and get
 * a normalised object back, whichever backend answered.
 */

const axios = require('axios');
const config = require('../config');

const PRIMARY = String(config.ladybugApiUrl || '').replace(/\/$/, '');
const KEY = config.ladybugApiKey || '';

// Last-resort legacy host, only used if the primary API rejects the request.
const LEGACY = 'https://knightbotapi.stream';

/** Unwrap { result: ... } (legacy) or return the payload as-is (current). */
function normalise(data) {
  if (data && typeof data === 'object' && data.result !== undefined) return data.result;
  return data;
}

/**
 * @param {string} path        primary path, e.g. '/v1/anime/image'
 * @param {string} legacyPath  legacy path, e.g. '/api/anime/neko'
 * @param {object} params      extra query params
 */
async function get(path, legacyPath, params = {}) {
  const attempts = [
    { url: `${PRIMARY}${path}` },
    { url: `${LEGACY}${legacyPath}` },
  ];

  let firstError;
  let lastError;
  for (const attempt of attempts) {
    try {
      const res = await axios.get(attempt.url, {
        params: { ...params, apikey: KEY },
        timeout: 30000,
        headers: { 'User-Agent': 'LadybugMini/1.0', Accept: 'application/json' },
      });
      return normalise(res.data);
    } catch (err) {
      if (!firstError) firstError = err;
      lastError = err;
    }
  }
  // Surface the primary API's error: the legacy host's reply is rarely the useful one.
  throw firstError || lastError;
}

module.exports = { get, normalise, PRIMARY, LEGACY };
