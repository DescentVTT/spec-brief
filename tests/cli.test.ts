import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parse, UsageError } from '../src/cli.js';
import { commitAll, goodBrief, initRepo, Sink, tempDir, writeTree } from './helpers.js';

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string;
  err: string;
}

async function run(cwd: string, args: string[], env: Record<string, string | undefined> = {}, tty = false): Promise<Result> {
  const stdout = new Sink();
  stdout.isTTY = tty;
  const stderr = new Sink();
  // A directory with no repository gets --no-git, so the suite does not spawn
  // git to learn what it already knows. The engine tests cover discovery.
  const git = existsSync(join(cwd, '.git')) || args.includes('--no-git') || cwd === process.cwd() ? [] : ['--no-git'];
  const code = await main([...args, ...git], { stdout, stderr, cwd, env: { SOURCE_DATE_EPOCH: '1790208000', ...env } });
  return { code, out: stdout.text, err: stderr.text };
}

/** A directory with a configuration and no git: most commands need nothing more. */
function plain(name: string, files: Record<string, string>): string {
  const root = dir(name);
  writeTree(root, { '.spec-brief.json': '{}', ...files });
  return root;
}

function repo(name: string, files: Record<string, string>): string {
  const root = dir(name);
  initRepo(root);
  writeTree(root, { '.spec-brief.json': '{}', ...files });
  commitAll(root, 'init');
  return root;
}

describe('arguments', () => {
  it('finds the command past global options that take a value', () => {
    expect(parse(['--root', 'x', 'lint', 'a']).command).toBe('lint');
    expect(parse(['--format', 'json', 'list']).command).toBe('list');
    expect(parse(['--config', 'c.json', '--strict', 'lint']).positionals).toEqual([]);
    expect(parse(['lint', '--', '--odd']).positionals).toEqual(['--odd']);
    expect(parse(['--', 'lint']).command).toBe('lint');
    expect(parse(['--strict']).command).toBeUndefined();
  });

  it('refuses an unknown command and an unknown option', () => {
    expect(() => parse(['lnit'])).toThrow(new UsageError('"lnit" is not a command; run spec-brief --help'));
    expect(() => parse(['lint', '--pr', '3'])).toThrow(UsageError);
    expect(String(new UsageError('no'))).toBe('UsageError: no');
  });

  it('takes what follows "--" for the command, whatever it looks like', () => {
    expect(() => parse(['--', '--root'])).toThrow(new UsageError('"--root" is not a command; run spec-brief --help'));
  });

  it('reads the arguments the process was started with when it is handed none', async () => {
    const started = process.argv;
    const stdout = new Sink();
    try {
      process.argv = ['node', 'spec-brief', '--help'];
      expect(await main(undefined, { stdout, stderr: new Sink() })).toBe(EXIT_OK);
    } finally {
      process.argv = started;
    }
    expect(stdout.text).toBe(HELP);
  });
});

