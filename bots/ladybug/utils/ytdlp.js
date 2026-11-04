/**
 * Local yt-dlp fallback for YouTube audio.
 *
 * The third-party download APIs (Hector, Ladybug API, Prince...) are frequently
 * blocked by YouTube ("Sign in to confirm you're not a bot"). This runs yt-dlp
 * directly on the bot host, optionally with YouTube cookies, so the bot no longer
 * depends on someone else's cookies.txt.
 *
 * Cookies (Netscape format, exported from a logged-in browser) are read from, in order:
 *   1. YT_COOKIES_B64   - base64 of cookies.txt (best for Render env vars)
 *   2. YT_COOKIES       - raw cookies.txt contents
 *   3. YT_COOKIES_FILE  - path to a cookies file
 *   4. bots/ladybug/cookies.txt (git-ignored)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}

const BIN_DIR = path.join(process.env.DATA_DIR || os.tmpdir(), 'bin');
const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);
const RELEASE_ASSET = IS_WIN
  ? 'yt-dlp.exe'
  : process.platform === 'darwin'
    ? 'yt-dlp_macos'
    : process.arch === 'arm64'
      ? 'yt-dlp_linux_aarch64'
      : 'yt-dlp_linux';
const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${RELEASE_ASSET}`;

let binaryPromise = null;

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ladybug-bot' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return resolve(download(res.headers.location, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`yt-dlp download HTTP ${res.statusCode}`));
      }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try { fs.renameSync(tmp, dest); resolve(); } catch (e) { reject(e); }
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function onPath() {
  try {
    const r = spawnSync(BIN_NAME, ['--version'], { timeout: 10000 });
    return r.status === 0 ? BIN_NAME : null;
  } catch { return null; }
}

/** Returns a runnable yt-dlp path, downloading the standalone binary once if needed. */
function ensureBinary() {
  if (!binaryPromise) {
    binaryPromise = (async () => {
      if (process.env.YTDLP_PATH && fs.existsSync(process.env.YTDLP_PATH)) return process.env.YTDLP_PATH;
      if (fs.existsSync(BIN_PATH)) return BIN_PATH;
      const existing = onPath();
      if (existing) return existing;
      fs.mkdirSync(BIN_DIR, { recursive: true });
      console.log('[ytdlp] downloading yt-dlp binary...');
      await download(RELEASE_URL, BIN_PATH);
      if (!IS_WIN) fs.chmodSync(BIN_PATH, 0o755);
      return BIN_PATH;
    })().catch((err) => {
      binaryPromise = null; // allow retry next time
      throw err;
    });
  }
  return binaryPromise;
}

/** Resolve a cookies file path (or null) from env / repo file. */
function getCookiesFile() {
  try {
    const target = path.join(os.tmpdir(), 'ladybug-yt-cookies.txt');
    const b64 = process.env.YT_COOKIES_B64;
    const raw = process.env.YT_COOKIES;
    if (b64 || raw) {
      const text = b64 ? Buffer.from(b64, 'base64').toString('utf8') : raw.replace(/\\n/g, '\n');
      // yt-dlp rewrites this file, so always hand it a private copy
      fs.writeFileSync(target, text, { mode: 0o600 });
      return target;
    }
    const candidates = [process.env.YT_COOKIES_FILE, path.join(__dirname, '..', 'cookies.txt')].filter(Boolean);
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, target);
        return target;
      }
    }
  } catch (err) {
    console.log('[ytdlp] cookies setup failed:', err.message);
  }
  return null;
}

function hasCookies() {
  return Boolean(
    process.env.YT_COOKIES_B64 ||
    process.env.YT_COOKIES ||
    (process.env.YT_COOKIES_FILE && fs.existsSync(process.env.YT_COOKIES_FILE)) ||
    fs.existsSync(path.join(__dirname, '..', 'cookies.txt'))
  );
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const line = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] || `yt-dlp exited ${code}`;
      reject(new Error(line));
    });
  });
}

/**
 * Download best audio for a YouTube URL as MP3.
 * @returns {{ buffer: Buffer, title: string|null, thumbnail: string|null, ext: 'mp3' }}
 */
async function ytdlpAudio(url, { timeoutMs = 180000 } = {}) {
  const bin = await ensureBinary();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
  const cookies = getCookiesFile();

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-cache-dir',
    '--max-filesize', '100M',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
    '--print', 'after_move:%(title)s\t%(thumbnail)s',
    '-o', path.join(dir, 'audio.%(ext)s'),
  ];
  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
  if (cookies) args.push('--cookies', cookies);
  args.push(url);

  try {
    const { stdout } = await run(bin, args, timeoutMs);
    const file = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
    if (!file) throw new Error('yt-dlp produced no file');
    const buffer = fs.readFileSync(path.join(dir, file));
    const [title, thumbnail] = (stdout.trim().split('\n').pop() || '').split('\t');
    return {
      buffer,
      title: title && title !== 'NA' ? title : null,
      thumbnail: thumbnail && /^https?:/.test(thumbnail) ? thumbnail : null,
      ext: 'mp3',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (cookies) { try { fs.unlinkSync(cookies); } catch {} }
  }
}

module.exports = { ytdlpAudio, hasCookies, ensureBinary };
