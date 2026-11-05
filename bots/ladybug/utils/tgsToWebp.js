/**
 * Fast .tgs → animated WebP (lottie-web + canvas + ffmpeg)
 * Works with modern lottie-web (5.13+) which UMD-exports to module.exports
 * (stock lottie-node still expects window.lottie and breaks).
 *
 * Optimizations for panel hosts:
 * - cache lottie-web module (no per-sticker disk read + eval)
 * - pipe PNG frames to ffmpeg stdin (no per-frame disk I/O)
 */

const fs = require('fs');
const pako = require('pako');
const { JSDOM } = require('jsdom');
let Canvas;
try { ({ Canvas } = require('canvas')); }
catch (_) { ({ Canvas } = require('@napi-rs/canvas')); }
if (typeof Canvas !== 'function') throw new Error('No usable canvas backend found (install canvas or @napi-rs/canvas)');
const { spawn } = require('child_process');
const ffmpegPath = require('./ffmpeg').getFfmpegPath() || 'ffmpeg';

const tick = () => new Promise((r) => setImmediate(r));

/** Serialize — canvas/lottie is not safe concurrently */
let tgsQueue = Promise.resolve();
function withTgsLock(fn) {
  const run = tgsQueue.then(fn, fn);
  tgsQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** Load lottie-web once — re-eval per sticker kills weak panels */
let cachedLottie = null;

function getLottie() {
  if (cachedLottie) return cachedLottie;

  const lottiePath = require.resolve('lottie-web/build/player/lottie.js');
  const { window } = new JSDOM('', { pretendToBeVisual: true });
  const { document } = window;
  const createElement = document.createElement.bind(document);
  document.createElement = (localName) =>
    localName === 'canvas' ? new Canvas() : createElement(localName);

  const src = fs.readFileSync(lottiePath, 'utf8');
  const module = { exports: {} };
  const exports = module.exports;
  // eslint-disable-next-line no-eval
  eval(src);

  cachedLottie = module.exports;
  if (!cachedLottie || typeof cachedLottie.loadAnimation !== 'function') {
    throw new Error('lottie-web failed to expose loadAnimation (check lottie-web install)');
  }
  return cachedLottie;
}

async function tgsToWebp(tgsBuffer, outPath, tempDir, tag) {
  return withTgsLock(() => tgsToWebpLocked(tgsBuffer, outPath, tempDir, tag));
}

async function tgsToWebpLocked(tgsBuffer, outPath, _tempDir, _tag) {
  const data = JSON.parse(pako.inflate(tgsBuffer, { to: 'string' }));
  const canvas = new Canvas(512, 512);
  const ctx = canvas.getContext('2d');
  const lottie = getLottie();
  const anim = lottie.loadAnimation({
    animationData: data,
    renderer: 'canvas',
    rendererSettings: { context: ctx, clearCanvas: true },
  });

  const srcFps = data.fr || 60;
  const fps = Math.min(15, srcFps);
  const step = Math.max(1, Math.round(srcFps / fps));

  const ff = spawn(ffmpegPath, [
    '-y',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-framerate',
    String(fps),
    '-i',
    'pipe:0',
    '-c:v',
    'libwebp',
    '-preset',
    'default',
    '-loop',
    '0',
    '-vsync',
    '0',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-quality',
    '75',
    '-compression_level',
    '6',
    outPath,
  ]);
  const errBufs = [];
  ff.stderr.on('data', (d) => errBufs.push(d));
  const ffDone = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) return resolve();
      const full = Buffer.concat(errBufs).toString('utf8').replace(/\r/g, '');
      const lines = full
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const useful = lines.filter((l) =>
        /error|invalid|failed|unknown|cannot|unsupported/i.test(l)
      );
      reject(
        new Error(
          (useful.length ? useful.slice(-3).join(' | ') : lines.slice(-5).join(' | ')).slice(
            -400
          ) || `ffmpeg exit ${code}`
        )
      );
    });
  });

  let n = 0;
  try {
    ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
    for (let i = data.ip | 0; i < (data.op | 0); i += step) {
      ctx.clearRect(0, 0, 512, 512);
      anim.goToAndStop(i, true);
      await tick();
      await tick();
      await tick();
      await tick(); // Lottie paints async — 4 ticks needed for reliable transparent frames
      const png = canvas.toBuffer('image/png');
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
      n++;
    }
  } finally {
    try {
      ff.stdin.end();
    } catch {
      // ignore
    }
    try {
      anim.destroy();
    } catch {
      // ignore
    }
  }

  if (n < 2) {
    ff.kill();
    throw new Error('TGS rendered too few frames');
  }
  await ffDone;
}

module.exports = { tgsToWebp };
