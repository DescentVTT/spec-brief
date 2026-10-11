// @ts-check
/**
 * The core sweep: the pure modules, held to the unit suite alone.
 *
 *   npx --no-install stryker run stryker.core.config.mjs
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
  // No clock of its own: a mutant is allowed here what the full sweep allows
  // it (`timeoutMS` in stryker.config.mjs). This sweep had three seconds, on
  // the ground that a unit test still running after a few is one that will
  // not finish. A mutant that runs the whole unit suite beside three other
  // workers did not finish in them either: each sweep scored as timed out
  // between one and three mutants that survive, and three sweeps scored so
  // seventy static mutants of src/trigger.ts, one after another, that a test
  // kills (ADR-0009, amended 2026-10-11).

  // A regression guard below the measurement, never a target to argue down
  // to: 95.75 on 2026-09-24, 97.83 on 2026-09-26, 99.38 on 2026-10-07 (98.68
  // with every timeout lost), and the rule for moving it is in ADR-0009.
  thresholds: { high: 99, low: 97, break: 97 },
  htmlReporter: { fileName: 'reports/mutation-core/index.html' },
  jsonReporter: { fileName: 'reports/mutation-core/mutation.json' },
};
