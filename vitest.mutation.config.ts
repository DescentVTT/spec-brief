import { defineConfig } from 'vitest/config';

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
  },
});
