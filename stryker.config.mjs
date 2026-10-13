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

  // types.ts is type-only: Stryker makes no mutant of it, and a test holds
  // that of every file left out here (tests/mutation-sweeps.test.ts).
  // index.ts is re-exports and one function, `definePlugin`, whose body is
  // its one mutant; it was left out as re-exports alone until 2026-10-14.
  // cli.ts is mutated with the rest: the CLI tests drive main() in process.
  // The vendored spec-core is mutated in spec-core, where its oracle is.
  mutate: ['src/**/*.ts', '!src/types.ts', '!src/vendor/**'],

  // Stryker's sandbox rewrites a tsconfig that reaches outside the project,
  // and the rewriter calls a TypeScript API that TypeScript 7's native
  // compiler does not expose. Ours reaches nowhere, so a file that does not
  // exist makes the step a no-op. The same workaround as the sibling tools.
  tsconfigFile: 'tsconfig.stryker-noop.json',

  // Only the mutated sources get "// @ts-nocheck"; the tests stay as written.
  // Nor does the vendored spec-core: a file that gets it no longer has the hash
  // tests/vendor.test.ts checks, and the first hosted full sweep (run
  // 36312377428) failed its initial test run on exactly that.
  disableTypeChecks: 'src/*.ts',

  reporters: ['html', 'json', 'clear-text', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  clearTextReporter: { allowColor: false, maxTestsToLog: 0, reportScoreTable: true },

  // A hung mutant is a real detection, and this is what a mutant is allowed
  // over its tests' own time before it is called hung, in both sweeps. Few
  // wait for it: a loop that no longer ends passes its own switch until
  // Stryker's hit limit ends the run, and of the full sweep's 39 to 41
  // timeouts five or six are this clock's, about half a minute of a sweep
  // between them. A shorter clock returns seconds of that and costs verdicts:
  // at three seconds the core sweep scored mutants that survive, and mutants
  // a test kills, as timed out (ADR-0009, amended 2026-10-11).
  timeoutMS: 20000,
  // Workers are left to Stryker, which sizes them to the host. A fixed eight
  // on the four-core hosted runner slowed every mutant enough that 85 of the
  // workstation's survivors timed out there, and a timeout counts as a kill.
  // The initial run is the whole suite in one process. Its git tests spawn
  // git dozens of times, which is seconds on a host that scans every process.
  dryRunTimeoutMinutes: 30,

  // Main's full sweep of 9670753 read 99.31% over 6,941 mutants in 25 minutes
  // (ADR-0009); losing its 40 timeout kills would leave 98.73%. The break sits
  // under both, at the core sweep's 97, and moves up with the measurement.
  thresholds: { high: 99, low: 97, break: 97 },
};
