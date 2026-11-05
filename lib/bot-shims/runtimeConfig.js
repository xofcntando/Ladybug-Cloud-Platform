/**
 * Ladybug Cloud - per-bot runtime configuration (bot side)
 *
 * The stock bot stores group data in `bots/ladybug/database/` and lets owner
 * commands rewrite `config.js`. On a multi-tenant host every bot shares that
 * one folder and one file, so changing the prefix or switching to private mode
 * on one bot silently changed every other bot.
 *
 * This module keeps overrides in `$BOT_DATA_DIR/config.json` (the platform sets
 * BOT_DATA_DIR to a folder unique to each bot) and exposes load()/set().
 *
 * This file is copied into bots/ladybug/utils/ by the platform installer.
 * Edit lib/bot-shims/runtimeConfig.js in the platform repo instead.
 */
const fs = require('fs');
const path = require('path');

function dataDir() {
  return process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'database');
}

function file() {
  return path.join(dataDir(), 'config.json');
}

function load() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function set(key, value) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const current = load();
    current[key] = value;
    fs.writeFileSync(file(), JSON.stringify(current, null, 2));
    return true;
  } catch (e) {
    console.error('[runtime-config] could not save', key, e.message);
    return false;
  }
}

function get(key, fallback) {
  const all = load();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
}

module.exports = { dataDir, file, load, set, get };
