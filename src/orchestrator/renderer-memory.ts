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
 *
 * Inside Chromium's OS sandbox a renderer cannot read its process's CPU time (ProcessTime is 0),
 * but it reads its main thread's (ThreadTime, counted from Performance.enable). The page's renderer's
 * main thread, as /proc counts it, is then always the page's ThreadTime plus what it used before:
 * one offset for the whole run. Each time the host reads the renderers' main threads, the page reads
 * its ThreadTime just before and just after, which bounds each renderer's offset; the page's
 * renderer's bounds overlap at every reading, and another renderer's part as soon as its main
 * thread's use differs from the page's by more than a tick or two. Between two readings the page
 * works on its main thread for an amount of CPU time drawn at random (RendererMemorySource.mark),
 * so that they part soon, even beside pages that do the same. A renderer is taken once it alone
 * fitted two looks; when none fits, the looks start again rather than guess, and after MARK_LOOKS
 * looks none is taken (memory null).
 */
import { readFileSync } from 'node:fs';
import type { CDPSession, Page } from 'playwright-core';

export interface ProcessCpu {
  pid: number;
  /** CPU seconds the process (or with RendererMemorySource.mark, its main thread) has used. */
  cpuSeconds: number;
  /** How far off cpuSeconds may be, either way (with RendererMemorySource.mark; default MARK_TOLERANCE_S). */
  toleranceSeconds?: number;
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

/** CPU seconds the page works on its main thread for each look inside the OS sandbox: drawn between these. */
const MARK_MIN_S = 0.03;
const MARK_MAX_S = 0.09;
/** /proc/<pid>/stat counts in clock ticks of 10 ms: a reading is up to a tick short, and a tick may be charged late. */
const MARK_TOLERANCE_S = 0.015;
/** /proc/<pid>/schedstat counts in nanoseconds: what is off is the page's own reading of its clock (well under 1 ms). */
const SCHEDSTAT_TOLERANCE_S = 0.003;
/** Looks inside the OS sandbox before RendererMemory gives up (each takes up to MARK_MAX_S of the page's main thread). */
const MARK_LOOKS = 8;

/** The renderers' main threads as the host read them, and the page's ThreadTime just before (`from`) and just after (`to`). */
export interface Reading {
  renderers: ProcessCpu[];
  from: number;
  to: number;
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

/**
 * CPU seconds a process's main thread has used, and how far off that may be either way: from
 * /proc/<pid>/task/<pid>/schedstat (its run time in nanoseconds, where the kernel keeps scheduler
 * statistics), else from /proc/<pid>/task/<pid>/stat (utime and stime, in clock ticks of 10 ms).
 * Null where /proc cannot say (not Linux, or the process has ended).
 */
export function mainThreadCpu(pid: number): { seconds: number; toleranceSeconds: number } | null {
  let seconds: number | null = null;
  try {
    seconds = schedstatSeconds(readFileSync(`/proc/${pid}/task/${pid}/schedstat`, 'utf8'));
  } catch {
    // No such file: the clock ticks.
  }
  if (seconds !== null) return { seconds, toleranceSeconds: SCHEDSTAT_TOLERANCE_S };
  try {
    const stat = readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
    // The fields after the command (which may hold spaces and parentheses): state is the first, utime the 12th.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    return Number.isFinite(ticks) ? { seconds: ticks / 100, toleranceSeconds: MARK_TOLERANCE_S } : null;
  } catch {
    return null;
  }
}

/**
 * A thread's run time in seconds from its schedstat line (`<run ns> <wait ns> <slices>`), or null
 * where the kernel keeps no scheduler statistics: it prints `0 0 0` then, or nothing. A thread that
 * has run has used more than 0 ns.
 */
export function schedstatSeconds(line: string): number | null {
  const ns = Number(line.trim().split(/\s+/)[0]);
  return Number.isFinite(ns) && ns > 0 ? ns / 1e9 : null;
}

export interface RendererMemorySource {
  /** The page's renderer's CPU seconds, as the page reports it (where it can: without mark). */
  pageCpu?(): Promise<number>;
  /**
   * Where the page cannot report its process's CPU time (inside the OS sandbox): reads the
   * renderers' main threads (`read`) with the page's ThreadTime around it, has the page work on its
   * main thread, and reads them again. locate() then uses this in place of pageCpu.
   */
  mark?(read: () => Promise<ProcessCpu[]>): Promise<Reading[]>;
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
  /** Looks with mark() so far, how many since the offsets were last empty, and each renderer's offset bounds. */
  private marks = 0;
  private agreeing = 0;
  private offsets: Map<number, [number, number]> | null = null;
  /** The most the renderer was seen to use (bytes; 0 until it is found). */
  peak = 0;
  private readonly source: RendererMemorySource;

  constructor(source: RendererMemorySource) {
    this.source = source;
  }

  /** Looks for the renderer (once at a time) unless found; true once it is. */
  async locate(): Promise<boolean> {
    if (this.pid !== null || this.stopped) return this.pid !== null;
    const mark = this.source.mark?.bind(this.source);
    this.locating ??= (mark ? this.lookByMark(mark) : this.lookByCpu())
      .then((pid) => {
        if (pid !== null && !this.stopped) {
          this.pid = pid;
          this.source.release?.();
        }
      })
      .catch(() => {})
      .finally(() => (this.locating = null));
    await this.locating;
    return this.pid !== null;
  }