describe('help, version and usage errors', () => {
  const cwd = process.cwd();

  it('prints help and the version', async () => {
    expect(await run(cwd, ['--help'])).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect(await run(cwd, ['lint', '-h'])).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(await run(cwd, ['-v'])).toEqual({ code: EXIT_OK, out: `${pkg.version}\n`, err: '' });
  });

  it('exits 2 for no command, a bad command, a bad option or a bad format', async () => {
    expect((await run(cwd, [])).code).toBe(EXIT_ERROR);
    expect(await run(cwd, ['frobnicate'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: "frobnicate" is not a command; run spec-brief --help\n' });
    expect((await run(cwd, ['lint', '--bogus'])).code).toBe(EXIT_ERROR);
    expect((await run(cwd, ['list', '--format', 'sarif'])).err).toBe('spec-brief: --format for list is one of pretty, json, not "sarif"\n');
  });

  it('exits 2 for a command named as something every object answers to', async () => {
    // The commands were looked up in an object, which answers to these too:
    // each passed for a command, and the run ended on a stack trace with exit 1.
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(await run(cwd, [name]), name).toEqual({ code: EXIT_ERROR, out: '', err: `spec-brief: "${name}" is not a command; run spec-brief --help\n` });
    }
  });

  it('names the formats each command writes, and none it refuses', async () => {
    // The finding formats are lint's, matrix's and schedule's: the help once
    // offered all five under the options for every command.
    expect(HELP).toContain(
      ['Formats:', '  init, new, list, archive, unarchive  pretty, json', '  lint, matrix, schedule               pretty, json, sarif, github, gitlab', ''].join('\n'),
    );
    expect(HELP).not.toMatch(/--format <format> .*sarif/);
    for (const command of ['init', 'new', 'list', 'archive', 'unarchive']) {
      expect((await run(cwd, [command, '--format', 'gitlab'])).err, command).toBe(`spec-brief: --format for ${command} is one of pretty, json, not "gitlab"\n`);
    }
  });
});

describe('an error before any command runs', () => {
  // A command's own unexpected failure is held below, by `init` over a file
  // where a directory is wanted. What main does before it reaches a command
  // was outside that: an error there left main as a rejection, and the
  // launcher ended it as Node's uncaught error, exit 1, "findings" to a script.
  const gone = (): never => {
    throw new Error('the stream is gone');
  };
  const STACK = /^spec-brief: unexpected error: Error: the stream is gone\n {4}at [^]*\n$/;

  it.each([
    ['--version', ['--version']],
    ['--help', ['--help']],
    ['no command, which prints the help', []],
  ])('exits 2 with the stack on stderr when %s cannot be written', async (_name, argv) => {
    const stderr = new Sink();
    expect(await main(argv, { stdout: { write: gone }, stderr, cwd: process.cwd(), env: {} })).toBe(EXIT_ERROR);
    expect(stderr.text).toMatch(STACK);
  });

  it('exits 2 the same way when the run itself cannot be set up', async () => {
    // Whether to colour is asked of the stream before any command starts.
    const stdout = {
      write: (): boolean => true,
      get isTTY(): boolean {
        return gone();
      },
    };
    const stderr = new Sink();
    const root = plain('cli-setup-fails', { 'briefs/001_a.md': goodBrief() });
    expect(await main(['lint', '--no-git'], { stdout, stderr, cwd: root, env: {} })).toBe(EXIT_ERROR);
    expect(stderr.text).toMatch(STACK);
  });

  it('reports a thrown value that is no Error as it reads, and an Error with no stack by its message', async () => {
    const bare = new Error('no stack on this one');
    delete bare.stack;
    for (const [thrown, said] of [
      ['only a string', 'only a string'],
      [bare, 'no stack on this one'],
    ] as const) {
      const stderr = new Sink();
      const stdout = {
        write: (): never => {
          throw thrown;
        },
      };
      expect(await main(['--version'], { stdout, stderr, cwd: process.cwd(), env: {} })).toBe(EXIT_ERROR);
      expect(stderr.text).toBe(`spec-brief: unexpected error: ${said}\n`);
    }
  });
});

describe('a reader that closed the output', () => {
  // `spec-brief list --format json | head`: the write fails with EPIPE once
  // head has left. The answer was not delivered, which is still 2, and
  // nothing in spec-brief is at fault, so no stack says a defect was found.
  async function refused(thrown: Error, argv: string[], cwd = process.cwd()): Promise<{ code: number; err: string }> {
    const stderr = new Sink();
    const stdout = {
      write: (): never => {
        throw thrown;
      },
    };
    return { code: await main(argv, { stdout, stderr, cwd, env: {} }), err: stderr.text };
  }
  const failed = (code: string): Error => Object.assign(new Error(`${code}: the write failed`), { code, syscall: 'write' });

  it('ends the run with exit 2 and one line that says so, before a command and inside one', async () => {
    const said = { code: EXIT_ERROR, err: 'spec-brief: stdout was closed before all of the output was written\n' };
    expect(await refused(failed('EPIPE'), ['--version'])).toEqual(said);
    expect(await refused(failed('EPIPE'), ['--help'])).toEqual(said);
    const root = plain('cli-closed-output', { 'briefs/001_a.md': goodBrief() });
    expect(await refused(failed('EPIPE'), ['list', '--no-git'], root)).toEqual(said);
    expect(await refused(failed('EPIPE'), ['lint', '--no-git', '--format', 'json'], root)).toEqual(said);
  });

  it('keeps the stack of a write that failed for any other reason', async () => {
    // A disk that filled up under `> briefs.json` is not a reader that left.
    const result = await refused(failed('ENOSPC'), ['--version']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(/^spec-brief: unexpected error: Error: ENOSPC: the write failed\n {4}at /);
  });

  it('reads the code of the error, not its words', async () => {
    const result = await refused(new Error('EPIPE: broken pipe, write'), ['--version']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(/^spec-brief: unexpected error: Error: EPIPE: broken pipe, write\n {4}at /);
  });
});

describe('a SOURCE_DATE_EPOCH no date can be made of', () => {
  it('is named, with what to do about it, and ends the run with exit 2', async () => {
    // Digits, so it is read as seconds, and more of them than any date has:
    // the date's own complaint was a RangeError and a stack.
    const root = plain('cli-epoch', { 'briefs/001_a.md': goodBrief() });
    expect(await run(root, ['list'], { SOURCE_DATE_EPOCH: '99999999999999999' })).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-brief: SOURCE_DATE_EPOCH is "99999999999999999", which is not a time: no date is that many seconds after 1970-01-01; set it to a date\'s seconds, or unset it\n',
    });
  });
});

describe('init and new', () => {
  it('writes a configuration and the directories, and refuses to do it twice', async () => {
    const root = dir('cli-init');
    const first = await run(root, ['init']);
    expect(first).toEqual({
      code: EXIT_OK,
      out: 'wrote .spec-brief.json\nwrote briefs/.gitkeep\nwrote briefs/archive/.gitkeep\nnext: spec-brief new "<title>"\n',
      err: '',
    });
    expect(JSON.parse(readFileSync(join(root, '.spec-brief.json'), 'utf8'))).toEqual(
      expect.objectContaining({ $schema: './node_modules/@descent-vtt/spec-brief/schema.json', briefs: 'briefs' }),
    );
    expect((await run(root, ['init'])).err).toBe('spec-brief: .spec-brief.json already exists here; edit it instead\n');
    // The file that keeps an empty directory in git holds nothing.
    expect(readFileSync(join(root, 'briefs', '.gitkeep'), 'utf8')).toBe('');
  });

  it('writes into --root, not into the directory it was started in', async () => {
    const root = dir('cli-init-into');
    const elsewhere = dir('cli-init-from');
    expect((await run(elsewhere, ['init', '--root', root])).code).toBe(EXIT_OK);
    expect(existsSync(join(root, '.spec-brief.json'))).toBe(true);
    expect(existsSync(join(elsewhere, '.spec-brief.json'))).toBe(false);
  });

  it('refuses directories that are one, or the root', async () => {
    const refusal = { code: EXIT_ERROR, out: '', err: 'spec-brief: --briefs and --archive must be two directories\n' };
    expect(await run(dir('cli-init-one'), ['init', '--briefs', 'a', '--archive', './a/'])).toEqual(refusal);
    expect(await run(dir('cli-init-briefs-root'), ['init', '--briefs', '.'])).toEqual(refusal);
    expect(await run(dir('cli-init-archive-root'), ['init', '--archive', '.'])).toEqual(refusal);
  });

  it('refuses a directory outside the repository, as the configuration does, and writes nothing', async () => {
    // It ended on a stack: the path's own error is no error main names.
    const root = dir('cli-init-outside');
    expect(await run(root, ['init', '--briefs', '../outside'])).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-brief: --briefs must be a directory inside the repository, not "../outside"\n',
    });
    expect(await run(root, ['init', '--archive', 'a/../../b'])).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-brief: --archive must be a directory inside the repository, not "a/../../b"\n',
    });
    expect(existsSync(join(root, '.spec-brief.json'))).toBe(false);
  });

  it('says where an unexpected failure was thrown, and exits 2', async () => {
    // A file where a directory is wanted is no error spec-brief names: the
    // filesystem's own is reported whole, so the report can be acted on.
    const root = dir('cli-init-file');
    writeTree(root, { specs: 'a file, not a directory' });
    const result = await run(root, ['init', '--briefs', 'specs']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^spec-brief: unexpected error: Error: E[A-Z]+: [^\n]+\n {4}at /);
  });

  it('takes the directories as options, keeps existing ones, and reports as JSON', async () => {
    const root = dir('cli-init-json');
    writeTree(root, { 'specs/keep.md': '' });
    const result = await run(root, ['init', '--briefs', './specs/', '--format', 'json']);
    expect(JSON.parse(result.out)).toEqual(expect.objectContaining({ command: 'init', ok: true, written: ['.spec-brief.json', 'specs/archive/.gitkeep'] }));
    expect(existsSync(join(root, 'specs', '.gitkeep'))).toBe(false);
    expect((await run(dir('cli-init-same'), ['init', '--briefs', 'a', '--archive', 'a'])).code).toBe(EXIT_ERROR);
    expect((await run(dir('cli-init-root'), ['init', '--briefs', '.'])).code).toBe(EXIT_ERROR);
  });

  it('scaffolds a brief with the next id, and says why it cannot', async () => {
    const root = dir('cli-new');
    await run(root, ['init']);
    const made1 = await run(root, ['new', 'Rotate', 'the', 'tokens', '--wave', '2', '--depends-on', '7, 8,', '--type', 'feature']);
    expect(made1).toEqual({ code: EXIT_OK, out: 'wrote briefs/001_rotate-the-tokens.md\n', err: '' });
    const text = readFileSync(join(root, 'briefs', '001_rotate-the-tokens.md'), 'utf8');
    expect(text).toContain('date: 2026-09-24\ntype: feature\nwave: 2\ndependsOn: ["7", "8"]');
    const json = await run(root, ['new', 'Second', '--format', 'json', '--date', '2026-01-02']);
    expect(JSON.parse(json.out)).toEqual(expect.objectContaining({ command: 'new', ok: true, file: 'briefs/002_second.md' }));
    expect(readFileSync(join(root, 'briefs', '002_second.md'), 'utf8')).toContain('\ndate: 2026-01-02\n');
    expect((await run(root, ['new'])).err).toBe('spec-brief: new needs a title: spec-brief new "<title>"\n');
    expect((await run(root, ['new', '  '])).err).toBe('spec-brief: new needs a title: spec-brief new "<title>"\n');
    expect((await run(root, ['new', 'x', '--wave', 'two'])).err).toBe('spec-brief: --wave must be a whole number of at least 0, not "two"\n');
    // A number with anything before or after it is not one.
    expect((await run(root, ['new', 'x', '--wave', '2nd'])).err).toBe('spec-brief: --wave must be a whole number of at least 0, not "2nd"\n');
    expect((await run(root, ['new', 'x', '--wave', 'v2'])).err).toBe('spec-brief: --wave must be a whole number of at least 0, not "v2"\n');
    expect((await run(root, ['new', 'x', '--id', '001'])).err).toBe('spec-brief: the id "001" is taken\n');
    // The least a number may be is allowed.
    expect((await run(root, ['new', 'Third', '--wave', '0'])).out).toBe('wrote briefs/003_third.md\n');
    expect(readFileSync(join(root, 'briefs', '003_third.md'), 'utf8')).toContain('\nwave: 0\n');
  });
});

