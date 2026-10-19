import { defineConfig } from 'vitest/config';

import { QuickestFirst } from './vitest.mutation.config.js';

/**
 * The unit suite: every test that reads no disk and spawns no process.
 *
 * This is the suite `stryker.core.config.mjs` holds the pure modules to. The
 * CLI, engine and git tests run every line of the core as well, so under
 * per-test coverage a core mutant would run them too, and each spawns git: a
 * full sweep measured 20 hours on a Windows workstation at that rate. Held to
 * the unit suite alone, a core mutant is killed by the tests written for its
 * module, which is the stronger claim anyway.
 *
 * A mutant's files run quickest first, as in the full sweep and for its
 * reason (`vitest.mutation.config.ts`). The test of that order reaches no
 * module, and is left out here as it is there; so are the tests of what a
 * sweep leaves unmeasured and of which sweep reads what, which read the
 * sources as text, and the test of the comparison with main's report, which
 * writes to disk and starts a process.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/bin.test.ts',
      'tests/cli.test.ts',
      'tests/engine.test.ts',
      'tests/inputs.test.ts',
      'tests/io.test.ts',
      'tests/io-faults.test.ts',
      'tests/mutation-compare.test.ts',
      'tests/mutation-order.test.ts',
      'tests/mutation-sweeps.test.ts',
      'tests/mutation-unmeasured.test.ts',
      'tests/names.test.ts',
      'tests/npm.test.ts',
      'tests/runner-images.test.ts',
      'tests/source.test.ts',
      'tests/vendor.test.ts',
      '**/node_modules/**',
    ],
    environment: 'node',
    testTimeout: 30_000,
    sequence: { sequencer: QuickestFirst },
    // Named, for the reason `vitest.mutation.config.ts` gives.
    reporters: ['default'],
  },
});
