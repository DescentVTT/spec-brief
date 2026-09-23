import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The git tests spawn git a dozen times. That is milliseconds on a Linux
    // runner and, measured on a Windows workstation with real-time scanning,
    // over a second a process.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // types.ts is type-only: it compiles to an empty module.
      exclude: ['src/types.ts'],
      reporter: ['text', 'lcov'],
      // Floors set just below the measured numbers, so that losing ground
      // fails the build while ordinary refactoring does not. They move up
      // with the measurement and never down to make a change pass.
      //
      // Measured at 0.1.0 on Windows: lines 100, statements 99.57, functions
      // 99.8, branches 96.46. The branches left are `??` fallbacks that
      // noUncheckedIndexedAccess requires and no input reaches, and the
      // platform paths of which one host runs only one. Mutation testing is the
      // check on the branches that carry behaviour.
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 99,
        branches: 95,
      },
    },
  },
});
