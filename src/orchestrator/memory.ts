/**
 * Memory the machine can still give: what a batch checks before it opens another app (batch.ts).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

/**
 * Bytes available: the system's (Linux: MemAvailable, which counts the page cache that can be
 * reclaimed; macOS: see darwinAvailable), or less when this process's memory cgroup has a lower limit
 * (a container): its limit minus what it uses besides the page cache (which the kernel reclaims
 * before it kills a process; shared memory, which Chromium's shared buffers are, is not reclaimed and
 * counts as used).
 */
export function availableMemory(): number {
  const free = process.platform === 'darwin' ? (darwinAvailable() ?? freemem()) : freemem();
  const cgroup = cgroupAvailable();
  return cgroup === null ? free : Math.min(free, cgroup);
}

/**
 * macOS: free and inactive pages, as psutil counts available memory there. os.freemem() is the free
 * pages alone (libuv's host_statistics free_count), which macOS keeps low by caching files in the
 * rest (on the CI's macOS runner, a batch of two at a time opened one app at a time).
 */
function darwinAvailable(): number | null {
  // A batch short of memory asks on each look: one vm_stat (a few ms, on the main thread) a second.
  if (vmStat && clock() - vmStat.at < VM_STAT_TTL_MS) return vmStat.bytes;
  let bytes: number | null = null;
  try {
    bytes = parseVmStat(readVmStat());
  } catch {
    // none: os.freemem()
  }
  // Timed from when the reading came back: a slow one (up to its 2 s timeout) is still kept a second.
  vmStat = { at: clock(), bytes };
  return bytes;
}

/** By its path, not looked up on PATH. */
export const VM_STAT = '/usr/bin/vm_stat';
const VM_STAT_TTL_MS = 1000;
let vmStat: { at: number; bytes: number | null } | null = null;
let clock = () => performance.now();
let readVmStat = () => execFileSync(VM_STAT, { encoding: 'utf8', timeout: 2000 });

/** For tests: macOS's reading with a clock and a vm_stat of their own (none: the real ones, and no reading kept). */
export function darwinAvailableWith(fake: { clock: () => number; vmStat: () => string } | null): () => number | null {
  clock = fake?.clock ?? (() => performance.now());
  readVmStat = fake?.vmStat ?? (() => execFileSync(VM_STAT, { encoding: 'utf8', timeout: 2000 }));
  vmStat = null;
  return darwinAvailable;
}

/** Bytes free or inactive in vm_stat's output; null if it does not have them. */
export function parseVmStat(out: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(out)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, 'm').exec(out)?.[1]);
  const bytes = (pages('free') + pages('inactive')) * page;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

function cgroupAvailable(): number | null {
  if (process.platform !== 'linux') return null;
  let lines: string[];
  try {
    lines = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n');
  } catch {
    return null;
  }
  // cgroup v1: "N:memory:/path"; v2: "0::/path". The path is relative to the cgroup namespace's
  // root, which is where /sys/fs/cgroup is mounted in a container: try the path, then the root.
  const v1 = lines.find((l) => l.split(':')[1]?.split(',').includes('memory'));
  const v2 = lines.find((l) => l.startsWith('0::'));
  // undefined: not there (the next place is tried); null: no limit.
  const read = (dir: string, limitFile: string, usageFile: string, [cacheKey, shmemKey]: [string, string]): number | null | undefined => {
    try {
      const limit = readFileSync(join(dir, limitFile), 'utf8').trim();
      // No limit, or one above the machine's memory (v1 writes a huge number for none).
      if (limit === 'max' || Number(limit) >= totalmem()) return null;
      const usage = Number(readFileSync(join(dir, usageFile), 'utf8').trim());
      const stat = readFileSync(join(dir, 'memory.stat'), 'utf8');
      const field = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(stat)?.[1] ?? 0);
      const available = Number(limit) - (usage - field(cacheKey) + field(shmemKey));
      return Number.isFinite(available) ? Math.max(0, available) : null;
    } catch {
      return undefined;
    }
  };
  const tries: [string, string, string, [string, string]][] = [];
  if (v2) {
    const path = v2.slice(3);
    for (const dir of [join('/sys/fs/cgroup', path), '/sys/fs/cgroup']) tries.push([dir, 'memory.max', 'memory.current', ['file', 'shmem']]);
  }
  if (v1) {
    const path = v1.split(':').slice(2).join(':');
    for (const dir of [join('/sys/fs/cgroup/memory', path), '/sys/fs/cgroup/memory']) tries.push([dir, 'memory.limit_in_bytes', 'memory.usage_in_bytes', ['total_cache', 'total_shmem']]);
  }
  for (const t of tries) {
    const got = read(...t);
    if (got !== undefined) return got;
  }
  return null;
}
