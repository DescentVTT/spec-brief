import { relative } from 'node:path';

import { defineConfig } from 'vitest/config';
import type { TestSequencer, TestSpecification, Vitest } from 'vitest/node';

/**
 * The order a mutant's test files run in, in both sweeps: a file that failed
 * in the worker's last run first, as vitest has it, then the quickest first,
 * where vitest runs the longest first.
 *
 * Stryker runs a mutant's files one after another in one worker and stops at
 * the first test that fails, so what a mutant costs is the files that run
 * before the one that kills it. Vitest's order suits a run that reports every
 * failure and wants the long files started early; here it puts
 * `tests/glob.test.ts`, `tests/cli.test.ts` and `tests/schedule.test.ts`,
 * two thirds of the suite's time between them, ahead of the unit file that
 * kills the mutant in milliseconds.
 *
 * No test leaves the run and none is added: a mutant survives when every
 * file has passed, in any order.
 *
 * A file the worker has not run yet has no time to go by. It runs after
 * those that have, the smaller first, and has a time from then on.
 *
 * The type alone is imported from `vitest/node`: four test files read
 * `vitest.core.config.ts`, which reads this one, and a class that extended
 * vitest's own would have each of them load vitest's node side.
 */
export class QuickestFirst implements TestSequencer {
  readonly #ctx: Vitest;

  constructor(ctx: Vitest) {
    this.#ctx = ctx;
  }

  /** Neither sweep hands vitest a shard; a run that did gets vitest's own split. */
  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { BaseSequencer } = await import('vitest/node');
    return new BaseSequencer(this.#ctx).shard(files);
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { cache, config } = this.#ctx;
    const rank = (file: TestSpecification): [number, number] => {
      // The key vitest's own sequencer reads its cache by; a test holds the two together.
      const key = `${file.project.name}:${relative(config.root, file.moduleId).replaceAll('\\', '/')}`;
      const last = cache.getFileTestResults(key);
      if (last === undefined) return [2, cache.getFileStats(key)?.size ?? 0];
      return [last.failed ? 0 : 1, last.duration];
    };
    const ranked = files.map((file) => ({ file, rank: rank(file) }));
    return ranked.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map(({ file }) => file);
  }
}

/**
 * Vitest configuration for mutation runs: the same suite, without coverage
 * instrumentation. Stryker measures its own coverage per test, and v8
 * coverage on every one of thousands of mutant runs is a number nobody reads.
 *
 * The CLI tests drive `main()` in process rather than spawning the binary, so
 * they load the mutated source and can kill mutants. Two files are left out.
 * `bin.test.ts` spawns the built binary, which a mutant never reaches.
 * `source.test.ts` reads the source as text, and in the sandbox that text is
 * Stryker's instrumented copy, which says `process` in every file.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/bin.test.ts', 'tests/source.test.ts', '**/node_modules/**'],
    environment: 'node',
    // The git tests spawn git a dozen times. That is milliseconds on a Linux
    // runner and, measured on a Windows workstation with real-time scanning,
    // over a second a process.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    sequence: { sequencer: QuickestFirst },
  },
});
