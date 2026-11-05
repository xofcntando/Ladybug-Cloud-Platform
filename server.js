/**
 * Entry point. Restores data from MongoDB (when MONGODB_URI is set) BEFORE the
 * app loads, so a fresh/ephemeral disk is repopulated first.
 */
require('dotenv').config();
const mongoSync = require('./lib/mongo-sync');

mongoSync
  .restore()
  .catch((e) => console.error('[mongo] restore error:', e.message))
  .then(async () => {
    try {
      const fs = require('fs');
      const DATA_DIR = process.env.DATA_DIR || require('path').join(__dirname, 'data');
      const db = JSON.parse(fs.readFileSync(require('path').join(DATA_DIR, 'db.json'), 'utf8'));
      await require('./lib/chat-archive').restoreAll((db.bots || []).map((b) => b.id));
    } catch (e) { /* first boot, no db yet */ }
  })
  .then(() => require('./app'));