describe('lint', () => {
  it('exits 0 with a summary when there is nothing to report', async () => {
    const root = plain('cli-lint-clean', { 'briefs/001_a.md': goodBrief() });
    expect(await run(root, ['lint'])).toEqual({ code: EXIT_OK, out: '1 brief(s) checked, no findings\n', err: '' });
  });

  it('exits 1 on an error, and on a warning only under --strict', async () => {
    const root = plain('cli-lint-dirty', { 'briefs/001_a.md': goodBrief({ type: 'epic' }), 'briefs/002_b.md': goodBrief().replace('# A brief\n', '') });
    const pretty = await run(root, ['lint', '--no-color']);
    expect(pretty.code).toBe(EXIT_FAILED);
    expect(pretty.out).toContain('briefs/001_a.md\n  3  error    "epic" is not a brief type here  unknown-type\n');
    expect(pretty.out).toContain('1 error, 1 warning, 0 notes in 2 brief(s)\n');
    const one = await run(root, ['lint', '2']);
    expect(one.code).toBe(EXIT_OK);
    expect(one.out).toContain('0 errors, 1 warning, 0 notes in 1 brief(s)\n');
    expect((await run(root, ['lint', '2', '--strict'])).code).toBe(EXIT_FAILED);
  });

  it('writes JSON, SARIF and GitHub annotations', async () => {
    const root = plain('cli-lint-formats', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const json = JSON.parse((await run(root, ['lint', '--format', 'json'])).out) as Record<string, unknown>;
    expect((json['sections'] as { name: string }[]).map((s) => s.name)).toContain('Negative Scope');
    expect(json).toEqual(
      expect.objectContaining({ tool: 'spec-brief', schemaVersion: 2, command: 'lint', ok: false, checked: 1, summary: { errors: 1, warnings: 0, notes: 0 } }),
    );
    const sarif = JSON.parse((await run(root, ['lint', '--format', 'sarif'])).out) as { runs: { results: unknown[] }[] };
    expect(sarif.runs[0]?.results).toHaveLength(1);
    expect((await run(root, ['lint', '--format', 'github'])).out).toMatch(/^::error file=briefs\/001_a\.md,line=3,title=spec-brief unknown-type::/);
    const gitlab = JSON.parse((await run(root, ['lint', '--format', 'gitlab'])).out) as { check_name: string; severity: string; location: unknown }[];
    expect(gitlab.map((i) => [i.check_name, i.severity, i.location])).toEqual([['unknown-type', 'major', { path: 'briefs/001_a.md', lines: { begin: 3 } }]]);
  });

  it('colours a terminal, and follows NO_COLOR, FORCE_COLOR and the flags', async () => {
    const root = plain('cli-lint-color', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const esc = String.fromCharCode(27);
    expect((await run(root, ['lint'], {}, true)).out).toContain(`${esc}[`);
    expect((await run(root, ['lint'])).out).not.toContain(esc);
    expect((await run(root, ['lint'], { NO_COLOR: '1' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { NO_COLOR: '' }, true)).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '1' })).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '0' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '' })).out).not.toContain(esc);
    expect((await run(root, ['lint', '--color'])).out).toContain(esc);
    expect((await run(root, ['lint', '--no-color'], { FORCE_COLOR: '1' })).out).not.toContain(esc);
    expect((await run(root, ['lint', '--format', 'json', '--color'])).out).not.toContain(esc);
  });

  it('exits 2 for a configuration that does not load, a missing brief and a misspelt rule', async () => {
    const root = plain('cli-lint-config', { 'briefs/001_a.md': goodBrief() });
    writeTree(root, { '.spec-brief.json': '{"briefz": "x"}' });
    expect((await run(root, ['lint'])).err).toBe('spec-brief: .spec-brief.json: "briefz" is not a known key; did you mean "briefs"?\n');
    writeTree(root, { '.spec-brief.json': '{"rules": {"titel": "off"}}' });
    expect((await run(root, ['lint'])).err).toBe('spec-brief: configuration: "rules.titel" names no rule\n');
    writeTree(root, { '.spec-brief.json': '{}' });
    expect((await run(root, ['lint', '404'])).err).toBe('spec-brief: no brief is named "404"\n');
    expect((await run(root, ['lint', '--no-config', '--root', root])).code).toBe(EXIT_OK);
    expect((await run(process.cwd(), ['lint', '--config', join(root, '.spec-brief.json')])).code).toBe(EXIT_OK);
  });

  it('runs from --root instead of the directory it was started in, on the file --config names, and on the defaults under --no-config', async () => {
    const root = plain('cli-root', {
      '.spec-brief.json': JSON.stringify({ briefs: 'specs' }),
      'other.json': JSON.stringify({ briefs: 'briefs' }),
      'specs/001_a.md': goodBrief(),
      'briefs/001_b.md': goodBrief(),
      'briefs/002_c.md': goodBrief(),
    });
    const elsewhere = dir('cli-elsewhere');
    expect(await run(elsewhere, ['lint', '--root', root])).toEqual({ code: EXIT_OK, out: '1 brief(s) checked, no findings\n', err: '' });
    expect((await run(elsewhere, ['lint'])).code).toBe(EXIT_ERROR);
    // The file named is the one read, not the one a search from here would find.
    expect(await run(root, ['lint', '--config', 'other.json'])).toEqual({ code: EXIT_OK, out: '2 brief(s) checked, no findings\n', err: '' });
    // The defaults read briefs/, which the configuration here does not.
    expect(await run(root, ['lint', '--no-config'])).toEqual({ code: EXIT_OK, out: '2 brief(s) checked, no findings\n', err: '' });
  });

  it('reads the files on disk under --no-git, the ones git ignores among them', async () => {
    const root = repo('cli-no-git', {
      '.gitignore': 'generated/\n',
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[generated/**]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["**/out.ts"]' }),
      'generated/deep/out.ts': '',
    });
    const both = '001 "generated/**" and 002 "**/out.ts" both cover';
    expect((await run(root, ['matrix', '--no-color'])).out).toContain(`X ${both} generated/out.ts, an example not in the tree\n`);
    expect((await run(root, ['matrix', '--no-color', '--no-git'])).out).toContain(`X ${both} generated/deep/out.ts\n`);
  });
});

