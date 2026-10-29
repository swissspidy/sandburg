/**
 * What a commit does not say about a fidelity study's code (scripts/fidelity-study.ts): a digest of
 * the uncommitted changes to the given paths of a git checkout, so that a study does not go on from
 * passes run with other edits to an app's files, its checks or Sandburg.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A digest of `paths`' changes in the checkout at `repo`: git status, the diff of tracked files from
 * HEAD, and each untracked file's path and contents (git diff leaves them out, and git status names
 * them only), by path. Ignored files (node_modules/, .sandburg/) are not in it. Null outside
 * a git checkout.
 */
export function treeDigest(repo: string, paths: string[]): string | null {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, maxBuffer: 256 * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const hash = createHash('sha256').update(git('status', '--porcelain', '--', ...paths)).update(git('diff', 'HEAD', '--', ...paths));
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z', '--', ...paths)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    for (const path of untracked) hash.update(`\0${path}\0`).update(readFileSync(join(repo, path)));
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
