import { defineConfig } from 'vitest/config';

/**
 * The unit suite: every test that reads no disk and spawns no process.
 *
 * This is the suite `stryker.core.config.mjs` holds the pure modules to. The
 * CLI, engine and git tests run every line of the core as well, so under
 * per-test coverage a core mutant would run them too, and each spawns git: a
 * full sweep measured 20 hours on a Windows workstation at that rate. Held to
 * the unit suite alone, a core mutant is killed by the tests written for its
 * module, which is the stronger claim anyway.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/bin.test.ts',
      'tests/cli.test.ts',
      'tests/engine.test.ts',
      'tests/io.test.ts',
      'tests/source.test.ts',
      '**/node_modules/**',
    ],
    environment: 'node',
    testTimeout: 30_000,
  },
});