describe('list and matrix', () => {
  const files = {
    'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/auth/**]' }),
    'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["src/**/session.ts"]', dependsOn: '[003]' }),
    'briefs/003_c.md': goodBrief({ wave: '0' }),
    'briefs/archive/004_d.md': goodBrief({ status: 'archived' }),
  };

  it('lists live briefs, archived ones on request, and the ready ones', async () => {
    const root = plain('cli-list', files);
    const all = await run(root, ['list', '--archived', '--no-color']);
    expect(all.out.split('\n').map((l) => l.trimEnd())).toEqual([
      'ID   STATUS    WAVE  TASKS  READY      TITLE',
      '001  active    1     1/1    yes        A brief',
      '002  active    1     1/1    after 003  A brief',
      '003  active    0     1/1    yes        A brief',
      '004  archived  -     1/1    -          A brief',
      '',
    ]);
    const ready = JSON.parse((await run(root, ['list', '--ready', '--format', 'json'])).out) as {
      briefs: { id: string; ready: boolean }[];
      sections: { name: string; type: string | null; hint: string | null }[];
    };
    expect(ready.briefs.map((b) => b.id)).toEqual(['001', '003']);
    expect(ready.sections.map((s) => [s.name, s.type])).toEqual([
      ['Intent', null],
      ['Negative Scope', null],
      ['Not Empowered', null],
      ['Invariants', null],
      ['Acceptance Criteria', 'feature'],
      ['The Defect, Measured', 'defect'],
    ]);
    expect(ready.sections[0]?.hint).toBe('The state of the tree when this round is done, and why it matters. One paragraph.');
    const live = JSON.parse((await run(root, ['list', '--format', 'json'])).out) as { briefs: { id: string; ready: boolean; waitingOn: string[] }[] };
    expect(live).toEqual(expect.objectContaining({ command: 'list', ok: true }));
    expect(live.briefs.map((b) => [b.id, b.ready, b.waitingOn])).toEqual([
      ['001', true, []],
      ['002', false, ['003']],
      ['003', true, []],
    ]);
    const empty = plain('cli-list-empty', { 'briefs/.gitkeep': '' });
    expect((await run(empty, ['list'])).out).toBe('no briefs\n');
    const missing = plain('cli-list-missing', {});
    for (const command of ['list', 'lint', 'matrix']) {
      expect(await run(missing, [command])).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: 'spec-brief: briefs/ does not exist; run "spec-brief init", or set "briefs" in the configuration\n',
      });
    }
  });

  it('draws the matrix, exits 1 on a collision, and reports it in every format', async () => {
    const root = plain('cli-matrix', files);
    const pretty = await run(root, ['matrix', '--no-color']);
    expect(pretty.code).toBe(EXIT_FAILED);
    expect(pretty.out).toContain('wave 1 \u00b7 2 briefs');
    expect(pretty.out).toContain('X 001 "src/auth/**" and 002 "src/**/session.ts" both cover src/auth/session.ts');
    const json = JSON.parse((await run(root, ['matrix', '--format', 'json'])).out) as { waves: { wave: number; collisions: unknown[] }[]; unscheduled: string[] };
    expect(json).toEqual(expect.objectContaining({ command: 'matrix', ok: false, checked: 3 }));
    expect(json.waves.map((w) => [w.wave, w.collisions.length])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect((await run(root, ['matrix', '--format', 'github'])).out).toContain('::error file=briefs/002_b.md');
    const gitlab = await run(root, ['matrix', '--format', 'gitlab']);
    expect(gitlab.code).toBe(EXIT_FAILED);
    expect((JSON.parse(gitlab.out) as { check_name: string }[]).map((i) => i.check_name)).toEqual(['collision']);
    expect((await run(root, ['matrix', '--all-waves', '--no-color'])).out).toContain('all live briefs');
    const calm = plain('cli-matrix-calm', { 'briefs/001_a.md': goodBrief({ wave: '1' }) });
    expect((await run(calm, ['matrix'])).code).toBe(EXIT_OK);
    const near = plain('cli-matrix-near', {
      '.spec-brief.json': JSON.stringify({ rules: { 'shared-directory': 'note' } }),
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/a.ts]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[src/b.ts]' }),
      'briefs/003_c.md': goodBrief({ wave: '1' }),
    });
    const doc = JSON.parse((await run(near, ['matrix', '--format', 'json'])).out) as { ok: boolean; waves: { sharedDirectories: unknown[]; unscoped: string[] }[] };
    expect(doc.ok).toBe(true);
    expect(doc.waves[0]?.sharedDirectories).toEqual([{ a: '001', b: '002', directories: ['src'] }]);
    expect(doc.waves[0]?.unscoped).toEqual(['003']);
  });

  it('marks in the grid what the run reports, and nothing for a rule that is off', async () => {
    // Two briefs that write into one directory, and one with no scope. The
    // shared directory is a rule of its own, off unless the configuration
    // turns it on (ADR-0005): off, the grid marked the pair "~" all the same,
    // over a line saying so, with no finding behind either.
    const briefs = {
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/a.ts]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[src/b.ts]' }),
      'briefs/003_c.md': goodBrief({ wave: '1' }),
    };
    const drawn = async (name: string, rules: Record<string, string>): Promise<{ grid: string[]; findings: string[]; wave: unknown }> => {
      const root = plain(name, { '.spec-brief.json': JSON.stringify({ rules }), ...briefs });
      const doc = JSON.parse((await run(root, ['matrix', '--format', 'json'])).out) as { findings: { rule: string }[]; waves: unknown[] };
      return { grid: (await run(root, ['matrix', '--no-color'])).out.split('\n'), findings: doc.findings.map((f) => f.rule), wave: doc.waves[0] };
    };
    const off = await drawn('cli-matrix-rule-off', {});
    expect(off.grid).toEqual([
      'wave 1 · 3 briefs',
      '       001  002  003',
      '  001    ·    ·    ·',
      '  002    ·    ·    ·',
      '  003    ·    ·    ·',
      '  ? 003 declares no affectedFiles and cannot be checked',
      '',
    ]);
    expect(off.findings).toEqual(['unscoped']);
    const on = await drawn('cli-matrix-rule-on', { 'shared-directory': 'note' });
    expect(on.grid).toEqual([
      'wave 1 · 3 briefs',
      '       001  002  003',
      '  001    ·    ~    ·',
      '  002    ~    ·    ·',
      '  003    ·    ·    ·',
      '  ~ 001 and 002 both write into src/',
      '  ? 003 declares no affectedFiles and cannot be checked',
      '',
    ]);
    expect(on.findings).toEqual(['shared-directory', 'unscoped']);
    // Any rule of the matrix: with `unscoped` off too, the brief with no scope is not marked either.
    const quiet = await drawn('cli-matrix-rules-off', { unscoped: 'off' });
    expect(quiet.grid.slice(5)).toEqual(['']);
    expect(quiet.findings).toEqual([]);
    // The JSON document lists every pair the comparison found, beside the findings that say which of them the run reports.
    expect(off.wave).toEqual(expect.objectContaining({ sharedDirectories: [{ a: '001', b: '002', directories: ['src'] }], unscoped: ['003'] }));
  });

  it('names a file the tree holds, and says so when the file named is only an example', async () => {
    const briefs = {
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/Shop.Application/**]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["**/OrderService.cs"]' }),
    };
    const held = plain('cli-matrix-held', { ...briefs, 'src/Shop.Application/Orders/OrderService.cs': '' });
    const example = plain('cli-matrix-example', { ...briefs, 'src/Shop.Application/Orders/Order.cs': '' });
    const patterns = '001 "src/Shop.Application/**" and 002 "**/OrderService.cs" both cover';
    expect((await run(held, ['matrix', '--no-color'])).out).toContain(`X ${patterns} src/Shop.Application/Orders/OrderService.cs\n`);
    expect((await run(example, ['matrix', '--no-color'])).out).toContain(`X ${patterns} src/Shop.Application/OrderService.cs, an example not in the tree\n`);
    const overlaps = async (root: string): Promise<unknown> =>
      (JSON.parse((await run(root, ['matrix', '--format', 'json'])).out) as { waves: { collisions: { overlaps: unknown }[] }[] }).waves[0]?.collisions[0]?.overlaps;
    const pair = ['src/Shop.Application/**', '**/OrderService.cs'];
    expect(await overlaps(held)).toEqual([{ patterns: pair, witness: 'src/Shop.Application/Orders/OrderService.cs', inTree: true }]);
    expect(await overlaps(example)).toEqual([{ patterns: pair, witness: 'src/Shop.Application/OrderService.cs', inTree: false }]);
    // The file named is not the problem, the pair is: GitLab sees one collision in both trees.
    const issue = async (root: string): Promise<{ description: string; fingerprint: string }> =>
      (JSON.parse((await run(root, ['matrix', '--format', 'gitlab'])).out) as { description: string; fingerprint: string }[])[0]!;
    const [inTree, notInTree] = [await issue(held), await issue(example)];
    expect(inTree.description).not.toBe(notInTree.description);
    expect(inTree.fingerprint).toBe(notInTree.fingerprint);
  });
});

