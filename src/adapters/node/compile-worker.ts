/**
 * The runtime's compiler in the page, for packages installed in the browser (ADR 0020): compile.ts on
 * esbuild's WebAssembly build, so a run needs nothing from its host but static files.
 *
 * One broker per page. Each runtime (and each of its threads and child processes) has a port to it,
 * sends a request with its mailbox (a SharedArrayBuffer), and blocks on the mailbox until the answer
 * is written there: the runtime's module loader is synchronous. The broker spreads requests over a
 * few compile workers, each with its own esbuild, and keeps the results: a runtime's threads load
 * the same files (Vite's chunks in each of its workers).
 *
 * The same script runs as broker and as compile worker (`?compiler`).
 */
import * as esbuild from 'esbuild-wasm';
import { compileForRuntimeAsync, projectHasTopLevelAwaitAsync, type CompileKind } from './compile.ts';

/** What a runtime asks for: a module compiled, or whether its project uses top-level await. */
export type CompileJob = { op: 'compile'; code: string; path: string; kind: CompileKind; asyncModules: boolean } | { op: 'tla'; files: Record<string, string> };
export type CompileRequest = CompileJob & { mailbox: SharedArrayBuffer };

/** Mailbox layout: Int32 state (0 waiting, 1 answered, 2 failed, 3 too big), Int32 byte length, then UTF-8 text. */
export const MAILBOX_HEADER = 8;

interface Port {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}
const scope = self as unknown as Port & { location: Location };

if (new URL(scope.location.href).searchParams.has('compiler')) compiler();
else broker();

/** A compile worker: esbuild's WebAssembly build, given the compiled module by the broker. */
function compiler(): void {
  let ready: Promise<void> | null = null;
  const transform = async (code: string, options: esbuild.TransformOptions) => (await esbuild.transform(code, options)).code;
  scope.onmessage = async (e: MessageEvent<{ id: number; wasmModule: WebAssembly.Module; request: CompileJob | null }>) => {
    const { id, wasmModule, request } = e.data;
    try {
      ready ??= esbuild.initialize({ wasmModule, worker: false });
      await ready;
      if (!request) return; // started ahead of the first request
      const text =
        request.op === 'tla'
          ? JSON.stringify({ topLevelAwait: await projectHasTopLevelAwaitAsync(request.files, transform) })
          : await compileForRuntimeAsync(request.code, request.path, request.kind, { asyncModules: request.asyncModules }, transform);
      scope.postMessage({ id, ok: true, text });
    } catch (err) {
      scope.postMessage({ id, ok: false, text: String((err as Error)?.message ?? err) });
    }
  };
}

function broker(): void {
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const workers: { worker: Worker; busy: number; jobs: Set<number> }[] = [];
  const waiting = new Map<number, (answer: { ok: boolean; text: string }) => void>();
  const results = new Map<string, Promise<{ ok: boolean; text: string }>>();
  const encoder = new TextEncoder();
  let wasmModule: Promise<WebAssembly.Module> | null = null;
  let nextId = 1;

  // Each compile worker takes one job at a time, so the next job goes to whichever is free first;
  // the rest wait here.
  const queue: { id: number; request: CompileJob }[] = [];
  const dispatch = (module: WebAssembly.Module) => {
    while (queue.length) {
      let entry = workers.find((w) => w.busy === 0);
      if (!entry && workers.length < size) entry = spawn();
      if (!entry) return;
      const job = queue.shift()!;
      entry.busy++;
      entry.jobs.add(job.id);
      entry.worker.postMessage({ id: job.id, wasmModule: module, request: job.request });
    }
  };
  const spawn = () => {
    const worker = new Worker(`${scope.location.href.split('?')[0]}?compiler`);
    const entry = { worker, busy: 0, jobs: new Set<number>() };
    const settle = (id: number, answer: { ok: boolean; text: string }) => {
      if (!entry.jobs.delete(id)) return;
      entry.busy--;
      waiting.get(id)?.(answer);
      waiting.delete(id);
    };
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; text: string }>) => {
      settle(e.data.id, e.data);
      void wasmModule?.then(dispatch);
    };
    // A compile worker that fails (its script, or esbuild running out of memory): its jobs fail as
    // compile errors instead of leaving their runtimes waiting, and a new worker takes the queue.
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      workers.splice(workers.indexOf(entry), 1);
      worker.terminate();
      for (const id of [...entry.jobs]) settle(id, { ok: false, text: `the page's compiler failed: ${e.message || 'worker error'}` });
      void wasmModule?.then(dispatch);
    };
    workers.push(entry);
    return entry;
  };

  const run = async (request: CompileJob): Promise<{ ok: boolean; text: string }> => {
    const module = await (wasmModule ??= WebAssembly.compileStreaming(fetch(new URL('esbuild.wasm', scope.location.href))));
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      queue.push({ id, request });
      dispatch(module);
    });
  };

  const key = async (request: CompileJob) => {
    // Serialized structurally: a "|" in a path or in code cannot make two requests one.
    const text = JSON.stringify(request.op === 'tla' ? [request.op, request.files] : [request.op, request.kind, request.asyncModules, request.path, request.code]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
    return `${request.op}:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  };

  const answer = (mailbox: SharedArrayBuffer, { ok, text }: { ok: boolean; text: string }) => {
    const bytes = encoder.encode(text);
    const state = new Int32Array(mailbox, 0, 2);
    // Too big for this mailbox: the size, and the runtime asks again with a mailbox that size (the
    // answer is kept, see results).
    const fits = MAILBOX_HEADER + bytes.length <= mailbox.byteLength;
    if (fits) new Uint8Array(mailbox, MAILBOX_HEADER, bytes.length).set(bytes);
    Atomics.store(state, 1, bytes.length);
    Atomics.store(state, 0, !fits ? 3 : ok ? 1 : 2);
    Atomics.notify(state, 0);
  };

  const serve = (port: Port) => {
    port.onmessage = async (e: MessageEvent<CompileRequest | { op: 'connect'; port: MessagePort }>) => {
      const m = e.data;
      // A new runtime (a thread or child process of this one): its own port.
      if (m.op === 'connect') return serve(m.port);
      const { mailbox, ...rest } = m;
      const request = rest as CompileJob;
      let result: { ok: boolean; text: string };
      try {
        const k = await key(request);
        let pending = results.get(k);
        if (!pending) {
          pending = run(request);
          results.set(k, pending);
          if (results.size > 5000) results.delete(results.keys().next().value!);
        }
        result = await pending;
        if (!result.ok) results.delete(k);
      } catch (err) {
        result = { ok: false, text: String((err as Error)?.message ?? err) };
      }
      answer(mailbox, result);
    };
  };
  // The page starts the broker as the install starts: esbuild loads while the packages download.
  wasmModule = WebAssembly.compileStreaming(fetch(new URL('esbuild.wasm', scope.location.href)));
  void wasmModule.then((module) => spawn().worker.postMessage({ id: 0, wasmModule: module, request: null }), () => (wasmModule = null));
  // The page's port for each runtime it starts.
  serve(scope);
}
