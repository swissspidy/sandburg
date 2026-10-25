/**
 * The memory one run's renderer uses: what a batch's memory guard needs to know of each open app
 * (batch.ts), and the peak a run reports (RunResult.memory).
 *
 * Each run has its own browser context and origin, so its page, its workers and its service worker
 * live in one renderer process of their own. Chromium's DevTools Protocol does not name a page's
 * process, but it gives the CPU time of both: the page's (`Performance.getMetrics`, ProcessTime: the
 * renderer process's CPU time, read in that process) and each renderer's, by pid
 * (`SystemInfo.getProcessInfo`, read by the browser process). The page's renderer is the one whose
 * CPU time is the page's, give or take what it can have used between the two readings; when more
 * than one renderer fits (two tabs that loaded side by side), RendererMemory looks again later,
 * when their times have parted. The pid then gives the renderer's memory, from /proc (Linux).
 */
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

export interface ProcessCpu {
  pid: number;
  /** CPU seconds the process has used. */
  cpuSeconds: number;
}

/** Chromium reports CPU time in clock ticks (10 ms) or finer: either reading may be one tick short. */
const CPU_TICK_S = 0.011;

/**
 * The renderer whose CPU time is the page's, or null when none or more than one fits. The page's
 * time was read first; the renderers' within `elapsedS` after (wall time, a bound on the CPU time
 * any process used in between: `cores` threads at most).
 */
export function matchRenderer(pageCpuS: number, renderers: ProcessCpu[], elapsedS: number, cores: number): number | null {
  const fits = renderers.filter((r) => r.cpuSeconds >= pageCpuS - CPU_TICK_S && r.cpuSeconds <= pageCpuS + CPU_TICK_S + elapsedS * cores);
  return fits.length === 1 ? fits[0].pid : null;
}

/**
 * Bytes of memory a process holds that the system cannot reclaim: its resident anonymous memory
 * (heaps, array buffers, WebAssembly memories) and shared memory (/proc/<pid>/status, RssAnon and
 * RssShmem). What it uses shows as that much less available memory (availableMemory). Null where
 * /proc cannot say (not Linux, or the process has ended).
 */
export function processMemory(pid: number): number | null {
  let status: string;
  try {
    status = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return null;
  }
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(status)?.[1] ?? NaN);
  const bytes = (kb('RssAnon') + kb('RssShmem')) * 1024;
  return Number.isFinite(bytes) ? bytes : null;
}

export interface RendererMemorySource {
  /** The page's renderer's CPU seconds, as the page reports it. */
  pageCpu(): Promise<number>;
  /** Every renderer's pid and CPU seconds, as the browser reports them. */
  renderers(): Promise<ProcessCpu[]>;
  /** A process's memory (default: processMemory). */
  memory?(pid: number): number | null;
  /** The page's reading is no longer needed (the renderer was found, or the run is over). */
  release?(): void;
}

/** One run's renderer: found once (locate), then read on demand (used). */
export class RendererMemory {
  private pid: number | null = null;
  private locating: Promise<void> | null = null;
  private stopped = false;
  /** The most the renderer was seen to use (bytes; 0 until it is found). */
  peak = 0;
  private readonly source: RendererMemorySource;
  private readonly cores: number;

  constructor(source: RendererMemorySource, cores = availableParallelism()) {
    this.source = source;
    this.cores = cores;
  }

  /** Looks for the renderer (once at a time) unless found; true once it is. */
  async locate(): Promise<boolean> {
    if (this.pid !== null || this.stopped) return this.pid !== null;
    this.locating ??= (async () => {
      const started = performance.now();
      const pageCpu = await this.source.pageCpu();
      const renderers = await this.source.renderers();
      const pid = matchRenderer(pageCpu, renderers, (performance.now() - started) / 1000, this.cores);
      if (pid !== null && !this.stopped) {
        this.pid = pid;
        this.source.release?.();
      }
    })()
      .catch(() => {})
      .finally(() => (this.locating = null));
    await this.locating;
    return this.pid !== null;
  }

  /** Bytes the renderer uses now, or null until it is found (or where it cannot be read). */
  used(): number | null {
    if (this.pid === null || this.stopped) return null;
    const bytes = (this.source.memory ?? processMemory)(this.pid);
    if (bytes !== null) this.peak = Math.max(this.peak, bytes);
    return bytes;
  }

  /** The run is over: its renderer is no longer read (its pid may go to another process). */
  stop(): void {
    this.stopped = true;
    this.source.release?.();
  }
}
