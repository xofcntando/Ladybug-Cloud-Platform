/**
 * Persistent, never-expiring session store (no native deps).
 *
 * express-session's default MemoryStore forgets every login whenever the
 * server restarts, redeploys or wakes from sleep. This store keeps each
 * session as a JSON file in DATA_DIR/sessions, so users stay logged in until
 * they press Logout.
 */
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const mongoSync = require('./mongo-sync');

class FileSessionStore extends session.Store {
  constructor(dir) {
    super();
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    this._loadAll();
  }

  _file(sid) {
    // sids are url-safe, but never trust them as a path
    return path.join(this.dir, String(sid).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
  }

  _loadAll() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const sess = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
          this.cache.set(f.slice(0, -5), sess);
          n++;
        } catch (e) { /* skip corrupt file */ }
      }
    } catch (e) { /* ignore */ }
    if (n) console.log(`[sessions] restored ${n} login session(s)`);
  }

  _write(sid, sess) {
    const file = this._file(sid);
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(sess), (err) => {
      if (err) return console.error('[sessions] write failed:', err.message);
      fs.rename(tmp, file, () => {});
    });
  }

  get(sid, cb) {
    const sess = this.cache.get(this._key(sid));
    cb(null, sess ? JSON.parse(JSON.stringify(sess)) : null);
  }

  set(sid, sess, cb) {
    this.cache.set(this._key(sid), sess);
    this._write(sid, sess);
    mongoSync.pushSession(sid, sess);
    cb && cb(null);
  }

  touch(sid, sess, cb) {
    const cur = this.cache.get(this._key(sid));
    if (cur) cur.cookie = sess.cookie;
    cb && cb(null);
  }

  destroy(sid, cb) {
    this.cache.delete(this._key(sid));
    mongoSync.deleteSession(sid);
    fs.unlink(this._file(sid), () => cb && cb(null));
  }

  /** Sign a user out everywhere except the session `exceptSid`. Returns how many were removed. */
  destroyForUser(userId, exceptSid) {
    const keep = exceptSid ? this._key(exceptSid) : null;
    let n = 0;
    for (const [key, sess] of Array.from(this.cache.entries())) {
      if (key === keep || !sess || sess.userId !== userId) continue;
      this.destroy(key);
      n += 1;
    }
    return n;
  }

  _key(sid) {
    return String(sid).replace(/[^A-Za-z0-9_-]/g, '_');
  }
}

module.exports = FileSessionStore;
