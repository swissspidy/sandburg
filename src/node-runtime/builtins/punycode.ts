/**
 * node:punycode (RFC 3492, as punycode.js 2.1.0, which Node bundles): tr46 (whatwg-url, under
 * node-fetch 2) and psl convert domain names with it, and ucs2 splits strings into code points.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const DELIMITER = '-';
const MAX_INT = 2147483647;
const NON_ASCII = /[^\0-\x7F]/;
const PUNYCODED = /^xn--/;
const SEPARATORS = /[\x2E。．｡]/g;

const ERRORS = {
  overflow: 'Overflow: input needs wider integers to process',
  'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
  'invalid-input': 'Invalid input',
};
const fail = (type: keyof typeof ERRORS): never => {
  throw new RangeError(ERRORS[type]);
};

/** A string's code points (a surrogate pair is one; a lone surrogate is itself). */
function ucs2decode(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; ) {
    const value = s.charCodeAt(i++);
    if (value >= 0xd800 && value <= 0xdbff && i < s.length) {
      const extra = s.charCodeAt(i++);
      if ((extra & 0xfc00) === 0xdc00) out.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
      else {
        out.push(value);
        i--;
      }
    } else out.push(value);
  }
  return out;
}
const ucs2encode = (codePoints: number[]): string => String.fromCodePoint(...codePoints);

const basicToDigit = (c: number) => (c >= 0x30 && c < 0x3a ? 26 + (c - 0x30) : c >= 0x41 && c < 0x5b ? c - 0x41 : c >= 0x61 && c < 0x7b ? c - 0x61 : BASE);
const digitToBasic = (d: number) => d + 22 + 75 * (d < 26 ? 1 : 0);

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let k = 0;
  delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

/** A Punycode string of ASCII to the Unicode string it encodes. */
function decode(input: string): string {
  const output: number[] = [];
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  const basic = Math.max(0, input.lastIndexOf(DELIMITER));
  for (let j = 0; j < basic; ++j) {
    if (input.charCodeAt(j) >= 0x80) fail('not-basic');
    output.push(input.charCodeAt(j));
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) fail('invalid-input');
      const digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= BASE) fail('invalid-input');
      if (digit > Math.floor((MAX_INT - i) / w)) fail('overflow');
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      const baseMinusT = BASE - t;
      if (w > Math.floor(MAX_INT / baseMinusT)) fail('overflow');
      w *= baseMinusT;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAX_INT - n) fail('overflow');
    n += Math.floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** A Unicode string to its Punycode (ASCII). */
function encode(str: string): string {
  const output: string[] = [];
  const input = ucs2decode(str);
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  for (const c of input) if (c < 0x80) output.push(String.fromCharCode(c));
  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength) output.push(DELIMITER);
  while (handled < input.length) {
    let m = MAX_INT;
    for (const c of input) if (c >= n && c < m) m = c;
    const handledPlusOne = handled + 1;
    if (m - n > Math.floor((MAX_INT - delta) / handledPlusOne)) fail('overflow');
    delta += (m - n) * handledPlusOne;
    n = m;
    for (const c of input) {
      if (c < n && ++delta > MAX_INT) fail('overflow');
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
          if (q < t) break;
          const qMinusT = q - t;
          const baseMinusT = BASE - t;
          output.push(String.fromCharCode(digitToBasic(t + (qMinusT % baseMinusT))));
          q = Math.floor(qMinusT / baseMinusT);
        }
        output.push(String.fromCharCode(digitToBasic(q)));
        bias = adapt(delta, handledPlusOne, handled === basicLength);
        delta = 0;
        ++handled;
      }
    }
    ++delta;
    ++n;
  }
  return output.join('');
}

/** Each label of a domain name (or an email address's domain) through fn. */
function mapDomain(domain: string, fn: (label: string) => string): string {
  const parts = domain.split('@');
  let result = '';
  if (parts.length > 1) {
    result = `${parts[0]}@`;
    domain = parts[1];
  }
  return result + domain.replace(SEPARATORS, '\x2E').split('.').map(fn).join('.');
}

export const punycode = {
  version: '2.1.0',
  ucs2: { decode: ucs2decode, encode: ucs2encode },
  decode,
  encode,
  toASCII: (input: string) => mapDomain(input, (s) => (NON_ASCII.test(s) ? `xn--${encode(s)}` : s)),
  toUnicode: (input: string) => mapDomain(input, (s) => (PUNYCODED.test(s) ? decode(s.slice(4).toLowerCase()) : s)),
};
