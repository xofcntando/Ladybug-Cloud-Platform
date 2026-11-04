/**
 * Ladybug Cloud - session seeding (bot side)
 *
 * Applies SESSION_ID to the bot's session folder ONCE. The old code rewrote creds.json on
 * every start and every reconnect, which reset the pre-key counters and app-state keys while
 * the key files on disk kept moving on. WhatsApp then delivered messages the bot could no
 * longer decrypt, so the bot looked online but never saw a command.
 *
 * This file is copied into bots/ladybug/utils/ by the platform. Edit lib/bot-shims/sessionSeed.js
 * in the platform repo instead.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const readCreds = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const numberOf = (c) => String((c && c.me && c.me.id) || '').split(':')[0].split('@')[0];

function seed({ sessionID, sessionFolder }) {
  if (!sessionID || !(sessionID.startsWith('Ladybug!') || sessionID.startsWith('KnightBot!'))) return 'no-session-id';
  const sessionFile = path.join(sessionFolder, 'creds.json');
  const markerFile = path.join(sessionFolder, '.session-id');
  try {
    const [header, b64data] = sessionID.split('!');
    if ((header !== 'Ladybug' && header !== 'KnightBot') || !b64data) {
      throw new Error("Invalid session format. Expected 'Ladybug!.....'");
    }
    const raw = zlib.gunzipSync(Buffer.from(b64data.replace('...', ''), 'base64'));
    const seedCreds = JSON.parse(raw.toString('utf8'));
    const fingerprint = crypto.createHash('sha256').update(sessionID).digest('hex');

    // Older builds ignored SESSION_NAME and kept every bot in ./session. Adopt that folder once
    // if it belongs to this same WhatsApp number, so the live keys are not lost.
    if (path.resolve(sessionFolder) !== path.resolve('./session') && !fs.existsSync(sessionFile)) {
      const legacy = readCreds(path.join('./session', 'creds.json'));
      if (legacy && numberOf(legacy) && numberOf(legacy) === numberOf(seedCreds)) {
        fs.cpSync('./session', sessionFolder, { recursive: true });
        console.log('📡 Session : ♻️ Moved existing session into its own folder');
      }
    }
    fs.mkdirSync(sessionFolder, { recursive: true });

    const current = readCreds(sessionFile);
    let marker = '';
    try { marker = fs.readFileSync(markerFile, 'utf8').trim(); } catch (_) { /* none yet */ }
    const sameNumber = current && numberOf(current) === numberOf(seedCreds);

    if (current && sameNumber && (!marker || marker === fingerprint)) {
      if (!marker) fs.writeFileSync(markerFile, fingerprint, 'utf8');
      console.log('📡 Session : 🔑 Using saved session (kept live keys)');
      return 'kept';
    }
    // First start, or a different session ID / number: start clean from the new session.
    if (current) {
      for (const f of fs.readdirSync(sessionFolder)) {
        try { fs.rmSync(path.join(sessionFolder, f), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
    fs.writeFileSync(sessionFile, raw, 'utf8');
    fs.writeFileSync(markerFile, fingerprint, 'utf8');
    console.log('📡 Session : 🔑 Retrieved from Ladybug Session');
    return 'seeded';
  } catch (e) {
    console.error('📡 Session : ❌ Error processing Ladybug session:', e.message);
    return 'error';
  }
}

module.exports = { seed };
