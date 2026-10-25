/**
 * The memory one run's renderer uses: what a batch's memory guard needs to know of each open app
 * (batch.ts), and the peak a run reports (RunResult.memory).
 *
 * Each run has its own browser context and origin, so its page, its workers and its service worker
 * live in one renderer process of their own. Chromium's DevTools Protocol does not name a page's
 * process, but it gives the CPU time of both: the page's (`Performance.getMetrics`, ProcessTime: the
 * renderer process's CPU time, read in that process) and each renderer's, by pid
 * (`SystemInfo.getProcessInfo`, read by the browser process). The page's renderer is the one whose
 * CPU time, read just before and just after the page's, brackets it; when more than one renderer
 * fits (two tabs that loaded side by side), RendererMemory looks again later and keeps only the
 * renderers that fitted every look: the page's own fits each one, and the others drop out as their
 * times part, even when no single look tells them apart (identical apps started together). The pid
 * then gives the renderer's memory, from /proc (Linux).
 */
import { readFileSync } from 'node:fs';

export interface ProcessCpu {
  pid: number;
  /** CPU seconds the process has used. */
  cpuSeconds: number;
}

/** Chromium reports CPU time in clock ticks (10 ms) or finer: a reading may be one tick short. */
const CPU_TICK_S = 0.011;

/**
 * The renderers whose CPU time could be the page's. The renderers' times were read just before the
 * page's (`before`) and just after (`after`): the page's renderer had at most the page's time
 * before and at least it after, so each renderer is held to what it used itself in between (an
 * idle one fits only its exact time).
 */
function fittingRenderers(pageCpuS: number, before: ProcessCpu[], after: ProcessCpu[]): number[] {
  const earlier = new Map(before.map((r) => [r.pid, r.cpuSeconds]));
  return after
    .filter((r) => {
      const was = earlier.get(r.pid);
      return was !== undefined && was <= pageCpuS + CPU_TICK_S && r.cpuSeconds >= pageCpuS - CPU_TICK_S;
    })
    .map((r) => r.pid);
}

/** The renderer whose CPU time is the page's, or null when none or more than one fits. */
export function matchRenderer(pageCpuS: number, before: ProcessCpu[], after: ProcessCpu[]): number | null {
  const fits = fittingRenderers(pageCpuS, before, after);
  return fits.length === 1 ? fits[0] : null;
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
  /** The renderers that fitted every look so far (null before the first). */
  private candidates: Set<number> | null = null;
  private locating: Promise<void> | null = null;
  private stopped = false;
  /** The most the renderer was seen to use (bytes; 0 until it is found). */
  peak = 0;
  private readonly source: RendererMemorySource;

  constructor(source: RendererMemorySource) {
    this.source = source;
  }

  /** Looks for the renderer (once at a time) unless found; true once it is. */
  async locate(): Promise<boolean> {
    if (this.pid !== null || this.stopped) return this.pid !== null;
    this.locating ??= (async () => {
      const before = await this.source.renderers();
      const pageCpu = await this.source.pageCpu();
      const after = await this.source.renderers();
      const fits = new Set(fittingRenderers(pageCpu, before, after));
      const kept = this.candidates ? new Set([...this.candidates].filter((p) => fits.has(p))) : fits;
      // None left (a reading a tick off, or a renderer replaced): start again from this look.
      this.candidates = kept.size > 0 ? kept : fits;
      const pid = this.candidates.size === 1 ? [...this.candidates][0] : null;
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
