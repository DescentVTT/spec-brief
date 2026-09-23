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
});
