/**
 * An exception nothing caught and a rejection nothing handled, as Node 24 handles them
 * (lib/internal/process/execution.js, promises.js): 'uncaughtExceptionMonitor', then the capture
 * callback or 'uncaughtException' listeners, which leave the process running; with neither, 'exit'
 * listeners run with code 1 and the process ends with the error. A listener that throws ends it
 * with code 7, without 'exit'. Rejections go by --unhandled-rejections (default throw).
 */
import { CAPTURE_CALLBACK, ExitError } from './builtins/process.ts';
import type { EventEmitter } from 'events';

export type Origin = 'uncaughtException' | 'unhandledRejection';
export type UnhandledRejections = 'throw' | 'strict' | 'warn' | 'none' | 'warn-with-error-code';
export const UNHANDLED_REJECTIONS: readonly UnhandledRejections[] = ['throw', 'strict', 'warn', 'none', 'warn-with-error-code'];

export interface UncaughtHost {
  proc: EventEmitter & Record<string | symbol, unknown>;
  write(stream: 'stderr', text: string): void;
  /** The process ends with this code (process.exit's end: 'exit' was emitted, if it is to be). */
  exited(code: number): void;
  /** The runtime ends with this error (to its parent, which reports it: a process's exit code is 1). */
  fatal(err: unknown): void;
  /** Whether the process ended already. */
  over(): boolean;
  /** A worker thread (not a process of its own): an uncaught error ends it with its 'error' (no 'exit' here). */
  workerThread: boolean;
  /** --unhandled-rejections. */
  mode: UnhandledRejections;
}

/** What a thrown value prints as (its stack, if it has one). */
function shown(e: unknown): string {
  return String((e as Error | null)?.stack ?? e);
}

/** V8's description of a rejection's reason in UnhandledPromiseRejection's message. */
function describe(v: unknown): string {
  if (typeof v === 'symbol') return v.toString();
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return String(v);
  if (Array.isArray(v)) return '[object Array]';
  return `#<${(v as { constructor?: { name?: string } }).constructor?.name || 'Object'}>`;
}

const errorLike = (v: unknown) => typeof v === 'object' && v !== null && Object.prototype.hasOwnProperty.call(v, 'stack');

const REJECTION_WARNING =
  'Unhandled promise rejection. This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). To terminate the node process on unhandled promise rejection, use the CLI flag `--unhandled-rejections=strict` (see https://nodejs.org/api/cli.html#cli_unhandled_rejections_mode).';

export function createUncaught(host: UncaughtHost) {
  const { proc } = host;
  const emitWarning = (w: string | Error, type?: string) => (proc.emitWarning as (w: string | Error, t?: string) => void)(w, type);

  /** No listener took it: 'exit' with code 1 (once), then the end, with the error unless a listener exited. */
  function die(err: unknown) {
    if (host.workerThread) return host.fatal(err);
    if (!proc._exiting) {
      proc._exiting = true;
      proc.exitCode = 1;
      try {
        proc.emit('exit', 1);
      } catch (e) {
        // process.exit() there ends the process with its code; anything else it throws is ignored.
        if (e instanceof ExitError) return host.exited(e.code);
      }
    }
    // An 'exit' listener may have set another exit code.
    const code = Number(proc.exitCode ?? 1);
    if (code === 1) return host.fatal(err);
    host.write('stderr', `${shown(err)}\n`);
    host.exited(code);
  }

  /** Whether the process goes on (a listener or the capture callback took it). */
  function uncaught(err: unknown, origin: Origin): boolean {
    if (host.over()) return false;
    if (err instanceof ExitError) {
      host.exited(err.code);
      return false;
    }
    try {
      proc.emit('uncaughtExceptionMonitor', err, origin);
      const capture = proc[CAPTURE_CALLBACK] as ((e: unknown) => void) | null;
      if (capture) capture(err);
      else if (!proc.emit('uncaughtException', err, origin)) {
        die(err);
        return false;
      }
      return true;
    } catch (e) {
      if (e instanceof ExitError) host.exited(e.code);
      else if (host.workerThread) host.fatal(e);
      else {
        // Node's kExceptionInFatalExceptionHandler.
        host.write('stderr', `${shown(e)}\n`);
        host.exited(7);
      }
      return false;
    }
  }

  let rejections = 0;
  /** Each reported rejection's id (for its warnings), until it is handled. */
  const ids = new WeakMap<Promise<unknown>, number>();

  function warnRejection(reason: unknown, id: number) {
    try {
      emitWarning(errorLike(reason) ? String((reason as Error).stack) : describe(reason), 'UnhandledPromiseRejectionWarning');
    } catch {
      // As Node's: a reason that cannot be shown is not.
    }
    emitWarning(Object.assign(new Error(`${REJECTION_WARNING} (rejection id: ${id})`), { name: 'UnhandledPromiseRejectionWarning' }));
  }

  /** A promise rejected with nothing to handle it by the end of the task (Node: of the tick). */
  function unhandledRejection(reason: unknown, promise: Promise<unknown>): void {
    if (host.over()) return;
    if (reason instanceof ExitError) return host.exited(reason.code);
    const id = ++rejections;
    ids.set(promise, id);
    const asError = () => (errorLike(reason) ? reason : Object.assign(new Error(`This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${describe(reason)}".`), { code: 'ERR_UNHANDLED_REJECTION', name: 'UnhandledPromiseRejection' }));
    // process.exit() in an 'unhandledRejection' listener ends the process; another throw there is uncaught.
    const emit = () => {
      try {
        return proc.emit('unhandledRejection', reason, promise);
      } catch (e) {
        uncaught(e, 'uncaughtException');
        return true;
      }
    };
    switch (host.mode) {
      case 'strict':
        if (!uncaught(asError(), 'unhandledRejection')) return;
        if (!emit()) warnRejection(reason, id);
        return;
      case 'warn':
        emit();
        if (!host.over()) warnRejection(reason, id);
        return;
      case 'warn-with-error-code':
        if (emit()) return;
        warnRejection(reason, id);
        proc.exitCode = 1;
        return;
      case 'none':
        emit();
        return;
      case 'throw':
        if (!emit()) uncaught(asError(), 'unhandledRejection');
        return;
    }
  }

  /** A promise reported unhandled got its handler later: 'rejectionHandled', else a warning. */
  function rejectionHandled(promise: Promise<unknown>): void {
    const id = ids.get(promise);
    if (id === undefined || host.over()) return;
    ids.delete(promise);
    if (!proc.emit('rejectionHandled', promise)) emitWarning(Object.assign(new Error(`Promise rejection was handled asynchronously (rejection id: ${id})`), { name: 'PromiseRejectionHandledWarning' }));
  }

  return { uncaught, unhandledRejection, rejectionHandled };
}
