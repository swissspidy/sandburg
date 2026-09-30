/**
 * node:wasi for the node runtime (ADR 0012): WASI preview1 from napi-rs's
 * WebAssembly runtime (@tybys/wasm-util), backed by the runtime's own `fs`,
 * so WebAssembly programs see the same files as JavaScript (and, through the
 * shared VFS, as every thread). napi-rs WASI bindings (rolldown, the Astro
 * compiler, oxc, …) load through this in the main thread and in their worker
 * threads.
 */
import { WASI as NapiWASI } from '@napi-rs/wasm-runtime';

export interface WasiOptions {
  version?: 'preview1' | 'unstable';
  args?: string[];
  env?: Record<string, string | undefined>;
  preopens?: Record<string, string>;
  returnOnExit?: boolean;
  stdin?: number;
  stdout?: number;
  stderr?: number;
}

export function createWasi(fs: unknown, write: (stream: 'stdout' | 'stderr', text: string) => void) {
  class WASI {
    private impl: {
      wasiImport: Record<string, unknown>;
      start(instance: WebAssembly.Instance): number | undefined;
      initialize(instance: WebAssembly.Instance): void;
      getImportObject?(): Record<string, unknown>;
    };

    constructor(options: WasiOptions = {}) {
      const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
      this.impl = new (NapiWASI as unknown as new (o: object) => WASI['impl'])({
        version: options.version ?? 'preview1',
        args: options.args ?? [],
        env,
        preopens: options.preopens ?? {},
        returnOnExit: options.returnOnExit ?? true,
        fs,
        print: (...a: unknown[]) => write('stdout', `${a.join(' ')}\n`),
        printErr: (...a: unknown[]) => write('stderr', `${a.join(' ')}\n`),
      });
    }

    get wasiImport() {
      return this.impl.wasiImport;
    }

    getImportObject() {
      return this.impl.getImportObject?.() ?? { wasi_snapshot_preview1: this.impl.wasiImport };
    }

    start(instance: WebAssembly.Instance) {
      return this.impl.start(instance);
    }

    initialize(instance: WebAssembly.Instance) {
      return this.impl.initialize(instance);
    }
  }
  return { WASI };
}
