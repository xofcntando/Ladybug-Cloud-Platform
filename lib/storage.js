// Ladybug Drive - per-user file storage on the host's persistent disk.
// Platform capacity defaults to 1 TB (STORAGE_TOTAL_GB=1024) and is clamped to the
// real size of the disk the files live on, so the UI never promises space that
// is not there. Each user gets STORAGE_USER_GB (default 5) of that capacity.
const fs = require('fs');
const path = require('path');
const driveMongo = require('./drive-mongo');

const GB = 1024 ** 3;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ROOT = process.env.STORAGE_DIR || path.join(DATA_DIR, 'storage');
const TMP = path.join(ROOT, '.tmp');
// Where files survive: a mounted disk (/var/data), or MongoDB when MONGODB_URI is set
// (write-through GridFS copy restored on boot). Render's free plan alone has neither.
const HAS_MONGO = !!(process.env.MONGODB_URI || process.env.MONGO_URL);
const DISK_PERSISTENT = process.env.STORAGE_PERSISTENT
  ? process.env.STORAGE_PERSISTENT === 'true'
  : (!process.env.RENDER || ROOT.startsWith('/var/data'));
const MONGO_MODE = HAS_MONGO && !DISK_PERSISTENT;
const isPersistent = () => DISK_PERSISTENT || (MONGO_MODE && driveMongo.available());

// Defaults per mode. A free Atlas cluster holds 512 MB in total (shared with users, bots and
// logins), so MongoDB mode stays small. Env vars override everything.
const D = DISK_PERSISTENT ? ['1024', '5', '2048'] : MONGO_MODE ? ['0.35', '0.05', '25'] : ['2', '0.25', '100'];
const TOTAL_GB = Math.max(0.1, parseFloat(process.env.STORAGE_TOTAL_GB || D[0]));
const USER_GB = Math.max(0.01, parseFloat(process.env.STORAGE_USER_GB || D[1]));
const MAX_FILE_MB = Math.max(1, parseInt(process.env.STORAGE_MAX_FILE_MB || D[2], 10));

fs.mkdirSync(TMP, { recursive: true });

const keyOf = (userId, ...parts) => [String(userId), ...parts.filter(Boolean)].join('/');
const fmtQuota = (b) => (b >= GB ? `${(b / GB).toFixed(0)} GB` : `${Math.round(b / 1048576)} MB`);

function userRoot(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('Invalid user');
  const dir = path.join(ROOT, 'u', safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Resolve a user-supplied relative path inside the user's folder (blocks ../ escapes).
function resolveIn(userId, rel) {
  const base = userRoot(userId);
  const clean = String(rel || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (clean.some((p) => p === '..' || p.includes('\0'))) throw new Error('Invalid path');
  const full = path.join(base, ...clean);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Invalid path');
  return { base, full, rel: clean.join('/') };
}

function cleanName(name) {
  const n = String(name || '').replace(/[\\/\0]/g, '').replace(/^\.+/, '').trim().slice(0, 180);
  if (!n) throw new Error('Invalid name');
  return n;
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSize(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch (err) { /* file vanished */ }
  }
  return total;
}

const usageCache = new Map(); // userId -> { at, bytes }
function userUsed(userId, fresh = false) {
  const c = usageCache.get(userId);
  if (!fresh && c && Date.now() - c.at < 20_000) return c.bytes;
  const bytes = dirSize(userRoot(userId));
  usageCache.set(userId, { at: Date.now(), bytes });
  return bytes;
}
function bump(userId, delta) {
  const c = usageCache.get(userId);
  if (c) c.bytes = Math.max(0, c.bytes + delta);
}

let platformCache = { at: 0, bytes: 0 };
function platformUsed() {
  if (Date.now() - platformCache.at < 30_000) return platformCache.bytes;
  platformCache = { at: Date.now(), bytes: dirSize(path.join(ROOT, 'u')) };
  return platformCache.bytes;
}

// Real size of the disk behind ROOT (null when the platform cannot report it).
function diskInfo() {
  try {
    const s = fs.statfsSync(ROOT);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch (e) { return null; }
}

function platform() {
  const disk = diskInfo();
  const quota = TOTAL_GB * GB;
  // capacity can never exceed what the disk can really hold (existing storage + free space)
  const used = platformUsed();
  const real = disk ? Math.min(quota, used + disk.freeBytes) : quota;
  return {
    capacityBytes: real,
    configuredBytes: quota,
    usedBytes: used,
    freeBytes: Math.max(0, real - used),
    diskBytes: disk ? disk.totalBytes : null,
    limited: real < quota,
    persistent: isPersistent(),
    backend: DISK_PERSISTENT ? 'disk' : MONGO_MODE ? 'mongodb' : 'temporary',
  };
}

function userQuotaBytes(user) {
  return (user && user.isAdmin ? Math.min(TOTAL_GB, 1024) : USER_GB) * GB;
}

function list(userId, rel) {
  const { full, rel: clean } = resolveIn(userId, rel);
  let st;
  try { st = fs.statSync(full); } catch (e) { throw new Error('Folder not found'); }
  if (!st.isDirectory()) throw new Error('Not a folder');
  const items = fs.readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => {
      const s = fs.statSync(path.join(full, e.name));
      return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? null : s.size, modified: s.mtimeMs };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { path: clean, items };
}

function categoryOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'].includes(ext)) return 'images';
  if (['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'opus', 'flac'].includes(ext)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archives';
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'xlsx', 'json'].includes(ext)) return 'documents';
  return 'other';
}

function breakdown(userId) {
  const out = { images: 0, video: 0, audio: 0, documents: 0, archives: 0, other: 0 };
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out[categoryOf(e.name)] += fs.statSync(p).size;
      } catch (err) { /* ignore */ }
    }
  })(userRoot(userId));
  return out;
}

