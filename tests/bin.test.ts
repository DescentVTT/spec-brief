import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { tempDir } from './helpers.js';

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

  // cli.test.ts hands main an environment of its own. The launcher hands it
  // none, so the one read is the process's, and a variable that is set and
  // empty has to arrive there as one: it is not the variable left unset.
  it('reads SOURCE_DATE_EPOCH from the environment of the process, and refuses one that is set and empty', () => {
    const root = tempDir('bin-epoch');
    const dated = (epoch: string): { code: number | null; out: string; err: string } => {
      const result = spawnSync(process.execPath, ['bin/spec-brief.js', 'new', 'A title', '--root', root, '--no-git'], {
        encoding: 'utf8',
        env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    try {
      expect(dated('')).toEqual({
        code: 2,
        out: '',
        err: 'spec-brief: SOURCE_DATE_EPOCH is "", which is not a whole number of seconds since 1970-01-01; set it to one in digits alone, as "date +%s" prints it, or unset it\n',
      });
      expect(existsSync(join(root, 'briefs'))).toBe(false);
      expect(dated('1790208000')).toEqual({ code: 0, out: 'wrote briefs/001_a-title.md\n', err: '' });
      expect(readFileSync(join(root, 'briefs', '001_a-title.md'), 'utf8')).toContain('\ndate: 2026-09-24\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  describe('a reader that closed the output', () => {
    // The process's own streams never throw this where main awaits it
    // (cli.test.ts holds that case): the write fails, and the stream reports
    // it as an event, which only the launcher can answer.
    const CLOSED = 'spec-brief: stdout was closed before all of the output was written\n';

    /**
     * The launcher with one of its outputs closed by its reader before the run
     * writes to it, as stdout is behind `| head` once head has left. What the
     * other output was sent is the answer.
     */
    function closing(stream: 'stdout' | 'stderr', args: readonly string[]): Promise<{ code: number; read: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['bin/spec-brief.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child[stream].destroy();
        const open = stream === 'stdout' ? child.stderr : child.stdout;
        let read = '';
        open.setEncoding('utf8');
        open.on('data', (chunk: string) => (read += chunk));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code: code ?? -1, read }));
      });
    }

    it.each([
      ['--help', ['--help']],
      ['list', ['list']],
      ['lint, as JSON', ['lint', '--format', 'json']],
    ])('ends %s with exit 2 and one line on stderr, with no stack', async (_name, args) => {
      expect(await closing('stdout', args)).toEqual({ code: 2, read: CLOSED });
    });

    it('says nothing when stderr is the one that closed, on stdout either, and still exits 2', async () => {
      // Left to Node, the error of that write is exit 1.
      expect(await closing('stderr', ['no-such-command'])).toEqual({ code: 2, read: '' });
    });

    // A shell's pipe, where Node's own child is a socket pair: the reader has
    // left by the time the run writes. Without a shell there is no pipeline to
    // make, and cmd's has no way to hand back the exit code of its left side.
    it.skipIf(process.platform === 'win32')('says so behind a shell pipe whose reader has left', () => {
      const pipeline = '{ sleep 1; "$0" bin/spec-brief.js --help; echo "exit $?" >&2; } | true';
      const result = spawnSync('sh', ['-c', pipeline, process.execPath], { encoding: 'utf8' });

      expect(result.stderr).toBe(`${CLOSED}exit 2\n`);
    });
  });
});
