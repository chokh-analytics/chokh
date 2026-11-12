// Stop a list of things in order, each after the one before it has stopped.
//
// In order, because they depend on one another: the listener before the store
// its requests write to, the store before the presence set it touches. And
// never stopped by a failure: a step that throws is reported and the next one
// still runs, so a database that went away first cannot leave the process
// hanging on a close that will never be answered.
export type ShutdownStep = readonly [name: string, stop: () => Promise<unknown>];

export async function shutdown(
  steps: readonly ShutdownStep[],
  warn: (details: object, message: string) => void,
): Promise<void> {
  for (const [name, stop] of steps) {
    try {
      await stop();
    } catch (error) {
      warn({ err: error, step: name }, 'a step of the shutdown failed, carrying on');
    }
  }
}