describe('schedule', () => {
  const files = {
    'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/auth/**]' }),
    'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["src/**/session.ts"]' }),
    'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[docs/**]' }),
  };

  it('shows the waves, exits 1 while they would change, and 0 once written', async () => {
    const root = plain('cli-schedule', files);
    const pretty = await run(root, ['schedule', '--no-color']);
    expect(pretty.code).toBe(EXIT_FAILED);
    expect(pretty.out.split('\n')).toEqual([
      'wave 1 · 2 briefs',
      '  001  A brief',
      '  003  A brief',
      'wave 2 · 1 brief',
      '  002  A brief  moves from wave 1',
      '         wave 1 does not hold: 001 there also writes src/auth/session.ts, an example not in the tree',
      '         not wave 1, where 001 also writes src/auth/session.ts, an example not in the tree ("src/**/session.ts" and "src/auth/**")',
      '',
      '1 brief would move; "spec-brief schedule --write" writes the waves',
      '',
    ]);
    const json = JSON.parse((await run(root, ['schedule', '--format', 'json'])).out) as Record<string, unknown>;
    expect(json).toEqual(expect.objectContaining({ command: 'schedule', ok: false, checked: 3, written: null }));
    expect(json['waves']).toEqual([
      { wave: 1, briefs: ['001', '003'] },
      { wave: 2, briefs: ['002'] },
    ]);
    expect((await run(root, ['schedule', '--format', 'github'])).out).toMatch(/^::error file=briefs\/002_b\.md,line=3,title=spec-brief wave-schedule::/);
    expect(JSON.parse((await run(root, ['schedule', '--format', 'sarif'])).out).runs[0].results).toHaveLength(1);
    expect((JSON.parse((await run(root, ['schedule', '--format', 'gitlab'])).out) as { check_name: string }[]).map((i) => i.check_name)).toEqual(['wave-schedule']);

    const write = await run(root, ['schedule', '--write', '--no-color']);
    expect(write.code).toBe(EXIT_OK);
    expect(write.out).toContain('wrote the wave of 1 brief: briefs/002_b.md\n');
    expect(readFileSync(join(root, 'briefs/002_b.md'), 'utf8')).toBe(files['briefs/002_b.md'].replace('wave: 1', 'wave: 2'));
    expect(readFileSync(join(root, 'briefs/001_a.md'), 'utf8')).toBe(files['briefs/001_a.md']);
    const again = await run(root, ['schedule', '--no-color']);
    expect(again.code).toBe(EXIT_OK);
    expect(again.out.split('\n').at(-2)).toBe('the declared waves hold');
    expect((await run(root, ['matrix'])).code).toBe(EXIT_OK);
  });

  it('passes a wave a person moved later by hand, which lint and matrix accept, and notes the move', async () => {
    const byHand = { ...files, 'briefs/002_b.md': files['briefs/002_b.md'].replace('wave: 1', 'wave: 3') };
    const root = plain('cli-schedule-by-hand', byHand);
    const pretty = await run(root, ['schedule', '--no-color']);
    expect(pretty.code).toBe(EXIT_OK);
    expect(pretty.out.split('\n').slice(3)).toEqual([
      'wave 2 · 1 brief',
      '  002  A brief  moves from wave 3',
      '         wave 3 also holds',
      '         not wave 1, where 001 also writes src/auth/session.ts, an example not in the tree ("src/**/session.ts" and "src/auth/**")',
      '',
      '1 brief could move, and the declared waves hold; "spec-brief schedule --write" writes the computed ones',
      '',
    ]);
    expect((await run(root, ['schedule', '--format', 'github'])).out.startsWith(
      '::notice file=briefs/002_b.md,line=3,title=spec-brief wave-schedule::declares wave 3, which holds; the schedule puts it in wave 2',
    )).toBe(true);
    // A note is not a warning: --strict passes it too.
    expect((await run(root, ['schedule', '--strict'])).code).toBe(EXIT_OK);
    expect((await run(root, ['lint'])).code).toBe(EXIT_OK);
    expect((await run(root, ['matrix'])).code).toBe(EXIT_OK);
    // Moved into a wave where it collides, it fails as matrix does.
    writeFileSync(join(root, 'briefs/003_c.md'), goodBrief({ wave: '3', affectedFiles: '[src/auth/session.ts]' }));
    expect((await run(root, ['schedule'])).code).toBe(EXIT_FAILED);
    expect((await run(root, ['matrix'])).code).toBe(EXIT_FAILED);
  });

  it('reports the written files as JSON, and prints the findings the view does not show', async () => {
    const root = plain('cli-schedule-json', { ...files, 'briefs/004_d.md': goodBrief({ wave: '3' }) });
    const doc = JSON.parse((await run(root, ['schedule', '--write', '--format', 'json'])).out) as { ok: boolean; written: string[]; findings: { rule: string }[] };
    expect(doc.written).toEqual(['briefs/002_b.md']);
    expect(doc.findings.map((f) => f.rule)).toEqual(['unscoped']);
    expect(doc.ok).toBe(true);
    const pretty = await run(root, ['schedule', '--no-color']);
    expect(pretty.out).toContain('briefs/004_d.md\n  1  note     declares no affectedFiles');
    expect((await run(root, ['schedule', '--strict'])).code).toBe(EXIT_OK);
  });

  it('writes nothing, and exits 1, over a cycle or a front matter it cannot edit', async () => {
    const cycle = plain('cli-schedule-cycle', {
      'briefs/001_a.md': goodBrief({ affectedFiles: '[a]', dependsOn: '[2]' }),
      'briefs/002_b.md': goodBrief({ affectedFiles: '[b]', dependsOn: '[1]' }),
      'briefs/003_c.md': goodBrief({ affectedFiles: '[c]' }),
    });
    const refused = await run(cycle, ['schedule', '--write', '--no-color']);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.out).toContain('cycle: 001 -> 002 -> 001\n');
    expect(refused.out).toContain('nothing was written: the dependencies form a cycle\n');
    // The view shows the cycle; it is not printed again beneath it as a finding.
    expect(refused.out).not.toContain('dependency-cycle');
    expect(readFileSync(join(cycle, 'briefs/003_c.md'), 'utf8')).toBe(goodBrief({ affectedFiles: '[c]' }));
    const open = plain('cli-schedule-open', { 'briefs/001_a.md': '---\nstatus: active\n' });
    const edit = await run(open, ['schedule', '--write', '--no-color']);
    expect(edit.code).toBe(EXIT_FAILED);
    expect(edit.out).toContain('nothing was written: a front matter cannot be edited\n');
    expect(edit.out).toContain('the front matter is never closed, so wave 1 cannot be written into it  front-matter');
    expect(readFileSync(join(open, 'briefs/001_a.md'), 'utf8')).toBe('---\nstatus: active\n');
    expect((await run(plain('cli-schedule-missing', {}), ['schedule'])).code).toBe(EXIT_ERROR);
  });

  it('still says which waves do not hold when it could write none of them', async () => {
    // Written, the waves hold and the findings that said they did not are
    // answered. Refused, nothing was written, and they stand.
    const root = plain('cli-schedule-refused', { ...files, 'briefs/004_d.md': '---\nstatus: active\n' });
    const doc = JSON.parse((await run(root, ['schedule', '--write', '--format', 'json'])).out) as { ok: boolean; written: string[]; findings: { rule: string; file: string }[] };
    expect(doc.ok).toBe(false);
    expect(doc.written).toEqual([]);
    expect(doc.findings.map((f) => [f.rule, f.file])).toEqual([
      ['wave-schedule', 'briefs/002_b.md'],
      ['front-matter', 'briefs/004_d.md'],
      ['unscoped', 'briefs/004_d.md'],
      ['wave-schedule', 'briefs/004_d.md'],
    ]);
    expect(readFileSync(join(root, 'briefs/002_b.md'), 'utf8')).toBe(files['briefs/002_b.md']);
  });
});

