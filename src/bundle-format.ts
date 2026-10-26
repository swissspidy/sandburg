/**
 * The framing of every bundle of files Sandburg sends or stores: the preload and read-ahead
 * bundles, the files bundle, dev caches, the compile cache, and a runtime's cache snapshots. A
 * bundle is the byte length of its header's JSON (u32, little-endian), the JSON (an array of
 * entries, each saying how many bytes of the body are its), then the body. Written on the host and
 * in a runtime, read on the host, in the page and in a runtime: no Node.js imports.
 */

const utf8 = new TextEncoder();
const text = new TextDecoder();

/** A bundle's head: the header's length, then the header as JSON. The bodies follow it, in the header's order. */
export function bundleHead(header: unknown[]): Uint8Array {
  const json = utf8.encode(JSON.stringify(header));
  const head = new Uint8Array(4 + json.length);
  new DataView(head.buffer).setUint32(0, json.length, true);
  head.set(json, 4);
  return head;
}

/**
 * A bundle's header, and where its body starts. Throws for bytes that cannot be one: too short for
 * the header they announce, or a header that is not a JSON array. The entries are as stored: a
 * reader of a bundle it did not write checks them (the sizes against the body, the types).
 */
export function bundleHeader<Entry>(bytes: Uint8Array): { header: Entry[]; body: number } {
  if (bytes.length < 4) throw new Error('not a bundle: cut off');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (4 + length > bytes.length) throw new Error('not a bundle: cut off');
  // A copy: a runtime's bundles can be in shared memory, which TextDecoder does not read.
  const header: unknown = JSON.parse(text.decode(bytes.slice(4, 4 + length)));
  if (!Array.isArray(header)) throw new Error('not a bundle: its header is not a list');
  return { header: header as Entry[], body: 4 + length };
}
