/**
 * Entry point. Restores data from MongoDB (when MONGODB_URI is set) BEFORE the
 * app loads, so a fresh/ephemeral disk is repopulated first.
 */
require('dotenv').config();
const mongoSync = require('./lib/mongo-sync');

mongoSync
  .restore()
  .catch((e) => console.error('[mongo] restore error:', e.message))
  .then(() => require('./lib/drive-mongo').restoreAll(require('./lib/storage').ROOT))
  .catch((e) => console.error('[drive] restore error:', e.message))
  .then(() => require('./app'));