describe('archive and unarchive', () => {
  it('dry-runs, archives, is idempotent, and reopens', async () => {
    const root = repo('cli-archive', { 'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**]' }), 'src/a.ts': 'x\n' });
    const dry = await run(root, ['archive', '1', '--dry-run', '--summary', 'Done.', '--no-color']);
    expect(dry.code).toBe(EXIT_OK);
    expect(dry.out).toContain('would move briefs/001_a.md -> briefs/archive/001_a.md');
    expect(dry.out).toContain('> Done.');
    // No commit or base was named, so the scope went unmeasured, and the plan says so.
    expect(dry.out).toContain('affectedFiles went unchecked: no commit or base was named, so the files the round changed were not read  scope-unmeasured\n');
    // Dated today, as the environment says it, or the day it is told.
    expect(dry.out).toContain('> **Archived 2026-09-24.**');
    expect((await run(root, ['archive', '1', '--dry-run', '--date', '2026-02-03', '--no-color'])).out).toContain('> **Archived 2026-02-03.**');
    expect(existsSync(join(root, 'briefs', '001_a.md'))).toBe(true);

    const done = await run(root, ['archive', '001', '--commit', 'HEAD', '--pr', '12', '--no-color']);
    expect(done.code).toBe(EXIT_OK);
    expect(done.out).toContain('moved briefs/001_a.md -> briefs/archive/001_a.md');
    expect(done.out).toContain('nothing was committed');
    expect(existsSync(join(root, 'briefs', 'archive', '001_a.md'))).toBe(true);

    expect((await run(root, ['archive', '1'])).out).toBe('briefs/archive/001_a.md is already archived; nothing to do\n');
    const reopenDry = await run(root, ['unarchive', '1', '--dry-run', '--no-color']);
    expect(reopenDry.code).toBe(EXIT_OK);
    expect(reopenDry.out).toContain('would move briefs/archive/001_a.md -> briefs/001_a.md');
    expect(existsSync(join(root, 'briefs', 'archive', '001_a.md'))).toBe(true);
    const json = JSON.parse((await run(root, ['unarchive', '1', '--format', 'json'])).out) as { ok: boolean; plan: { to: string } };
    expect(json).toEqual(expect.objectContaining({ command: 'unarchive', ok: true, plan: expect.objectContaining({ to: 'briefs/001_a.md' }) }));
    expect((await run(root, ['unarchive', '1'])).out).toBe('briefs/001_a.md is already live; nothing to do\n');
    expect((await run(root, ['unarchive'])).err).toBe('spec-brief: unarchive takes one brief: spec-brief unarchive <brief>\n');
  });

  it('reports what git was not handed, or could not do, by its message alone', async () => {
    // Each ended on `unexpected error:` and a stack, as a defect would.
    const root = repo('cli-archive-git', { 'briefs/001_a.md': goodBrief() });
    // A revision that would be read as an option is never handed to git.
    expect(await run(root, ['archive', '1', '--commit=-x', '--dry-run'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: "-x" is not a revision\n' });
    expect(await run(root, ['archive', '1', '--base', ' ', '--dry-run'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: " " is not a revision\n' });
    // An index git cannot read: its status fails, and what git said is the report.
    writeFileSync(join(root, '.git', 'index'), 'no index');
    const unread = await run(root, ['archive', '1', '--dry-run']);
    expect(unread.code).toBe(EXIT_ERROR);
    expect(unread.out).toBe('');
    expect(unread.err).toMatch(/^spec-brief: git status failed: fatal: [^]*\S\n$/);
    expect(unread.err).not.toMatch(/\n {4}at /);
  });

  it('refuses with the reasons and exits 1, and exits 2 on bad arguments', async () => {
    const root = repo('cli-archive-refused', {
      'briefs/001_a.md': goodBrief({ protectedFiles: '[src/locked.ts]', affectedFiles: '[src/ok.ts]' }, '\n- [ ] still open\n'),
      'src/locked.ts': 'x\n',
    });
    writeTree(root, { 'src/locked.ts': 'y\n', 'src/other.ts': 'z\n' });
    commitAll(root, 'work');
    const refused = await run(root, ['archive', '1', '--commit', 'HEAD', '--no-color']);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.out).toContain('cannot archive briefs/001_a.md:');
    expect(refused.out).toContain('open-task');
    expect(refused.out).toContain('protected-file');
    expect(refused.out).toContain('out-of-scope');
    expect((await run(root, ['archive'])).err).toBe('spec-brief: archive takes one brief: spec-brief archive <brief>\n');
    expect((await run(root, ['archive', '1', '2'])).code).toBe(EXIT_ERROR);
    expect((await run(root, ['archive', '1', '--pr', '0'])).err).toBe('spec-brief: --pr must be a whole number of at least 1, not "0"\n');
    expect((await run(root, ['archive', '1', '--no-git', '--base', 'main'])).code).toBe(EXIT_ERROR);
  });

  it('shows warnings beside a refusal and a banner only on a dry run', async () => {
    const root = repo('cli-archive-warn', { 'briefs/001_a.md': goodBrief({ affectedFiles: '[src/ok.ts]' }), 'src/x.ts': '1' });
    writeTree(root, { 'src/x.ts': '2' });
    commitAll(root, 'work');
    const out = (await run(root, ['archive', '1', '--commit', 'HEAD', '--no-color', '--allow-dirty'])).out;
    expect(out).toContain('out-of-scope');
    expect(out).toContain('the round changed 1 file');
    expect(out).not.toContain('banner:');
    writeTree(root, { 'briefs/002_b.md': goodBrief({ affectedFiles: '[src/ok.ts]', status: 'draft' }) });
    commitAll(root, 'second');
    writeTree(root, { 'src/x.ts': '3' });
    commitAll(root, 'more work');
    const both = (await run(root, ['archive', '2', '--commit', 'HEAD', '--no-color'])).out;
    expect(both).toContain('archive-draft');
    expect(both).toContain('out-of-scope');
  });

  it('refuses under --strict to reopen a brief whose links it would leave behind', async () => {
    const root = plain('cli-unarchive-strict', {
      '.spec-brief.json': JSON.stringify({ archiving: { rewriteLinks: false } }),
      'briefs/archive/001_a.md': goodBrief({ status: 'archived' }),
      'briefs/002_b.md': goodBrief({}, '\n[a](archive/001_a.md)\n'),
    });
    const strict = await run(root, ['unarchive', '1', '--strict', '--no-color']);
    expect(strict.code).toBe(EXIT_FAILED);
    expect(strict.out).toContain('stale-link');
    expect(existsSync(join(root, 'briefs', 'archive', '001_a.md'))).toBe(true);
    const lenient = await run(root, ['unarchive', '1', '--no-color']);
    expect(lenient.code).toBe(EXIT_OK);
    expect(lenient.out).toContain('briefs/002_b.md:19');
    expect(readFileSync(join(root, 'briefs', '002_b.md'), 'utf8')).toContain('[a](archive/001_a.md)');
  });

  it('reports a conflict and an unexpected failure with exit 2', async () => {
    const root = repo('cli-archive-conflict', { 'briefs/001_a.md': goodBrief() });
    writeTree(root, { 'briefs/archive/001_a.md/blocker': '' });
    const result = await run(root, ['archive', '1', '--allow-dirty']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(/^spec-brief: /);
  });

  it('stops with exit 2 when a plugin asked to waive a refusal fails, and reports the waivers it makes as JSON', async () => {
    const plugin = (body: string): string => `export default { name: 'rulings', rules: [], waive: async ({ findings }) => { ${body} } };\n`;
    const root = repo('cli-archive-waive', {
      '.spec-brief.json': JSON.stringify({ plugins: ['./rulings.mjs'] }),
      'rulings.mjs': plugin("throw new Error('the allowed signers file is missing');"),
      'briefs/001_a.md': goodBrief({ protectedFiles: '[src/a.ts]' }),
      'src/a.ts': 'a\n',
    });
    writeTree(root, { 'src/a.ts': 'a2\n' });
    commitAll(root, 'the round');
    const failed = await run(root, ['archive', '1', '--commit', 'HEAD', '--dry-run']);
    expect(failed).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: plugin "rulings": "waive" failed: the allowed signers file is missing\n' });
    // A module is loaded once per process, so the answering plugin is a second file.
    writeTree(root, {
      '.spec-brief.json': JSON.stringify({ plugins: ['./answers.mjs'] }),
      'answers.mjs': plugin("return findings.map((f) => ({ rule: f.rule, path: f.path, reason: 'ruled' }));"),
    });
    const json = await run(root, ['archive', '1', '--commit', 'HEAD', '--dry-run', '--allow-dirty', '--format', 'json']);
    expect(json.code).toBe(EXIT_OK);
    const plan = (JSON.parse(json.out) as { plan: { warnings: unknown[] } }).plan;
    expect(plan.warnings).toEqual([
      {
        rule: 'waived',
        severity: 'note',
        file: 'briefs/001_a.md',
        line: 3,
        message: 'rulings waives protected-file for src/a.ts: ruled',
        brief: '001',
        hint: 'review the waiver with the round; it stands where the refusal was',
        path: 'src/a.ts',
      },
    ]);
  });
});
