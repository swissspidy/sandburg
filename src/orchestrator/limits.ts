/**
 * Limits on what a run keeps of the strings an app controls: an error's message and stack, a console
 * line, a check's message (an assertion quotes the page). An app can throw a 50 MB message; result.json,
 * the batch summary built from it and the host's memory keep its first TEXT_MAX characters and say
 * how many more there were.
 */
import type { RunResult } from '../types.ts';

/** The most characters a run keeps of an error's message or stack, or a check's message. */
export const TEXT_MAX = 16_384;
/** The most characters a run keeps of a console line. */
export const CONSOLE_MAX = 2_000;

const CAPPED = /^… \(\d+ more characters\)$/;
const MARKER_ROOM = 40;

/**
 * `s`, or its first `max` code units and how many more there were, as a string of its own: V8 keeps a
 * slice of a long string as a view of it, which would keep the whole string alive (see egress.ts' cut).
 */
export function capText(s: string, max = TEXT_MAX): string {
  // Within the limit, or capped already (capResult goes over what was capped as it was recorded).
  if (s.length <= max || (s.length <= max + MARKER_ROOM && CAPPED.test(s.slice(max)))) return s;
  return `${Buffer.from(s.slice(0, max), 'utf16le').toString('utf16le')}… (${s.length - max} more characters)`;
}

/** Caps, in place, every string of a result that an app controls (see capText). */
export function capResult(result: RunResult): RunResult {
  for (const p of result.phases) {
    if (!p.error) continue;
    p.error.name = capText(p.error.name, 200);
    p.error.message = capText(p.error.message);
    if (p.error.stack !== undefined) p.error.stack = capText(p.error.stack);
    if (p.error.code !== undefined) p.error.code = capText(p.error.code, 200);
  }
  for (const e of result.pageErrors) {
    e.message = capText(e.message);
    if (e.stack !== undefined) e.stack = capText(e.stack);
  }
  for (const c of result.console) {
    c.text = capText(c.text, CONSOLE_MAX);
    if (c.url !== undefined) c.url = capText(c.url, CONSOLE_MAX);
  }
  for (const c of result.checks) if (c.message !== undefined) c.message = capText(c.message);
  if (result.failure) {
    result.failure.message = capText(result.failure.message);
    result.failure.evidence = result.failure.evidence.map((e) => capText(e));
  }
  return result;
}