async function mkdir(userId, rel, name) {
  const { full, rel: clean } = resolveIn(userId, rel);
  const clean2 = cleanName(name);
  const target = path.join(full, clean2);
  if (fs.existsSync(target)) throw new Error('A file or folder with that name already exists');
  fs.mkdirSync(target);
  if (MONGO_MODE) await driveMongo.mkdirKey(keyOf(userId, clean, clean2)).catch((e) => { fs.rmSync(target, { recursive: true, force: true }); throw new Error('Could not save to the database: ' + e.message); });
}

async function remove(userId, rel) {
  const { full, base, rel: clean } = resolveIn(userId, rel);
  if (full === base) throw new Error('Cannot delete your root folder');
  if (!fs.existsSync(full)) throw new Error('Not found');
  if (MONGO_MODE) await driveMongo.removeKey(keyOf(userId, clean)).catch((e) => { throw new Error('Could not update the database: ' + e.message); });
  fs.rmSync(full, { recursive: true, force: true });
  usageCache.delete(userId);
  platformCache.at = 0;
}

async function rename(userId, rel, newName) {
  const { full, base, rel: clean } = resolveIn(userId, rel);
  if (full === base) throw new Error('Cannot rename your root folder');
  const nn = cleanName(newName);
  const target = path.join(path.dirname(full), nn);
  if (fs.existsSync(target)) throw new Error('A file or folder with that name already exists');
  const parent = clean.split('/').slice(0, -1).join('/');
  if (MONGO_MODE) await driveMongo.renameKey(keyOf(userId, clean), keyOf(userId, parent, nn)).catch((e) => { throw new Error('Could not update the database: ' + e.message); });
  fs.renameSync(full, target);
}

// Move an uploaded temp file into the user's folder, enforcing quotas.
async function accept(user, rel, tmpPath, originalName, size) {
  const { full, rel: clean } = resolveIn(user.id, rel);
  const quota = userQuotaBytes(user);
  const plat = platform();
  if (userUsed(user.id) + size > quota) throw new Error(`Not enough space in your drive (${fmtQuota(quota)} limit).`);
  if (size > plat.freeBytes) throw new Error('The platform storage is full. Contact the admin.');
  fs.mkdirSync(full, { recursive: true });
  const name = cleanName(originalName);
  let target = path.join(full, name);
  if (fs.existsSync(target)) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(target)) target = path.join(full, `${stem} (${i++})${ext}`);
  }
  fs.renameSync(tmpPath, target);
  if (MONGO_MODE) {
    try { await driveMongo.putFile(keyOf(user.id, clean, path.basename(target)), target); }
    catch (e) { fs.rmSync(target, { force: true }); throw new Error('Could not save to the database: ' + e.message); }
  }
  bump(user.id, size);
  platformCache.bytes += size;
  return path.basename(target);
}

async function removeAll(userId) {
  if (MONGO_MODE) await driveMongo.removeKey(String(userId)).catch(() => {});
  fs.rmSync(userRoot(userId), { recursive: true, force: true });
  usageCache.delete(userId);
  platformCache.at = 0;
}

module.exports = {
  removeAll,
  ROOT, TMP, MAX_FILE_MB, TOTAL_GB, USER_GB, GB,
  resolveIn, list, mkdir, remove, rename, accept,
  userUsed, userQuotaBytes, platform, breakdown, categoryOf,
};
