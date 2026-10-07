import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The published binary, spawned as a user would run it. Left out of mutation
 * runs: a mutant is never compiled into dist/.
 */
describe('the binary', () => {
  beforeAll(() => {
    if (!existsSync('dist/cli.js')) execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
  });

  it('prints its version and exits 0', () => {
    const result = spawnSync(process.execPath, ['bin/spec-brief.js', '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('sets the exit code a command returns', () => {
    const result = spawnSync(process.execPath, ['bin/spec-brief.js', 'no-such-command'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is not a command');
  });

  // main answers what it awaits, in process (cli.test.ts). An error thrown
  // from a callback - a stream's, a timer's - reaches no promise, and only the
  // launcher can answer it. Node's own answer is exit 1, "findings" to a script.
  it('ends an error nothing awaits with exit 2 and its stack on stderr', () => {
    // Loaded before the launcher: when the run has nothing left to do, it
    // throws where no promise holds the error.
    const stray = 'process.once("beforeExit", () => setImmediate(() => { throw new Error("thrown where nothing awaits"); }));';
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stray)}`, 'bin/spec-brief.js', '--version'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^spec-brief: unexpected error: Error: thrown where nothing awaits\n {4}at /);
    // The run had answered by then, and its answer is not printed twice.
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
