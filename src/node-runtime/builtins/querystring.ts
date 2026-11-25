import { Buffer } from 'buffer';

/**
 * node:querystring's escape, unescape and unescapeBuffer, which querystring-es3 does not have: older
 * HTTP and signing libraries call them.
 */

/** As encodeURIComponent (the same characters are kept), with Node's error for a lone surrogate. */
export function qsEscape(str: unknown): string {
  const s = typeof str === 'string' ? str : typeof str === 'object' ? String(str) : `${str as string}`;
  try {
    return encodeURIComponent(s);
  } catch {
    throw Object.assign(new URIError('URI malformed'), { code: 'ERR_INVALID_URI' });
  }
}

const hex = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

/** The bytes of a percent-encoded string ('+' as a space with decodeSpaces); a % that is not one is kept. */
export function unescapeBuffer(s: string, decodeSpaces?: boolean): Buffer {
  const out = Buffer.allocUnsafe(s.length);
  let index = 0;
  let outIndex = 0;
  let hasHex = false;
  const maxLength = s.length - 2;
  while (index < s.length) {
    let c = s.charCodeAt(index);
    if (c === 43 && decodeSpaces) {
      out[outIndex++] = 32;
      index++;
      continue;
    }
    if (c === 37 && index < maxLength) {
      // As Node's: c is the character after the %, so a lone hex digit is kept as itself.
      c = s.charCodeAt(++index);
      const high = hex(c);
      if (high < 0) {
        out[outIndex++] = 37;
        continue;
      }
      const low = hex(s.charCodeAt(++index));
      if (low < 0) {
        out[outIndex++] = 37;
        index--;
      } else {
        hasHex = true;
        c = high * 16 + low;
      }
    }
    out[outIndex++] = c;
    index++;
  }
  return hasHex ? out.subarray(0, outIndex) : out;
}

/** decodeURIComponent, or (for what it rejects) unescapeBuffer's bytes as UTF-8. */
export function qsUnescape(s: string, decodeSpaces?: boolean): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return unescapeBuffer(s, decodeSpaces).toString();
  }
}
