/**
 * The subset of YAML that pnpm writes (pnpm-workspace.yaml, pnpm-lock.yaml): block mappings and
 * sequences by indentation, plain and quoted scalars, and one-line flow collections (`{a: b}`,
 * `['x', 'y']`). Scalars stay strings. Anything else (anchors, block scalars, multi-line flow) is
 * not read: its lines are skipped, as is nesting deeper than MAX_DEPTH (a flow collection that deep
 * stays a string). A `__proto__` key is a key like any other. No Node.js imports: project loading
 * and the page's plan use it.
 */

/** Nesting this reader follows, block or flow; deeper is skipped, not a stack overflow. */
const MAX_DEPTH = 100;

/** Sets an entry as an own property (a `__proto__` key does not change the map's prototype). */
function put(map: Record<string, YamlValue>, key: string, value: YamlValue): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
}

/** Parses `text` (a document of the subset above). A malformed line is skipped, not an error. */
export function parseYaml(text: string): YamlValue {
  const lines: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw);
    if (!stripped.trim() || /^(---|\.\.\.)\s*$/.test(stripped)) continue;
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  }
  const at = { i: 0 };
  return lines.length ? block(lines, at, lines[0].indent, 0) : {};
}

/** A block (mapping or sequence) whose entries are at `indent`, `depth` blocks down. */
function block(lines: Line[], at: { i: number }, indent: number, depth: number): YamlValue {
  if (lines[at.i].text.startsWith('- ') || lines[at.i].text === '-') {
    const list: YamlValue[] = [];
    while (at.i < lines.length && lines[at.i].indent === indent && (lines[at.i].text.startsWith('- ') || lines[at.i].text === '-')) {
      const item = lines[at.i].text.slice(1).trim();
      at.i++;
      if (item) list.push(scalarOrFlow(item));
      else if (at.i < lines.length && lines[at.i].indent > indent && depth < MAX_DEPTH) list.push(block(lines, at, lines[at.i].indent, depth + 1));
      skipDeeper(lines, at, indent);
    }
    return list;
  }
  const map: Record<string, YamlValue> = {};
  while (at.i < lines.length && lines[at.i].indent === indent) {
    const entry = splitKey(lines[at.i].text);
    at.i++;
    if (!entry) {
      skipDeeper(lines, at, indent);
      continue;
    }
    if (entry.value) put(map, entry.key, scalarOrFlow(entry.value));
    else if (at.i < lines.length && lines[at.i].indent > indent && depth < MAX_DEPTH) put(map, entry.key, block(lines, at, lines[at.i].indent, depth + 1));
    // A sequence may sit at its key's indentation ("packages:\n- a").
    else if (at.i < lines.length && lines[at.i].indent === indent && lines[at.i].text.startsWith('- ') && depth < MAX_DEPTH) put(map, entry.key, block(lines, at, indent, depth + 1));
    else put(map, entry.key, '');
    skipDeeper(lines, at, indent);
  }
  return map;
}

/** Skips lines nested deeper than `indent` that no entry took (what the subset does not read). */
function skipDeeper(lines: Line[], at: { i: number }, indent: number): void {
  while (at.i < lines.length && lines[at.i].indent > indent) at.i++;
}

/** `key: value` or `key:`, with a plain or quoted key; null for a line that is neither. */
function splitKey(text: string): { key: string; value: string } | null {
  let key: string;
  let rest: string;
  if (text[0] === '"' || text[0] === "'") {
    const end = closingQuote(text, 0);
    if (end < 0) return null;
    key = unquote(text.slice(0, end + 1));
    rest = text.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    rest = rest.slice(1);
  } else {
    const m = /^(.*?):(?:\s+(.*))?$/.exec(text);
    if (!m || m[1].includes(': ')) return null;
    key = m[1].trim();
    rest = m[2] ?? '';
  }
  return { key, value: rest.trim() };
}

function scalarOrFlow(value: string): YamlValue {
  if (value.startsWith('[') || value.startsWith('{')) {
    const at = { i: 0 };
    const parsed = flow(value, at, 0);
    if (parsed !== null) return parsed;
  }
  return unquote(value);
}

/** A one-line flow collection, or null if it is not one this reader understands (or nests deeper than MAX_DEPTH). */
function flow(text: string, at: { i: number }, depth: number): YamlValue | null {
  if (depth >= MAX_DEPTH) return null;
  const open = text[at.i];
  const close = open === '[' ? ']' : '}';
  at.i++;
  const list: YamlValue[] = [];
  const map: Record<string, YamlValue> = {};
  for (;;) {
    while (text[at.i] === ' ') at.i++;
    if (text[at.i] === close) {
      at.i++;
      return open === '[' ? list : map;
    }
    if (at.i >= text.length) return null;
    let key: string | null = null;
    if (open === '{') {
      const item = flowScalar(text, at, ':');
      if (text[at.i] !== ':') return null;
      at.i++;
      while (text[at.i] === ' ') at.i++;
      key = item;
    }
    let value: YamlValue;
    if (text[at.i] === '[' || text[at.i] === '{') {
      const nested = flow(text, at, depth + 1);
      if (nested === null) return null;
      value = nested;
    } else value = flowScalar(text, at, '');
    if (key === null) list.push(value);
    else put(map, key, value);
    while (text[at.i] === ' ') at.i++;
    if (text[at.i] === ',') at.i++;
    else if (text[at.i] !== close) return null;
  }
}

/** A scalar inside a flow collection, up to a `,`, the closing bracket or `stop`. */
function flowScalar(text: string, at: { i: number }, stop: string): string {
  while (text[at.i] === ' ') at.i++;
  if (text[at.i] === '"' || text[at.i] === "'") {
    const end = closingQuote(text, at.i);
    if (end >= 0) {
      const s = unquote(text.slice(at.i, end + 1));
      at.i = end + 1;
      return s;
    }
  }
  const start = at.i;
  while (at.i < text.length && !',]}'.includes(text[at.i]) && !(stop && text[at.i] === stop && /[\s,\]}]|$/.test(text[at.i + 1] ?? ''))) at.i++;
  return text.slice(start, at.i).trim();
}

/** The index of the quote that closes the one at `start` ('' escapes ' in single quotes; \ escapes in double). */
function closingQuote(text: string, start: number): number {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') i++;
    else if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** A line without its comment: a `#` at the start or after a space, outside quotes. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '"' || c === "'") {
      // A quote opens a quoted scalar only at its start (after `: `, `- `, `[`, `{`, `,` or the line's start).
      if (i === 0 || /[\s:[{,-]/.test(line[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line;
}
