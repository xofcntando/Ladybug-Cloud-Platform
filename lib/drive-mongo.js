// Ladybug Drive persistence on MongoDB (GridFS).
// Local disk stays the working copy; every change is written through to MongoDB and
// everything is restored to disk on boot. On Render's free plan this is what makes
// Drive files survive redeploys and sleep. No MONGODB_URI = harmless no-op.
const fs = require('fs');
const path = require('path');
const mongoSync = require('./mongo-sync');

let bucket = null;
let filesCol = null;
let dirsCol = null;

function init() {
  const db = mongoSync.getDb();
  if (!db) return false;
  if (!bucket) {
    const { GridFSBucket } = require('mongodb');
    bucket = new GridFSBucket(db, { bucketName: 'drive' });
    filesCol = db.collection('drive.files');
    dirsCol = db.collection('drive_dirs');
  }
  return true;
}

const available = () => init();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function idsFor(key, prefix) {
  const q = prefix ? { filename: { $regex: '^' + esc(key) + '(/|$)' } } : { filename: key };
  return filesCol.find(q).project({ _id: 1, filename: 1 }).toArray();
}

async function putFile(key, localPath) {
  if (!init()) return false;
  for (const f of await idsFor(key, false)) await bucket.delete(f._id).catch(() => {});
  await new Promise((resolve, reject) => {
    const up = bucket.openUploadStream(key);
    fs.createReadStream(localPath).on('error', reject).pipe(up).on('error', reject).on('finish', resolve);
  });
  return true;
}

async function mkdirKey(key) {
  if (!init()) return false;
  await dirsCol.updateOne({ _id: key }, { $set: { at: Date.now() } }, { upsert: true });
  return true;
}

// Delete a file, or a folder and everything in it.
async function removeKey(key) {
  if (!init()) return false;
  for (const f of await idsFor(key, true)) await bucket.delete(f._id).catch(() => {});
  await dirsCol.deleteMany({ _id: { $regex: '^' + esc(key) + '(/|$)' } });
  return true;
}

async function renameKey(oldKey, newKey) {
  if (!init()) return false;
  for (const f of await idsFor(oldKey, true)) {
    await bucket.rename(f._id, newKey + f.filename.slice(oldKey.length));
  }
  const dirs = await dirsCol.find({ _id: { $regex: '^' + esc(oldKey) + '(/|$)' } }).toArray();
  for (const d of dirs) {
    await dirsCol.deleteOne({ _id: d._id });
    await dirsCol.updateOne({ _id: newKey + d._id.slice(oldKey.length) }, { $set: { at: Date.now() } }, { upsert: true });
  }
  return true;
}

// Bytes stored in MongoDB for Drive.
async function storedBytes() {
  if (!init()) return null;
  const r = await filesCol.aggregate([{ $group: { _id: null, n: { $sum: '$length' } } }]).toArray();
  return r.length ? r[0].n : 0;
}

// Boot: rebuild any file that exists in MongoDB but not on the (wiped) disk.
async function restoreAll(root) {
  if (!init()) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  const base = path.join(root, 'u');
  for await (const d of dirsCol.find({})) {
    const p = path.join(base, ...d._id.split('/'));
    if (p.startsWith(base + path.sep)) fs.mkdirSync(p, { recursive: true });
  }
  for await (const f of filesCol.find({})) {
    const p = path.join(base, ...f.filename.split('/'));
    if (!p.startsWith(base + path.sep) || fs.existsSync(p)) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await new Promise((resolve) => {
      bucket.openDownloadStream(f._id).on('error', (e) => { console.error('[drive] restore failed:', f.filename, e.message); resolve(); })
        .pipe(fs.createWriteStream(p)).on('finish', () => { files++; bytes += f.length; resolve(); }).on('error', () => resolve());
    });
  }
  if (files) console.log(`[drive] restored ${files} file(s) (${(bytes / 1048576).toFixed(1)} MB) from MongoDB`);
  return { files, bytes };
}

module.exports = { available, putFile, mkdirKey, removeKey, renameKey, storedBytes, restoreAll };
