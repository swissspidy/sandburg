// almostnode's shell dependency (just-bash) imports node:zlib for gzip
// commands. Sandburg never runs those, so a throwing stub keeps the bundle
// browser-only.
export const constants = {};
export function gzipSync(): never {
  throw new Error('node:zlib is not available in the Sandburg host');
}
export const gunzipSync = gzipSync;
