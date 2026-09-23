// @ts-check
/**
 * Mutation testing configuration.
 *
 * Coverage says a line ran. Mutation testing says an assertion pins its
 * behaviour down, which is the property that matters for the parts of this
 * tool that decide things: whether two globs can meet, whether a box is
 * dispositioned, whether a transaction rolls back, whether a finding is an
 * error or a note.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },

  // Only the tests that reached a mutated line run for it.
  coverageAnalysis: 'perTest',

  // types.ts is type-only and index.ts is re-exports: nothing to mutate.
  // cli.ts is mutated with the rest: the CLI tests drive main() in process.
  mutate: ['src/**/*.ts', '!src/types.ts', '!src/index.ts'],

  // Stryker's sandbox rewrites a tsconfig that reaches outside the project,
  // and the rewriter calls a TypeScript API that TypeScript 7's native
  // compiler does not expose. Ours reaches nowhere, so a file that does not
  // exist makes the step a no-op. The same workaround as the sibling tools.
  tsconfigFile: 'tsconfig.stryker-noop.json',

  // Only the mutated sources get "// @ts-nocheck"; the tests stay as written.
  disableTypeChecks: 'src/**/*.ts',

  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  clearTextReporter: { allowColor: false, maxTestsToLog: 0, reportScoreTable: true },

  // A hung mutant is a real detection - a mutated loop bound can run forever
  // - but each one holds a worker for the whole budget.
  timeoutMS: 20000,
  concurrency: 8,
  // The initial run is the whole suite in one process. Its git tests spawn
  // git dozens of times, which is seconds on a host that scans every process.
  dryRunTimeoutMinutes: 30,

  // `break` is a regression guard set below the measured score, never a
  // target to argue down to. See docs/adr/0009-mutation-testing.md for the
  // measurement it rests on and the rule for moving it.
  thresholds: { high: 90, low: 80, break: 80 },
};
