/**
 * What the demo site's build (build.ts) records of the host's answers, by the key pages/sw.js looks
 * each one up by when a demo replays it: a GET by its path, a POST by its path, query and body.
 */
import { createHash } from 'node:crypto';
import type { HostRequest, HostResponse } from '../../src/types.ts';

type Serve = (req: HostRequest) => Promise<HostResponse | null>;

/**
 * Queries a runtime adds only over its file channel (src/node-runtime/host-files.ts): a read-ahead
 * (`ahead`, `until`: a bundle of the file and the files after it, status 207) and a note that a file
 * sent ahead was read (`used`: status 204). A demo has no file channel (a static site serves no
 * WebSocket), so it asks for the same path with a plain GET, and the runtime takes only a 200.
 */
const CHANNEL_ONLY = ['ahead', 'until', 'used'];

/**
 * `serve`, recording each answer with `record` under its key. A GET over the file channel with a
 * channel-only query is recorded as the plain GET of its path answers: recorded as it was, a
 * read-ahead bundle or a note replaced the file's answer, and a demo read the file as missing.
 */
export function recordingServe(serve: Serve, record: (key: string, res: HostResponse) => Promise<void>): Serve {
  return async (req) => {
    let body: Buffer | undefined;
    const request = { ...req, body: async (max?: number) => (body ??= await req.body(max)) };
    const res = await serve(request);
    // The runtime saves dev-server caches after a run; a demo has nowhere to keep them (sw.js answers the upload).
    if (!res || (req.method === 'POST' && req.path.startsWith('/__sandburg/dev-cache/'))) return res;
    if (req.method !== 'POST') {
      const viaChannel = req.channel && CHANNEL_ONLY.some((name) => req.query.has(name));
      const plain = viaChannel ? await serve({ ...req, query: new URLSearchParams(), channel: undefined }) : res;
      if (plain) await record(req.path, plain);
      return res;
    }
    const key = `POST ${req.path}?${req.query} ${createHash('sha256').update(await request.body()).digest('hex')}`;
    await record(key, res);
    // Compiles again under a key without the path (Vite's config file has a timestamp in its
    // name): the output depends on the path only through the loader (.tsx) and .mjs/.mts.
    if (req.path === '/__sandburg/compile') {
      const path = req.query.get('path') ?? '';
      await record(`POST /__sandburg/compile#${req.query.get('kind')}|${req.query.get('async') ?? ''}|${path.endsWith('x') ? 'x' : ''}|${/\.m[jt]s$/.test(path) ? 'm' : ''} ${key.slice(key.lastIndexOf(' ') + 1)}`, res);
    }
    return res;
  };
}
