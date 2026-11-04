/**
 * Tiny in-process event bus for bot activity.
 *
 *   events.emit('bot', { botId, type: 'crashed', detail })   -> webhooks
 *   events.emit('log', { botId, t, stream, line })           -> live log streams
 *
 * Kept dependency-free so lib/bots.js can use it without circular requires.
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

function safeEmit(name, payload) {
  try { bus.emit(name, payload); } catch (e) { console.error('[events]', e.message); }
}

module.exports = { bus, emit: safeEmit };
