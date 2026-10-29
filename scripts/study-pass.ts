/**
 * A fidelity-study pass's result, from the process that ran it to the study's (scripts/fidelity-study.ts):
 * one `PASS <json>` line on the child's stdout. A pass of 232 apps is ~150 KB of JSON, more than a
 * pipe holds, and a write to a pipe completes later: the child exits once its line is written, and
 * the parent reads it once the pipe is closed.
 */
import type { ChildProcess } from 'node:child_process';

/** Writes the result line; resolves once it is written (a process that exits sooner cuts it off). */
export function writePass(value: unknown): Promise<void> {
  return new Promise((done, fail) => process.stdout.write(`PASS ${JSON.stringify(value)}\n`, (err) => (err ? fail(err) : done())));
}

/** The result line of `child` (spawned with stdout piped), once its stdout has closed; an error unless it exited with 0. */
export function readPass<T>(child: ChildProcess, what: string): Promise<T> {
  let out = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => (out += d));
  return new Promise((done, fail) => {
    child.on('error', fail);
    // 'close', not 'exit': at 'exit' the child's stdout may not have been read to its end.
    child.on('close', (code, signal) => {
      const line = out.split('\n').find((l) => l.startsWith('PASS '));
      if (code === 0 && line) done(JSON.parse(line.slice(5)) as T);
      else fail(new Error(`${what} ended (${signal ? `signal ${signal}` : `exit ${code}`}) without a result`));
    });
  });
}
