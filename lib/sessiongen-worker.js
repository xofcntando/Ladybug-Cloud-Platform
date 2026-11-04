#!/usr/bin/env node
/**
 * Ladybug Cloud — Session pairing worker
 * Runs against the installed bot directory so it can reuse the bot's Baileys
 * dependency. Emits JSON lines prefixed with "@@" on stdout so the host can
 * stream progress to the browser.
 *
 * Usage: node sessiongen-worker.js <phoneDigits> <authDir> <botDir>
 */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const [, , phoneRaw, authDir, botDir] = process.argv;
const phone = String(phoneRaw || '').replace(/[^0-9]/g, '');

function emit(obj) {
  process.stdout.write('@@' + JSON.stringify(obj) + '\n');
}
function fail(msg) {
  emit({ type: 'error', message: msg });
  process.exit(1);
}

if (!phone || phone.length < 7) fail('Invalid phone number. Use country code, digits only.');
if (!authDir || !botDir) fail('Missing worker arguments.');

let baileys;
try {
  baileys = require(path.join(botDir, 'node_modules', '@whiskeysockets', 'baileys'));
} catch (e) {
  fail('Baileys is not installed in the bot directory. Ask the admin to run "Install Dependencies".');
}

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = baileys;

// Branded pairing code: the code shown to the user is always the same 8 characters.
// Override with PAIRING_CODE (exactly 8 letters/digits); set it to "random" for WhatsApp's own random codes.
const RAW_CODE = String(process.env.PAIRING_CODE || 'MRNTANDO').trim().toUpperCase();
const CUSTOM_CODE = /^[A-Z0-9]{8}$/.test(RAW_CODE) ? RAW_CODE : undefined;

const silentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

(async () => {
  fs.mkdirSync(authDir, { recursive: true });

  let version = [2, 3000, 1023223821];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v && v.version) version = v.version;
  } catch (_) {}

  let codeRequested = false;
  let attempts = 0;
  let finished = false;
  let sock = null;
  let socketNo = 0;
  let reconnects = 0;
  const MAX_RECONNECTS = 8;

  /**
   * Open (or re-open) the socket on the saved auth state.
   * WhatsApp ends every successful pairing by closing the stream with "restart required"
   * (515). The link only completes once we reconnect with the freshly saved credentials,
   * so a worker that does not reconnect never reaches connection === 'open'.
   */
  async function connect() {
    const mySocket = ++socketNo;
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    sock = makeWASocket({
      version,
      auth: state,
      logger: silentLogger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.04.4'],
      syncFullHistory: false,
      downloadHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
    });
    sock.ev.on('creds.update', saveCreds);

    async function requestCode() {
      if (mySocket !== socketNo || codeRequested || finished || state.creds.registered) return;
      attempts += 1;
      try {
        const code = await sock.requestPairingCode(phone, CUSTOM_CODE);
        codeRequested = true;
        emit({ type: 'code', code, phone });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (attempts >= 5) {
          fail('Could not request a pairing code: ' + msg);
        } else {
          emit({ type: 'retry', message: `Waiting for WhatsApp… (attempt ${attempts}/5)` });
          setTimeout(requestCode, 5000);
        }
      }
    }

    // Only a fresh, unregistered device asks for a code. A reconnect after pairing must not.
    if (!state.creds.registered) setTimeout(requestCode, 3500);

    sock.ev.on('connection.update', async (update) => {
      if (mySocket !== socketNo) return; // stale socket
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        emit({ type: 'qr', qr });
        if (!codeRequested) requestCode();
      }

      if (connection === 'open') {
        if (finished) return;
        finished = true;
        try {
          // let WhatsApp finish the key exchange and let saveCreds flush to disk
          await new Promise((r) => setTimeout(r, 2500));
          const credsPath = path.join(authDir, 'creds.json');
          if (!fs.existsSync(credsPath)) throw new Error('creds.json was not written');
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
          if (!creds.registered && !(creds.me && creds.me.id)) throw new Error('WhatsApp did not complete the link. Please try again.');
          const gz = zlib.gzipSync(fs.readFileSync(credsPath));
          const sessionId = 'Ladybug!' + gz.toString('base64');
          emit({ type: 'ready', sessionId, me: sock.user || creds.me || null });
          setTimeout(() => process.exit(0), 300);
        } catch (e) {
          fail('Failed to build session: ' + (e && e.message ? e.message : e));
        }
      }

      if (connection === 'close' && !finished) {
        const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : undefined;
        if (code === DisconnectReason.loggedOut) {
          return fail('This WhatsApp account was logged out. Try again with a fresh code.');
        }
        if (code === DisconnectReason.badSession) {
          return fail('WhatsApp rejected the session data. Try again with a fresh code.');
        }
        // 515 (restart required) right after the code is accepted is the normal success path.
        reconnects += 1;
        if (reconnects > MAX_RECONNECTS) return fail('Lost the connection to WhatsApp too many times. Please try again.');
        if (codeRequested) emit({ type: 'retry', message: code === DisconnectReason.restartRequired ? 'Code accepted, finishing the link…' : 'Reconnecting to WhatsApp…' });
        else emit({ type: 'retry', message: 'Reconnecting to WhatsApp…' });
        setTimeout(() => connect().catch((e) => fail(e && e.message ? e.message : String(e))), code === DisconnectReason.restartRequired ? 300 : 1500);
      }
    });
  }

  await connect();
  // A pairing code is valid for about three minutes; leave room for the final key exchange.
  setTimeout(() => fail('Timed out waiting for WhatsApp. Request a new code and enter it within 3 minutes.'), 240000);
})().catch((e) => fail(e && e.message ? e.message : String(e)));