  /** A look by the page's CPU time: the renderer, once one alone fitted every look. */
  private async lookByCpu(): Promise<number | null> {
    if (!this.source.pageCpu) return null;
    const before = await this.source.renderers();
    const fits = new Set(fittingRenderers(await this.source.pageCpu(), before, await this.source.renderers()));
    const kept = this.candidates ? new Set([...this.candidates].filter((p) => fits.has(p))) : fits;
    // None left (a reading a tick off, or a renderer replaced): start again from this look.
    this.candidates = kept.size > 0 ? kept : fits;
    return this.candidates.size === 1 ? [...this.candidates][0] : null;
  }

  /**
   * A look by the page's work (inside the OS sandbox): the renderer, once it alone fitted every
   * reading over two looks. When none fitted, none is guessed: the looks start again.
   */
  private async lookByMark(mark: (read: () => Promise<ProcessCpu[]>) => Promise<Reading[]>): Promise<number | null> {
    if (++this.marks > MARK_LOOKS) {
      this.stop();
      return null;
    }
    for (const reading of await mark(() => this.source.renderers())) {
      const next = new Map<number, [number, number]>();
      for (const r of reading.renderers) {
        // What the renderer's main thread used before the page's count started, if it is the page's.
        const tolerance = r.toleranceSeconds ?? MARK_TOLERANCE_S;
        const lo = r.cpuSeconds - reading.to - tolerance;
        const hi = r.cpuSeconds - reading.from + tolerance;
        const was = this.offsets ? this.offsets.get(r.pid) : [lo, hi];
        // (A renderer started since the first reading is not the page's.)
        if (was && Math.max(lo, was[0]) <= Math.min(hi, was[1])) next.set(r.pid, [Math.max(lo, was[0]), Math.min(hi, was[1])]);
      }
      this.offsets = next.size > 0 ? next : null;
      if (!this.offsets) this.agreeing = 0;
    }
    if (!this.offsets) return null;
    this.agreeing++;
    return this.offsets.size === 1 && this.agreeing >= 2 ? [...this.offsets.keys()][0] : null;
  }

  /** Bytes the renderer uses now, or null until it is found (or where it cannot be read). */
  used(): number | null {
    if (this.pid === null || this.stopped) return null;
    const bytes = (this.source.memory ?? processMemory)(this.pid);
    if (bytes !== null) this.peak = Math.max(this.peak, bytes);
    return bytes;
  }

  /** The run is over (or the renderer cannot be told apart): its renderer is no longer read (its pid may go to another process). */
  stop(): void {
    this.stopped = true;
    this.source.release?.();
  }
}

/** Every renderer's pid and CPU seconds (SystemInfo.getProcessInfo, from the browser's DevTools session). */
async function rendererProcesses(browserCdp: () => Promise<CDPSession>) {
  const { processInfo } = await (await browserCdp()).send('SystemInfo.getProcessInfo');
  return processInfo.filter((p) => p.type === 'renderer');
}

/**
 * The memory of a page's renderer, read from /proc: Linux only (null elsewhere). `browserCdp` is the
 * browser's own DevTools session; the page's is opened here, and ends with the page's context. With
 * `sandboxed`, the page marks its renderer by working on its main thread (see RendererMemory); the
 * work runs in a world of its own, where the app's scripts cannot change the clock it reads.
 */
export function pageRendererMemory(page: Page, browserCdp: () => Promise<CDPSession>, sandboxed: boolean): RendererMemory | null {
  if (process.platform !== 'linux') return null;
  let session: Promise<CDPSession> | null = null;
  const pageSession = () => (session ??= page.context().newCDPSession(page).then(async (s) => (await s.send('Performance.enable'), s)));
  const metric = async (name: 'ProcessTime' | 'ThreadTime') => {
    const { metrics } = await (await pageSession()).send('Performance.getMetrics');
    const value = metrics.find((m) => m.name === name)?.value;
    if (value === undefined) throw new Error(`no ${name}`);
    return value;
  };
  const release = () => {
    void session?.then((s) => s.detach()).catch(() => {});
    session = null;
  };
  if (!sandboxed) {
    return new RendererMemory({
      pageCpu: () => metric('ProcessTime'),
      renderers: async () => (await rendererProcesses(browserCdp)).map((p) => ({ pid: p.id, cpuSeconds: p.cpuTime })),
      release,
    });
  }
  let frameId: string | undefined;
  return new RendererMemory({
    mark: async (read) => {
      const s = await pageSession();
      frameId ??= (await s.send('Page.getFrameTree')).frameTree.frame.id;
      const { executionContextId } = await s.send('Page.createIsolatedWorld', { frameId, worldName: 'sandburg-renderer-mark' });
      const reading = async (): Promise<Reading> => {
        const from = await metric('ThreadTime');
        const renderers = await read();
        return { renderers, from, to: await metric('ThreadTime') };
      };
      const first = await reading();
      // Work until the thread has used `work` by its own count (what is left at a time); 1 s at most.
      const work = first.to + MARK_MIN_S + Math.random() * (MARK_MAX_S - MARK_MIN_S);
      const since = performance.now();
      for (let now = first.to; now < work && performance.now() - since < 1000; now = await metric('ThreadTime')) {
        await s.send('Runtime.evaluate', { expression: markSlice(Math.max(5, (work - now) * 1000)), contextId: executionContextId });
      }
      return [first, await reading()];
    },
    renderers: async () =>
      (await rendererProcesses(browserCdp)).flatMap((p) => {
        const cpu = mainThreadCpu(p.id);
        return cpu === null ? [] : [{ pid: p.id, cpuSeconds: cpu.seconds, toleranceSeconds: cpu.toleranceSeconds }];
      }),
    release,
  });
}

/** `ms` of work on the page's main thread (in a world of its own: its own performance.now). */
const markSlice = (ms: number) => `{ const until = performance.now() + ${ms.toFixed(1)}; while (performance.now() < until); }`;
