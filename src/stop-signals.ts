/**
 * The signals that stop a command: Ctrl-C (SIGINT), a kill (SIGTERM) and, on Windows, Ctrl-Break
 * (SIGBREAK). Each ends the process with 128 + its number, as a shell reports a process the signal
 * ended (SIGBREAK is 21 on Windows: 149).
 */
export const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 } as const;
export type StopSignal = keyof typeof STOP_SIGNALS;

/**
 * Runs `work`; one of `signals` meanwhile calls `stop` (stops the runs, closes the browser), then
 * exits with the signal's code. The listeners those signals had (Playwright's: close the browser,
 * exit at once) wait meanwhile: a second signal gets them, or the signal's default action. Once a
 * signal came, `work`'s error is not the outcome (the runs it cut short fail), the exit is; `work`
 * may ask `stopping()` to leave out what it would do after.
 */
export async function untilStopped<T>(signals: readonly StopSignal[], stop: (signal: StopSignal) => Promise<unknown>, work: (stopping: () => boolean) => Promise<T>): Promise<T> {
  const held = signals.map((signal) => [signal, process.listeners(signal)] as const);
  let released = false;
  /** Set once a signal came: the process exits when `stop` is done. */
  const state: { exiting: Promise<never> | null } = { exiting: null };
  const release = () => {
    if (released) return;
    released = true;
    for (const [signal, listeners] of held) {
      process.off(signal, interrupted);
      for (const l of listeners) process.on(signal, l);
    }
  };
  const interrupted = (signal: StopSignal) => {
    release();
    const exit = () => process.exit(STOP_SIGNALS[signal]);
    state.exiting = Promise.resolve()
      .then(() => stop(signal))
      .then(exit, exit);
  };
  for (const [signal, listeners] of held) {
    for (const l of listeners) process.off(signal, l);
    process.on(signal, interrupted);
  }
  try {
    const result = await work(() => state.exiting !== null).catch((err: unknown) => {
      if (state.exiting) return state.exiting;
      throw err;
    });
    if (state.exiting) return await state.exiting;
    return result;
  } finally {
    release();
  }
}
