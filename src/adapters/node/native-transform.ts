/**
 * The host's answer to a runtime's esbuild `transform` (see src/node-runtime/native-transform.ts):
 * the host's native esbuild transforms the code, as it compiles the runtime's own modules (compile.ts),
 * and never runs it. A transform reads no files and runs no plugins: its output is a function of the
 * request alone, so answers are kept by a digest of it and of the esbuild version, for any sandbox.
 *
 * Bounds, as one app must not starve the host: a request is at most NATIVE_MAX_BYTES; a sandbox has
 * at most PER_SANDBOX transforms in progress and the host GLOBAL; a transform that takes longer than
 * TIMEOUT_MS is answered 503 (its slot stays taken until esbuild is done). Every refusal sends the
 * runtime back to the app's own esbuild, so none of them changes what the app gets.
 */
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { NATIVE_MAX_BYTES, nativeOptions, nativeVersion } from '../../node-runtime/native-transform.ts';
import { StringLru } from './compile.ts';
import type { HostRequest, HostResponse } from '../../types.ts';

export { NATIVE_TRANSFORM_PATH } from '../../node-runtime/native-transform.ts';

const PER_SANDBOX = 4;
const GLOBAL = 16;
const TIMEOUT_MS = 10_000;

/** Answers by digest of the esbuild version and the request (results, as the JSON sent). */
const answers = new StringLru<string>(32 << 20);
const inFlight = new Map<string, number>();
let total = 0;

const refuse = (status: number, text: string): HostResponse => ({ status, headers: { 'content-type': 'text/plain' }, body: text });

/** POST <base>/esbuild-transform?v=<the app's esbuild version>: body `[options, input]` (JSON). */
export async function nativeTransform(req: HostRequest, transform = esbuild.transform, timeoutMs = TIMEOUT_MS): Promise<HostResponse> {
  if (req.method !== 'POST') return refuse(405, 'POST only');
  if (!nativeVersion(req.query.get('v'), esbuild.version)) return refuse(422, 'not this esbuild version');
  const sandbox = req.sandbox ?? '';
  if (total >= GLOBAL || (inFlight.get(sandbox) ?? 0) >= PER_SANDBOX) return refuse(503, 'busy');
  // Taken before the body is read: a slow upload holds a slot too.
  total++;
  inFlight.set(sandbox, (inFlight.get(sandbox) ?? 0) + 1);
  const release = () => {
    total--;
    const n = (inFlight.get(sandbox) ?? 1) - 1;
    if (n > 0) inFlight.set(sandbox, n);
    else inFlight.delete(sandbox);
  };
  let released = false;
  try {
    const raw = (await req.body(NATIVE_MAX_BYTES)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return refuse(400, 'not JSON');
    }
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string' || !nativeOptions(parsed[0])) return refuse(422, 'not a transform the host answers');
    const [options, input] = parsed as [Record<string, unknown> | undefined, string];
    const key = createHash('sha256').update(`${esbuild.version}\0`).update(raw).digest('hex');
    const known = answers.get(key);
    if (known !== undefined) return { status: 200, headers: { 'content-type': 'application/json' }, body: known };
    // Nothing of an app's is printed on the host: the runtime asks its own esbuild when a result has
    // warnings its log level would print.
    const work = transform(input, { ...options, logLevel: 'silent' });
    released = true;
    void work.then(release, release);
    const result = await Promise.race([work, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref())]);
    if (!result) return refuse(503, 'timed out');
    const body = JSON.stringify(result);
    answers.set(key, body);
    return { status: 200, headers: { 'content-type': 'application/json' }, body };
  } catch {
    // The code has errors (the app's esbuild reports them as its version does), or the body was too large.
    return refuse(422, 'transform failed');
  } finally {
    if (!released) release();
  }
}
