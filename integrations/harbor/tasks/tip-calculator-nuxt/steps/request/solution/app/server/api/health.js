import db from '../db.js';

export default defineEventHandler(() => {
  return { sqlite: db.prepare('select sqlite_version() as version').get().version };
});
