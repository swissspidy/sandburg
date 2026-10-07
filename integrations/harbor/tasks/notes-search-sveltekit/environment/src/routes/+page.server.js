import db from '$lib/server/db.js';

export function load() {
  return { sqlite: db.prepare('select sqlite_version() as version').get().version };
}
