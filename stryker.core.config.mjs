// @ts-check
/**
 * The core sweep: the pure modules, held to the unit suite alone.
 *
 *   npx stryker run stryker.core.config.mjs
 *
 * The modules that decide things - parsing, globs, dependencies, collisions,
 * rules, the archival planner and the transaction - with nothing that spawns
 * a process in the loop. It runs in minutes where the full sweep runs for
 * hours on a slow host. The edges (cli, engine, fs, git, plugins) are measured
 * by the full sweep in CI. See docs/adr/0009-mutation-testing.md.
 */
import base from './stryker.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  vitest: { configFile: 'vitest.core.config.ts', related: false },
  mutate: [
    'src/**/*.ts',
    '!src/types.ts',
    '!src/index.ts',
    '!src/cli.ts',
    '!src/engine.ts',
    '!src/fs.ts',
    '!src/git.ts',
    '!src/plugins.ts',
    '!src/vendor/**',
  ],
  // Unit tests finish in milliseconds; a mutant still running after a few
  // seconds is one that will not finish.
  timeoutMS: 3000,
  // A regression guard below the measurement, never a target to argue down
  // to: 95.75 on 2026-09-24, 97.83 on 2026-09-26, and the rule for moving it
  // is in ADR-0009.
  thresholds: { high: 95, low: 90, break: 93 },
  htmlReporter: { fileName: 'reports/mutation-core/index.html' },
  jsonReporter: { fileName: 'reports/mutation-core/mutation.json' },
};
