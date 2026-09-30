/**
 * Timing for the tests that hold work to cost linear in what it reads.
 *
 * A test of cost states a ratio, not a number of milliseconds, as spec-core's
 * ADR-0007 has it: a slow or busy machine slows every run, and can push one
 * past any fixed bound. So the same work is timed at two sizes, taken in
 * turn, so that a stretch when the machine is busy slows both, and the larger
 * is held to a small multiple of what linear work would take.
 */

/**
 * Whether the code under test is instrumented, by coverage or by Stryker.
 * Instrumented, every statement costs several times more; a ratio survives
 * that, since it slows both sizes alike, but work grown large enough to time
 * costs a sweep more for each mutant than it tells it.
 */
export function instrumented(): boolean {
  const worker = (globalThis as Record<string, unknown>)['__vitest_worker__'] as { config?: { coverage?: { enabled?: boolean } } } | undefined;
  return '__stryker__' in globalThis || worker?.config?.coverage?.enabled === true;
}

/**
 * The fastest of a few runs of each piece of work, the pieces taken in turn,
 * so that a stretch when the machine is busy slows every one of them and not
 * only whichever was running; each run is awaited before the next starts.
 */
export async function fastestInTurn(runs: number, ...work: (() => unknown)[]): Promise<number[]> {
  const best = work.map(() => Number.POSITIVE_INFINITY);
  for (let i = 0; i < runs; i += 1) {
    for (const [k, run] of work.entries()) {
      const started = performance.now();
      await run();
      best[k] = Math.min(best[k] as number, performance.now() - started);
    }
  }
  return best;
}
