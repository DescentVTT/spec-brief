import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('a SOURCE_DATE_EPOCH that cannot be read as a date', () => {
  // A pipeline sets it to have the date it names written, and a value that is
  // no such date was read as unset: the clock's date, exit 0, and no word.
  const notSeconds = (shown: string): string =>
    `spec-brief: SOURCE_DATE_EPOCH is ${shown}, which is not a whole number of seconds since 1970-01-01; set it to one in digits alone, as "date +%s" prints it, or unset it\n`;
  const tooLate = (shown: string): string =>
    `spec-brief: SOURCE_DATE_EPOCH is ${shown}, which is after 9999-12-31, the last date written YYYY-MM-DD; set it to 253402300799 or less, or unset it\n`;
  const files = { 'briefs/001_a.md': goodBrief(), 'briefs/002_b.md': goodBrief() };

  it.each([
    ['a word', 'tomorrow', notSeconds('"tomorrow"')],
    // What `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` leaves where git failed.
    ['nothing at all', '', notSeconds('""')],
    ['a fraction', '1.5', notSeconds('"1.5"')],
    ['a time before 1970', '-1', notSeconds('"-1"')],
    ['a space before its digits', ' 1790208000', notSeconds('" 1790208000"')],
    ['the newline a command printed after them', '1790208000\n', notSeconds('"1790208000\\n"')],
    // The date check refused these as "+010000-01", with no word of the variable.
    ['the first second of the year 10000', '253402300800', tooLate('"253402300800"')],
    // The date's own complaint was a RangeError, and before 0.6.1 a stack.
    ['more seconds than any date has', '99999999999999999', tooLate('"99999999999999999"')],
  ])('ends new and archive with exit 2 and one line that names it, when it holds %s', async (_kind, epoch, err) => {
    const root = plain('cli-epoch', files);
    for (const argv of [
      ['new', 'Third'],
      ['archive', '1'],
      ['archive', '1', '--dry-run'],
      ['archive', '1', '--format', 'json'],
    ]) {
      expect(await run(root, argv, { SOURCE_DATE_EPOCH: epoch }), argv.join(' ')).toEqual({ code: EXIT_ERROR, out: '', err });
    }
    // Nothing was written: no third brief, and the first is where it was.
    expect(readdirSync(join(root, 'briefs'))).toEqual(['001_a.md', '002_b.md']);
  });

  it.each([['tomorrow'], [''], ['253402300800'], ['99999999999999999']])('stops no command that writes no date, and none that was told the date, when it holds "%s"', async (epoch) => {
    // The answer of each is the one it gives under a variable that can be
    // read: a run is not stopped over a value it has no use for.
    const unread = { SOURCE_DATE_EPOCH: epoch };
    const [here, twin] = [plain('cli-epoch-unread', files), plain('cli-epoch-read', files)];
    for (const argv of [
      ['--version'],
      ['--help'],
      ['lint'],
      ['list'],
      ['matrix'],
      ['schedule'],
      ['new', 'Third', '--date', '2026-01-02'],
      ['archive', '2', '--date', '2026-01-03'],
      ['list', '--archived', '--format', 'json'],
      ['unarchive', '2'],
    ]) {
      const result = await run(here, argv, unread);
      expect(result, argv.join(' ')).toEqual(await run(twin, argv));
      expect(result.err, argv.join(' ')).toBe('');
    }
    // The dates written are the ones the flags gave.
    expect(readFileSync(join(here, 'briefs', '003_third.md'), 'utf8')).toContain('\ndate: 2026-01-02\n');
    expect((await run(here, ['archive', '2', '--date', '2026-01-03', '--dry-run'], unread)).out).toContain('> **Archived 2026-01-03.**');
    expect(await run(dir('cli-epoch-init'), ['init'], unread)).toEqual({
      code: EXIT_OK,
      out: 'wrote .spec-brief.json\nwrote briefs/.gitkeep\nwrote briefs/archive/.gitkeep\nnext: spec-brief new "<title>"\n',
      err: '',
    });
  });

  it('writes the date of the last second it may hold, and of the first', async () => {
    const root = plain('cli-epoch-ends', files);
    expect(await run(root, ['new', 'Last'], { SOURCE_DATE_EPOCH: '253402300799' })).toEqual({ code: EXIT_OK, out: 'wrote briefs/003_last.md\n', err: '' });
    expect(readFileSync(join(root, 'briefs', '003_last.md'), 'utf8')).toContain('\ndate: 9999-12-31\n');
    expect((await run(root, ['archive', '1', '--dry-run'], { SOURCE_DATE_EPOCH: '0' })).out).toContain('> **Archived 1970-01-01.**');
  });

  it('says in the help where the date comes from when --date does not give it', () => {
    expect(HELP).toContain("  --date <YYYY-MM-DD>   the date in its front matter; default SOURCE_DATE_EPOCH's, or today's in UTC\n");
    expect(HELP).toContain("  --date <YYYY-MM-DD>   the archival date; default SOURCE_DATE_EPOCH's, or today's in UTC\n");
  });
});

describe('an input that names nothing', () => {
  // `--root "$DIR"` where the variable is not set, a list of only commas, an
  // argument no command asked for: each was read as if it were not there, and
  // the run answered a question nobody had put, exit 0.
  const noValue = (option: string, shown: string): string => `--${option} is ${shown}, which is no value; give it one, or leave the option out`;
  const VALUED: [string, string[], string][] = [
    ['list', [], 'root'],
    ['list', [], 'config'],
    ['list', [], 'format'],
    ['init', [], 'briefs'],
    ['init', [], 'archive'],
    ['new', ['T'], 'id'],
    ['new', ['T'], 'type'],
    ['new', ['T'], 'wave'],
    ['new', ['T'], 'depends-on'],
    ['new', ['T'], 'date'],
    ['archive', ['1'], 'pr'],
    ['archive', ['1'], 'commit'],
    ['archive', ['1'], 'base'],
    ['archive', ['1'], 'summary'],
    ['archive', ['1'], 'date'],
  ];

  it.each(VALUED)('refuses %s %j --%s given nothing, or only space, by the name of the option', (command, args, option) => {
    for (const [value, shown] of [
      ['', '""'],
      [' ', '" "'],
      // Shown with its escapes, so that what cannot be seen is.
      ['\t \n', '"\\t \\n"'],
    ] as const) {
      expect(() => parse([command, ...args, `--${option}`, value]), shown).toThrow(new UsageError(noValue(option, shown)));
    }
    // Written with "=", the option holds the same nothing.
    expect(() => parse([command, ...args, `--${option}=`])).toThrow(new UsageError(noValue(option, '""')));
  });

  it('holds every option the help gives a value to that rule', () => {
    const valued = new Set([...HELP.matchAll(/^ {2}--([a-z-]+) </gm)].map((m) => m[1] as string));
    expect([...new Set(VALUED.map(([, , option]) => option))].sort()).toEqual([...valued].sort());
  });

  it('takes a value that holds something, space in it or around it, and every flag', () => {
    expect(parse(['archive', '1', '--summary', ' Done. ']).values['summary']).toBe(' Done. ');
    expect(parse(['new', 'T', '--wave', '0']).values['wave']).toBe('0');
    expect(parse(['new', 'T', '--depends-on', '7, 8']).values['depends-on']).toBe('7, 8');
    expect(parse(['list', '--ready', '--archived', '--no-git', '--color']).values).toMatchObject({ ready: true, archived: true, 'no-git': true, color: true });
    expect(parse(['lint', '--strict']).values).toMatchObject({ strict: true });
  });

  it.each([
    ['list', ['nonsense'], 'list takes no argument, not "nonsense": spec-brief list'],
    ['matrix', ['12', 'extra'], 'matrix takes no argument, not "12", "extra": spec-brief matrix'],
    ['schedule', ['later'], 'schedule takes no argument, not "later": spec-brief schedule'],
    // Where the directory a person most likely meant is named.
    ['init', ['mydir'], 'init takes no argument, not "mydir": spec-brief init; --root <dir> names the directory it sets up, and --briefs <dir> the one for the briefs'],
  ])('refuses an argument %s does not take, naming it and the usage', (command, extra, message) => {
    expect(() => parse([command, ...extra])).toThrow(new UsageError(message));
    // Wherever it stands among the options, and after "--" too.
    expect(() => parse(['--strict', command, '--no-git', ...extra])).toThrow(new UsageError(message));
    expect(() => parse(['--', command, ...extra])).toThrow(new UsageError(message));
  });

  it('takes the arguments a command does take, and none where none is given', () => {
    expect(parse(['lint', '1', '2']).positionals).toEqual(['1', '2']);
    expect(parse(['new', 'Two', 'words']).positionals).toEqual(['Two', 'words']);
    expect(parse(['archive', '1']).positionals).toEqual(['1']);
    expect(parse(['unarchive', '1']).positionals).toEqual(['1']);
    for (const command of ['init', 'list', 'matrix', 'schedule']) expect(parse([command, '--no-git']).positionals, command).toEqual([]);
    // No command, which is the help's to answer.
    expect(parse(['--version']).positionals).toEqual([]);
  });

  it('writes nothing for a line it refuses', async () => {
    const root = plain('cli-nothing', { 'briefs/001_a.md': goodBrief() });
    // It wrote briefs/_t.md, a file no command reads again.
    expect(await run(root, ['new', 'T', '--id', ''])).toEqual({ code: EXIT_ERROR, out: '', err: `spec-brief: ${noValue('id', '""')}\n` });
    expect(await run(root, ['new', 'T', '--root', ' '])).toEqual({ code: EXIT_ERROR, out: '', err: `spec-brief: ${noValue('root', '" "')}\n` });
    expect(await run(root, ['archive', '1', '--summary', ' '])).toEqual({ code: EXIT_ERROR, out: '', err: `spec-brief: ${noValue('summary', '" "')}\n` });
    expect(await run(root, ['list', 'nonsense'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: list takes no argument, not "nonsense": spec-brief list\n' });
    expect(await run(root, ['schedule', 'later', '--write'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: schedule takes no argument, not "later": spec-brief schedule\n' });
    expect(readdirSync(join(root, 'briefs'))).toEqual(['001_a.md']);
    expect(readFileSync(join(root, 'briefs', '001_a.md'), 'utf8')).toBe(goodBrief());
    // It set up the directory it was started in, and said nothing of "mydir".
    const empty = dir('cli-nothing-init');
    expect(await run(empty, ['init', 'mydir'])).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: 'spec-brief: init takes no argument, not "mydir": spec-brief init; --root <dir> names the directory it sets up, and --briefs <dir> the one for the briefs\n',
    });
    expect(readdirSync(empty)).toEqual([]);
    // What the refusal names does it.
    expect((await run(empty, ['init', '--root', join(empty, 'mydir')])).code).toBe(EXIT_OK);
    expect(readdirSync(empty)).toEqual(['mydir']);
    expect(existsSync(join(empty, 'mydir', '.spec-brief.json'))).toBe(true);
  });

  it('refuses a list of dependencies that names none, and takes one that names some', async () => {
    const root = plain('cli-depends', { 'briefs/001_a.md': goodBrief() });
    const names = (shown: string): Result => ({
      code: EXIT_ERROR,
      out: '',
      err: `spec-brief: --depends-on is ${shown}, which names no brief; give it ids with commas between them, as in 7,8, or leave the option out\n`,
    });
    // Each scaffolded a brief that depends on nothing.
    expect(await run(root, ['new', 'T', '--depends-on', ','])).toEqual(names('","'));
    expect(await run(root, ['new', 'T', '--depends-on', ' ,\t, '])).toEqual(names('" ,\\t, "'));
    expect(readdirSync(join(root, 'briefs'))).toEqual(['001_a.md']);
    // A place that names no brief is one left out, as "$A,$B" is with one of the two unset: each scaffolded a brief that depends on the rest.
    const place = (shown: string): Result => ({
      code: EXIT_ERROR,
      out: '',
      err: `spec-brief: --depends-on is ${shown}, which names no brief in one of its places; give it ids with one comma between each two, as in 7,8, and none before or after\n`,
    });
    expect(await run(root, ['new', 'T', '--depends-on', '1,'])).toEqual(place('"1,"'));
    expect(await run(root, ['new', 'T', '--depends-on', ',1'])).toEqual(place('",1"'));
    expect(await run(root, ['new', 'T', '--depends-on', '1, ,1'])).toEqual(place('"1, ,1"'));
    expect(readdirSync(join(root, 'briefs'))).toEqual(['001_a.md']);
    // Spaces beside an id are not a place of their own.
    expect(await run(root, ['new', 'T', '--depends-on', ' 1 , 1 '])).toEqual({ code: EXIT_OK, out: 'wrote briefs/002_t.md\n', err: '' });
    expect(readFileSync(join(root, 'briefs', '002_t.md'), 'utf8')).toContain('\ndependsOn: ["1", "1"]\n');
    // And without the option a brief depends on nothing, which is not said in its front matter.
    expect(await run(root, ['new', 'U'])).toEqual({ code: EXIT_OK, out: 'wrote briefs/003_u.md\n', err: '' });
    expect(readFileSync(join(root, 'briefs', '003_u.md'), 'utf8')).not.toContain('dependsOn');
  });

  it('refuses a --root that is no directory, and has init make one that is not there', async () => {
    // The search for a configuration went on from the parent: each of these
    // listed, linted or wrote into the tree above the path it was given.
    const root = plain('cli-root', { 'briefs/001_a.md': goodBrief(), 'notes.txt': 'a file', 'sub/keep.txt': '' });
    const refused = (given: string): Result => ({ code: EXIT_ERROR, out: '', err: `spec-brief: --root is "${given}", which is no directory; give it one, or leave the option out\n` });
    const file = join(root, 'notes.txt');
    const missing = join(root, 'nowhere');
    for (const command of [['list'], ['lint'], ['new', 'T'], ['init']]) {
      expect(await run(root, [...command, '--root', file]), command.join(' ')).toEqual(refused(file));
    }
    for (const command of [['list'], ['lint'], ['new', 'T'], ['archive', '1', '--dry-run']]) {
      expect(await run(root, [...command, '--root', missing]), command.join(' ')).toEqual(refused(missing));
    }
    expect(readdirSync(join(root, 'briefs'))).toEqual(['001_a.md']);
    expect(existsSync(missing)).toBe(false);
    // A directory below the configuration's is a place to start from, as it was.
    expect(await run(root, ['list', '--root', join(root, 'sub')])).toEqual(await run(root, ['list']));
    expect((await run(root, ['list', '--root', join(root, 'sub')])).code).toBe(EXIT_OK);
    // init is the command that makes a directory, so it is given one that is not there.
    expect((await run(root, ['init', '--root', missing])).code).toBe(EXIT_OK);
    expect(existsSync(join(missing, '.spec-brief.json'))).toBe(true);
    // --version and --help answer whatever the root is: they open none.
    expect((await run(root, ['--version', '--root', file])).code).toBe(EXIT_OK);
    expect((await run(root, ['list', '--help', '--root', file])).out).toBe(HELP);
  });

  it('says in one line that a configuration is a directory, named or found', async () => {
    // Each ended on `unexpected error: Error: EISDIR` and a stack.
    const root = plain('cli-config-directory', { 'briefs/001_a.md': goodBrief(), 'adir/keep.txt': '' });
    expect(await run(root, ['list', '--config', 'adir'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: adir: is a directory, not a configuration file\n' });
    const found = dir('cli-config-found');
    mkdirSync(join(found, '.spec-brief.json'));
    expect(await run(found, ['list'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: .spec-brief.json: is a directory, not a configuration file\n' });
    // A read that fails for a reason nothing names is still reported whole: a name no file can have.
    const unnamed = await run(root, ['list', '--config', `a${String.fromCharCode(0)}b`]);
    expect(unnamed.code).toBe(EXIT_ERROR);
    expect(unnamed.err).toMatch(/^spec-brief: unexpected error: [^]*\n {4}at /);
  });

  it('says in one line that a configuration is not JSON, be it text or not', async () => {
    // A text file's first line break was quoted into the refusal, which made it two lines.
    const root = plain('cli-config-text', { 'briefs/001_a.md': goodBrief(), 'notes.txt': 'a file\nof two lines\n' });
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x1b, 0x5b]));
    for (const name of ['notes.txt', 'binary.bin']) {
      const result = await run(root, ['list', '--config', name]);
      expect({ code: result.code, out: result.out }, name).toEqual({ code: EXIT_ERROR, out: '' });
      expect(result.err, name).toMatch(/^spec-brief: [a-z]+\.[a-z]+: is not valid JSON \([^\u0000-\u001f\u007f-\u009f]+\)\n$/);
    }
  });

  it('says in the help what is refused, and which command makes its root', () => {
    expect(HELP).toContain('  --root <dir>          run from this directory instead of the current one; it must exist, unless init makes it\n');
    expect(HELP).toContain('An option given an empty value, a list that names nothing and an argument a\ncommand does not take are refused, not read as if they were not there.');
  });
});

describe('an option that would tell someone what is not so', () => {
  // `init --strict`, `init --config team.json`, `new T --color`, `list --strict`:
  // each ran as the line without the option does and exited 0, which told
  // someone the briefs were set up strictly, or the configuration written
  // where it was not. An option that asks a command to leave out what it
  // never does, `init --no-git`, asks for what is already so, and is taken.
  const OFFERED = ['root', 'config', 'no-config', 'format', 'strict', 'no-git', 'color', 'no-color'] as const;

  /** The table in the README: what each command refuses, and in its refusal what it reads and what it takes besides. */
  const COMMANDS: Record<string, { line: string[]; refuses: readonly string[]; reads: string }> = {
    init: { line: ['init'], refuses: ['config', 'strict', 'color'], reads: '--root, --format, --briefs and --archive, and takes --no-config, --no-git and --no-color' },
    new: {
      line: ['new', 'T'],
      refuses: ['strict', 'color'],
      reads: '--root, --config, --no-config, --format, --no-git, --id, --type, --wave, --depends-on and --date, and takes --no-color',
    },
    list: { line: ['list'], refuses: ['strict'], reads: '--root, --config, --no-config, --format, --no-git, --color, --no-color, --ready and --archived' },
    lint: { line: ['lint'], refuses: [], reads: '' },
    matrix: { line: ['matrix'], refuses: [], reads: '' },
    schedule: { line: ['schedule'], refuses: [], reads: '' },
    archive: { line: ['archive', '1', '--dry-run'], refuses: [], reads: '' },
    unarchive: { line: ['unarchive', '2', '--dry-run'], refuses: [], reads: '' },
  };

  /** A tree every command runs clean in: a live brief in its wave, an archived one, a second configuration. */
  async function tree(name: string): Promise<string> {
    const root = plain(name, { 'team.json': '{}', 'briefs/001_a.md': goodBrief({ wave: '1' }), 'briefs/002_b.md': goodBrief({ wave: '1' }) });
    expect((await run(root, ['archive', '2'])).code).toBe(EXIT_OK);
    return root;
  }

  const given = (option: string, root: string): string[] => {
    if (option === 'root') return ['--root', root];
    if (option === 'config') return ['--config', 'team.json'];
    if (option === 'format') return ['--format', 'json'];
    return [`--${option}`];
  };

  it('holds the help to the commands and the options of this table', () => {
    const commands = [...(HELP.split('\nOptions for every command')[0] as string).matchAll(/^ {2}([a-z]+) /gm)].map((m) => m[1] as string);
    expect(commands.sort()).toEqual(Object.keys(COMMANDS).sort());
    const offered = (HELP.split('\nOptions for every command')[1] as string).split('\n\n')[0] as string;
    expect([...offered.matchAll(/--([a-z-]+)/g)].map((m) => m[1] as string).filter((name, i, all) => all.indexOf(name) === i)).toEqual([...OFFERED, 'help', 'version']);
  });

  it.each(Object.keys(COMMANDS))('%s refuses each option that would say of it what is not so, by both names, and runs with every other', async (command) => {
    const { line, refuses, reads } = COMMANDS[command] as { line: string[]; refuses: readonly string[]; reads: string };
    const root = command === 'init' ? '' : await tree(`cli-unread-${command}`);
    for (const option of OFFERED) {
      // init sets up a directory of its own each time: a second init of one is refused for another reason.
      const cwd = command === 'init' ? dir(`cli-unread-init-${option}`) : root;
      const args = given(option, command === 'init' ? join(cwd, 'made') : cwd);
      const result = await run(cwd, [...line, ...args]);
      if (refuses.includes(option)) {
        const refusal = { code: EXIT_ERROR, out: '', err: `spec-brief: ${command} does not read --${option}; it reads ${reads}\n` };
        expect(result, `${command} --${option}`).toEqual(refusal);
        // Wherever the option stands, and nothing is written for it.
        expect(await run(cwd, [...args, ...line]), `--${option} ${command}`).toEqual(refusal);
        if (command === 'init') expect(readdirSync(cwd), option).toEqual([]);
      } else {
        expect({ code: result.code, err: result.err }, `${command} --${option}`).toEqual({ code: EXIT_OK, err: '' });
      }
    }
    if (command === 'new') expect(readdirSync(join(root, 'briefs')).sort()).toEqual(['001_a.md', '003_t.md', '004_t.md', '005_t.md', '006_t.md', '007_t.md', '008_t.md', 'archive']);
  });

  it('names the first such option as the line was typed, and an option of the command before a format it does not write', async () => {
    const empty = dir('cli-unread-order');
    const reads = '--root, --format, --briefs and --archive, and takes --no-config, --no-git and --no-color';
    expect((await run(empty, ['init', '--color', '--strict'])).err).toBe(`spec-brief: init does not read --color; it reads ${reads}\n`);
    expect((await run(empty, ['init', '--strict', '--color'])).err).toBe(`spec-brief: init does not read --strict; it reads ${reads}\n`);
    expect((await run(empty, ['--strict', 'init', '--briefs', 'specs', '--color'])).err).toBe(`spec-brief: init does not read --strict; it reads ${reads}\n`);
    expect((await run(empty, ['init', '--format', 'sarif', '--strict'])).err).toBe(`spec-brief: init does not read --strict; it reads ${reads}\n`);
    // An option that is taken is passed over for the one that is not, wherever it stands.
    expect((await run(empty, ['init', '--no-config', '--no-color', '--config', 'team.json'])).err).toBe(`spec-brief: init does not read --config; it reads ${reads}\n`);
    // An argument init does not take is said first, as it was: the line is read before the command is asked.
    expect((await run(empty, ['init', 'mydir', '--strict'])).err).toMatch(/^spec-brief: init takes no argument, not "mydir"/);
    expect(readdirSync(empty)).toEqual([]);
  });

  it('takes an option that asks a command to leave out what it never does, and runs as without it', async () => {
    // init opens no configuration file, asks git nothing and prints no colour;
    // new prints none. A script that runs every command in a tree without
    // git passes --no-git to each, as this suite does.
    const wrote = { code: EXIT_OK, out: 'wrote .spec-brief.json\nwrote briefs/.gitkeep\nwrote briefs/archive/.gitkeep\nnext: spec-brief new "<title>"\n', err: '' };
    const files = (root: string): string[] => (readdirSync(root, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/')).filter((path) => !path.startsWith('.git/') && path !== '.git').sort();
    // The line with none of them, in a repository, where the suite hands it no --no-git.
    const bare = dir('cli-already-so-bare');
    initRepo(bare);
    expect(await run(bare, ['init'])).toEqual(wrote);
    const configuration = readFileSync(join(bare, '.spec-brief.json'), 'utf8');
    for (const options of [['--no-git'], ['--no-config'], ['--no-color'], ['--no-config', '--no-git', '--no-color']]) {
      const root = dir(`cli-already-so${options.join('')}`);
      // Wherever they stand; the directory is given a .git of its own so that the line is as written here.
      mkdirSync(join(root, '.git'));
      expect(await run(root, [...options.slice(1), 'init', ...options.slice(0, 1)]), options.join(' ')).toEqual(wrote);
      expect(files(root), options.join(' ')).toEqual(files(bare));
      expect(readFileSync(join(root, '.spec-brief.json'), 'utf8'), options.join(' ')).toBe(configuration);
    }
    // --no-config has init open no configuration, which it never does; it still writes over none.
    expect(await run(bare, ['init', '--no-config'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: .spec-brief.json already exists here; edit it instead\n' });
    expect(readFileSync(join(bare, '.spec-brief.json'), 'utf8')).toBe(configuration);
    // new prints no colour, and takes --no-color; the others it reads.
    expect(await run(bare, ['new', 'T', '--no-color'])).toEqual({ code: EXIT_OK, out: 'wrote briefs/001_t.md\n', err: '' });
  });

  it('refuses --config beside --no-config, and --color beside --no-color, of which one went unread', async () => {
    // The defaults ran and the file was never opened; colour was off, whatever --color asked.
    const root = plain('cli-unread-pairs', { 'team.json': JSON.stringify({ briefs: 'specs' }), 'specs/001_a.md': goodBrief(), 'briefs/001_b.md': goodBrief({ type: 'epic' }) });
    const config = { code: EXIT_ERROR, out: '', err: 'spec-brief: --config is given beside --no-config, which has the run read no configuration file; give one of the two\n' };
    for (const line of [['lint'], ['list'], ['matrix'], ['schedule'], ['new', 'T'], ['archive', '1', '--dry-run'], ['unarchive', '1', '--dry-run']]) {
      expect(await run(root, [...line, '--config', 'team.json', '--no-config']), line.join(' ')).toEqual(config);
      expect(await run(root, ['--no-config', ...line, '--config', 'team.json']), line.join(' ')).toEqual(config);
    }
    // A file that is not there is not looked for either: the pair is refused before any is opened.
    expect(await run(root, ['lint', '--config', 'nowhere.json', '--no-config'])).toEqual(config);
    expect(readdirSync(join(root, 'specs'))).toEqual(['001_a.md']);
    expect(readdirSync(join(root, 'briefs'))).toEqual(['001_b.md']);
    // Each of the two alone is read, as it was.
    expect(await run(root, ['lint', '--config', 'team.json'])).toEqual({ code: EXIT_OK, out: '1 brief(s) checked, no findings\n', err: '' });
    expect((await run(root, ['lint', '--no-config'])).code).toBe(EXIT_FAILED);

    const colour = { code: EXIT_ERROR, out: '', err: 'spec-brief: --color is given beside --no-color, which turns colour off; give one of the two\n' };
    for (const line of [['lint'], ['list'], ['matrix'], ['schedule'], ['archive', '1', '--dry-run'], ['unarchive', '1', '--dry-run']]) {
      expect(await run(root, [...line, '--color', '--no-color']), line.join(' ')).toEqual(colour);
      expect(await run(root, ['--no-color', ...line, '--color']), line.join(' ')).toEqual(colour);
    }
    const esc = String.fromCharCode(27);
    expect((await run(root, ['lint', '--color'])).out).toContain(esc);
    expect((await run(root, ['lint', '--no-color'], { FORCE_COLOR: '1' })).out).not.toContain(esc);
    // Where a command refuses one of a pair for itself, that is what it says.
    expect((await run(dir('cli-unread-pairs-init'), ['init', '--no-config', '--config', 'team.json'])).err).toBe(
      'spec-brief: init does not read --config; it reads --root, --format, --briefs and --archive, and takes --no-config, --no-git and --no-color\n',
    );
    expect((await run(root, ['new', 'T', '--no-color', '--color'])).err).toBe(
      'spec-brief: new does not read --color; it reads --root, --config, --no-config, --format, --no-git, --id, --type, --wave, --depends-on and --date, and takes --no-color\n',
    );
  });

  it('takes an option a format has nothing to read for, as a caller that asks for JSON passes --no-color beside it', async () => {
    // The lines spec-harness has run since its 0.1.0, and --color beside a format that has none.
    const root = repo('cli-unread-harness', { 'briefs/001_a.md': goodBrief({ wave: '1' }), 'briefs/002_b.md': goodBrief({ wave: '1' }) });
    expect((await run(root, ['archive', '2', '--commit', 'HEAD'])).code).toBe(EXIT_OK);
    commitAll(root, 'the second round is archived');
    const list = await run(root, ['list', '--archived', '--format', 'json', '--no-color']);
    expect({ code: list.code, err: list.err }).toEqual({ code: EXIT_OK, err: '' });
    expect((JSON.parse(list.out) as { briefs: { id: string }[] }).briefs.map((b) => b.id).sort()).toEqual(['001', '002']);
    for (const line of [
      ['archive', '1', '--dry-run', '--format', 'json', '--no-color'],
      ['archive', '1', '--dry-run', '--format', 'json', '--no-color', '--base', 'main'],
    ]) {
      const plan = await run(root, line);
      expect({ code: plan.code, err: plan.err }, line.join(' ')).toEqual({ code: EXIT_OK, err: '' });
      expect(JSON.parse(plan.out), line.join(' ')).toEqual(expect.objectContaining({ command: 'archive', ok: true, dryRun: true }));
    }
    expect((await run(dir('cli-unread-harness-init'), ['init'])).code).toBe(EXIT_OK);
    const forced = await run(root, ['list', '--format', 'json', '--color']);
    expect({ code: forced.code, err: forced.err }).toEqual({ code: EXIT_OK, err: '' });
    expect(forced.out).toBe((await run(root, ['list', '--format', 'json'])).out);
  });

  it('says in the help which command an option is not for, and the rule', () => {
    expect(HELP).toContain(
      [
        'Options for every command, except where a line says otherwise:',
        '  --root <dir>          run from this directory instead of the current one; it must exist, unless init makes it',
        '  --config <file>       use this configuration file; not for init, which writes .spec-brief.json',
        '  --no-config           use the defaults, ignoring any configuration file',
        "  --format <format>     the output format, pretty by default; each command's are below",
        '  --strict              treat warnings as errors; not for init, new or list, which have none',
        '  --no-git              leave git out; read the files on disk instead',
        '  --color, --no-color   force colour on or off; --color not for init or new, which print none',
        '',
      ].join('\n'),
    );
    expect(HELP).toContain(
      [
        'An option given an empty value, a list that names nothing and an argument a',
        'command does not take are refused, not read as if they were not there. So is',
        'an option where taking it would say what is not so, as init --strict, and so',
        'are --config beside --no-config and --color beside --no-color, of which one',
        'would go unread. An option that asks a command to leave out what it never',
        'does is taken, as init --no-git: it asks for what is already so.',
        '',
      ].join('\n'),
    );
  });
});

describe('an option given two values, and a wrong line beside --help', () => {
  // `list --root nowhere --root .` listed `.`: the later of the two was read,
  // and the earlier went unread with no word of it. And `--help` or
  // `--version` on a line answered it, exit 0, whatever else was wrong with
  // it, but an option the parser does not know (spec-core ADR-0005, amended
  // 2026-10-18).
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const twice = (option: string, first: string, second: string): Result => ({
    code: EXIT_ERROR,
    out: '',
    err: `spec-brief: --${option} is given ${JSON.stringify(first)} and ${JSON.stringify(second)}, and takes one value; give one of the two\n`,
  });

  /**
   * A tree every command runs clean in, with a second configuration, a file
   * and a directory below the root. A repository where a line asks git;
   * elsewhere a `.git` of its own, so that the line is as written here, with
   * no git process to make it: a sweep runs these tests for every mutant of
   * the line's reading.
   */
  function tree(name: string, git = false): string {
    const files = {
      'team.json': JSON.stringify({ briefs: 'specs' }),
      'notes.txt': 'a file\n',
      'sub/keep.txt': '',
      'briefs/001_a.md': goodBrief({ wave: '1' }),
      'specs/001_s.md': goodBrief(),
    };
    if (git) return repo(name, files);
    const root = plain(name, files);
    mkdirSync(join(root, '.git'));
    return root;
  }

  /** Every file under a directory but git's, so that a line can be shown to have written nothing. */
  const files = (root: string): string[] =>
    (readdirSync(root, { recursive: true }) as string[])
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => !path.startsWith('.git/') && path !== '.git')
      .sort();

  // Each option the help gives a value, on a command that reads it, with two values that read as two.
  const TWO: [line: string[], option: string, first: string, second: string][] = [
    [['list'], 'root', 'nowhere', '.'],
    [['list'], 'config', 'team.json', '.spec-brief.json'],
    [['lint'], 'format', 'json', 'pretty'],
    [['init'], 'briefs', 'specs', 'tasks'],
    [['init'], 'archive', 'specs/old', 'tasks/old'],
    [['new', 'T'], 'id', '50', '51'],
    [['new', 'T'], 'type', 'feature', 'defect'],
    [['new', 'T'], 'wave', '1', '2'],
    [['new', 'T'], 'depends-on', '1', '1,2'],
    [['new', 'T'], 'date', '2026-01-01', '2026-02-02'],
    [['archive', '1', '--dry-run'], 'pr', '5', '6'],
    [['archive', '1', '--dry-run'], 'commit', 'HEAD', 'HEAD~1'],
    [['archive', '1', '--dry-run'], 'base', 'main', 'HEAD~1'],
    [['archive', '1', '--dry-run'], 'summary', 'Done.', 'Undone.'],
    [['archive', '1', '--dry-run'], 'date', '2026-01-01', '2026-02-02'],
  ];

  it('holds every option the help gives a value to the rule', () => {
    const valued = new Set([...HELP.matchAll(/^ {2}--([a-z-]+) </gm)].map((m) => m[1] as string));
    expect([...new Set(TWO.map(([, option]) => option))].sort()).toEqual([...valued].sort());
  });

  it.each(TWO)('%j refuses --%s given two values, by both as they were written, in either order, and writes nothing', async (line, option, first, second) => {
    const root = line[0] === 'init' ? dir('cli-two-init') : tree(`cli-two-${option}`);
    const before = files(root);
    expect(await run(root, [...line, `--${option}`, first, `--${option}`, second])).toEqual(twice(option, first, second));
    expect(await run(root, [`--${option}=${second}`, ...line, `--${option}`, first])).toEqual(twice(option, second, first));
    expect(files(root)).toEqual(before);
  });

  it('names the first option given two values, and shows what cannot be seen in them', async () => {
    const root = tree('cli-two-first');
    const before = files(root);
    expect(await run(root, ['archive', '1', '--dry-run', '--summary', 'a', '--pr', '5', '--summary', 'b', '--pr', '6'])).toEqual(twice('summary', 'a', 'b'));
    expect(await run(root, ['archive', '1', '--dry-run', '--summary', 'Done.', '--summary', 'Done.\tAnd more.'])).toEqual(twice('summary', 'Done.', 'Done.\tAnd more.'));
    // A value that is no number, or no directory inside the repository, is still one of two values.
    expect(await run(root, ['new', 'T', '--wave', 'v1', '--wave', 'v2'])).toEqual(twice('wave', 'v1', 'v2'));
    expect(await run(root, ['archive', '1', '--dry-run', '--pr', '1st', '--pr', '2nd'])).toEqual(twice('pr', '1st', '2nd'));
    expect(await run(dir('cli-two-outside'), ['init', '--briefs', '../a', '--briefs', '../b'])).toEqual(twice('briefs', '../a', '../b'));
    // A list is read by its ids, in their order: the brief scaffolded writes them so.
    expect(await run(root, ['new', 'T', '--depends-on', '1,2', '--depends-on', '12'])).toEqual(twice('depends-on', '1,2', '12'));
    expect(await run(root, ['new', 'T', '--depends-on', '1,2', '--depends-on', '2,1'])).toEqual(twice('depends-on', '1,2', '2,1'));
    expect(files(root)).toEqual(before);
  });

  it('takes one value given twice, however it is written, as the line that gives it once', async () => {
    // The line, the option, the value, and the same value written again, in the tree it is run in.
    const SAME = (root: string): [line: string[], option: string, once: string, again: string][] => [
      [['list'], 'root', root, `${root}/sub/..`],
      [['list'], 'config', 'team.json', './team.json'],
      // A configuration is found from the directory the run starts in.
      [['list'], 'config', join(root, 'team.json'), 'team.json'],
      [['lint'], 'format', 'json', 'json'],
      [['init'], 'briefs', 'specs', './specs/'],
      [['init'], 'archive', 'specs/old', 'specs/./old'],
      [['new', 'T'], 'id', '50', '50'],
      [['new', 'T'], 'type', 'feature', 'feature'],
      [['new', 'T'], 'wave', '1', '01'],
      [['new', 'T'], 'depends-on', '1,2', ' 1 , 2 '],
      [['new', 'T'], 'date', '2026-01-01', '2026-01-01'],
      [['archive', '1', '--dry-run'], 'pr', '5', '05'],
      [['archive', '1', '--dry-run'], 'commit', 'HEAD', 'HEAD'],
      [['archive', '1', '--dry-run'], 'base', 'main', 'main'],
      [['archive', '1', '--dry-run'], 'summary', 'Done.', ' Done. '],
      [['archive', '1', '--dry-run'], 'date', '2026-01-01', '2026-01-01'],
    ];
    const read = tree('cli-same', true);
    for (let index = 0; index < SAME(read).length; index += 1) {
      const [line] = SAME(read)[index] as [string[], string, string, string];
      // A line that writes is run in two trees alike; one that reads, twice in one.
      const [here, twin] = line[0] === 'init' ? [dir('cli-same-init'), dir('cli-same-init-twin')] : line[0] === 'new' ? [tree('cli-same-new'), tree('cli-same-new-twin')] : [read, read];
      const [, option, once, again] = SAME(here)[index] as [string[], string, string, string];
      const [, , onceThere] = SAME(twin)[index] as [string[], string, string, string];
      const shown = `${line.join(' ')} --${option} ${JSON.stringify(once)} --${option}=${JSON.stringify(again)}`;
      const given = await run(here, [...line, `--${option}`, once, `--${option}=${again}`]);
      const alone = await run(twin, [...line, `--${option}`, onceThere]);
      expect({ code: given.code, err: given.err }, shown).toEqual({ code: EXIT_OK, err: '' });
      expect(given.out, shown).toBe(alone.out);
      expect(files(here), shown).toEqual(files(twin));
    }
    // A root is resolved from the directory the process runs in, as the run resolves it, whatever the other root names.
    const missing = join('tests', 'no-such-directory');
    expect(await run(read, ['list', '--root', missing, '--root', join(process.cwd(), missing)])).toEqual({
      code: EXIT_ERROR,
      out: '',
      err: `spec-brief: --root is "${join(process.cwd(), missing)}", which is no directory; give it one, or leave the option out\n`,
    });
    // From a --root, where the run reads the configuration.
    const elsewhere = dir('cli-same-elsewhere');
    expect(await run(elsewhere, ['list', '--root', read, '--config', join(read, 'team.json'), '--config', 'team.json'])).toEqual(
      await run(elsewhere, ['list', '--root', read, '--config', 'team.json']),
    );
    // A flag given twice is that flag once, and so is either of the two answers.
    expect(await run(read, ['lint', '--strict', '--no-git', '--strict', '--no-git'])).toEqual(await run(read, ['lint', '--strict', '--no-git']));
    expect(await run(read, ['--help', '-h', 'list', '--help'])).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect(await run(read, ['-v', '--version'])).toEqual({ code: EXIT_OK, out: `${pkg.version}\n`, err: '' });
    // A list in one value is a list: no option here is one that each use adds to.
    expect(await run(read, ['new', 'T', '--depends-on', '1,2', '--depends-on', '1, 2'])).toEqual({ code: EXIT_OK, out: 'wrote briefs/002_t.md\n', err: '' });
    expect(readFileSync(join(read, 'briefs', '002_t.md'), 'utf8')).toContain('\ndependsOn: ["1", "2"]\n');
  });

  it('refuses --help beside --version, in either order, by both as they were written', async () => {
    // Each printed the version, exit 0, and the help it was asked for went unread.
    const root = tree('cli-help-version');
    const both = (first: string, second: string): Result => ({
      code: EXIT_ERROR,
      out: '',
      err: `spec-brief: ${first} is given beside ${second}, and one of the two answers would go unread; give one of the two\n`,
    });
    expect(await run(root, ['--help', '--version'])).toEqual(both('--help', '--version'));
    expect(await run(root, ['--version', '--help'])).toEqual(both('--version', '--help'));
    expect(await run(root, ['-h', '-v'])).toEqual(both('-h', '-v'));
    expect(await run(root, ['-vh'])).toEqual(both('-v', '-h'));
    expect(await run(root, ['list', '--help', '-v'])).toEqual(both('--help', '-v'));
    expect(await run(root, ['-v', 'list', '--help', '--version'])).toEqual(both('-v', '--help'));
    expect(await run(root, ['init', '--version', '-h'])).toEqual(both('--version', '-h'));
  });

  // Each line wrong in itself, whatever the tree holds, with what it is refused for, in the parser's own words for an option it does not know.
  const WRONG: [line: string[], refusal: string | RegExp][] = [
    [['list', '--bogus'], /^spec-brief: Unknown option '--bogus'\. [^\n]+\n$/],
    [['lnit'], '"lnit" is not a command; run spec-brief --help'],
    [['list', 'extra'], 'list takes no argument, not "extra": spec-brief list'],
    [['list', '--root', ''], '--root is "", which is no value; give it one, or leave the option out'],
    [['init', '--strict'], 'init does not read --strict; it reads --root, --format, --briefs and --archive, and takes --no-config, --no-git and --no-color'],
    [['new', 'T', '--color'], 'new does not read --color; it reads --root, --config, --no-config, --format, --no-git, --id, --type, --wave, --depends-on and --date, and takes --no-color'],
    [['list', '--strict'], 'list does not read --strict; it reads --root, --config, --no-config, --format, --no-git, --color, --no-color, --ready and --archived'],
    [['lint', '--config', 'team.json', '--no-config'], '--config is given beside --no-config, which has the run read no configuration file; give one of the two'],
    [['lint', '--no-config', '--config', 'team.json'], '--config is given beside --no-config, which has the run read no configuration file; give one of the two'],
    [['lint', '--color', '--no-color'], '--color is given beside --no-color, which turns colour off; give one of the two'],
    [['lint', '--no-color', '--color'], '--color is given beside --no-color, which turns colour off; give one of the two'],
    [['archive', '1', '--dry-run', '--commit', 'HEAD', '--no-git'], 'a commit or a base needs git; drop --no-git, or drop --commit and --base'],
    [['archive', '1', '--dry-run', '--no-git', '--base', 'main'], 'a commit or a base needs git; drop --no-git, or drop --commit and --base'],
    [['list', '--format', 'sarif'], '--format for list is one of pretty, json, not "sarif"'],
    [['lint', '--format', 'html'], '--format for lint is one of pretty, json, sarif, github, gitlab, not "html"'],
    [['list', '--root', 'nowhere', '--root', '.'], '--root is given "nowhere" and ".", and takes one value; give one of the two'],
    [['new', 'T', '--wave', 'two'], '--wave must be a whole number of at least 0, not "two"'],
    [['archive', '1', '--dry-run', '--pr', '0'], '--pr must be a whole number of at least 1, not "0"'],
    [['new', 'T', '--depends-on', ','], '--depends-on is ",", which names no brief; give it ids with commas between them, as in 7,8, or leave the option out'],
    [['new', 'T', '--depends-on', '1,,2'], '--depends-on is "1,,2", which names no brief in one of its places; give it ids with one comma between each two, as in 7,8, and none before or after'],
    [['new', 'T', '--date', '2026-02-30'], '"2026-02-30" is not a date written YYYY-MM-DD'],
    [['archive', '1', '--dry-run', '--date', 'today'], '"today" is not a date written YYYY-MM-DD'],
    [['archive', '1', '--dry-run', '--commit=-x'], '"-x" is not a revision'],
    [['archive', '1', '--dry-run', '--base=-x'], '"-x" is not a revision'],
    [['init', '--briefs', '../outside'], '--briefs must be a directory inside the repository, not "../outside"'],
    [['init', '--briefs', 'a', '--archive', 'a'], '--briefs and --archive must be two directories'],
    [['archive', '1', '2', '--dry-run'], 'archive takes one brief: spec-brief archive <brief>'],
    [['unarchive', '1', '2', '--dry-run'], 'unarchive takes one brief: spec-brief unarchive <brief>'],
  ];

  // One repository for the lines that refuse before any is opened; init is given an empty directory each time.
  let shared: string | undefined;

  it.each(WRONG)('refuses %j with --help or --version on it, before or after it, as without', async (line, refusal) => {
    const root = line[0] === 'init' ? dir('cli-wrong-init') : (shared ??= tree('cli-wrong'));
    const before = files(root);
    const refused = await run(root, line);
    expect({ code: refused.code, out: refused.out }, line.join(' ')).toEqual({ code: EXIT_ERROR, out: '' });
    if (typeof refusal === 'string') expect(refused.err, line.join(' ')).toBe(`spec-brief: ${refusal}\n`);
    else expect(refused.err, line.join(' ')).toMatch(refusal);
    for (const asked of ['--help', '-h', '--version', '-v']) {
      expect(await run(root, [...line, asked]), `${line.join(' ')} ${asked}`).toEqual(refused);
      expect(await run(root, [asked, ...line]), `${asked} ${line.join(' ')}`).toEqual(refused);
    }
    expect(files(root), line.join(' ')).toEqual(before);
  });

  it('answers --help and --version where only the tree can refuse the line, and where what it lacks is what the help gives', async () => {
    // A root, a configuration, an id or a type is refused by what the tree
    // holds, which --help and --version open none of; a command without the
    // brief or the title it takes is what a person asks the help about.
    const root = tree('cli-answered');
    const before = files(root);
    for (const line of [
      [],
      ['new'],
      ['archive'],
      ['unarchive'],
      ['init'],
      ['list', '--root', join(root, 'nowhere')],
      ['list', '--root', join(root, 'notes.txt')],
      ['list', '--config', 'nowhere.json'],
      ['list', '--config', 'notes.txt'],
      ['new', 'T', '--type', 'epic'],
      ['new', 'T', '--id', '001'],
      ['archive', '9', '--dry-run'],
      ['archive', '1', '--dry-run', '--commit', 'nothing'],
    ]) {
      expect(await run(root, [...line, '--help']), `${line.join(' ')} --help`).toEqual({ code: EXIT_OK, out: HELP, err: '' });
      expect(await run(root, ['-v', ...line]), `-v ${line.join(' ')}`).toEqual({ code: EXIT_OK, out: `${pkg.version}\n`, err: '' });
    }
    expect(files(root)).toEqual(before);
  });

  it('has the run read each value the line was checked for', async () => {
    // Checked where the line is read, a value is read again where the run uses it.
    const root = repo('cli-read-after', { 'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**]' }) });
    expect((await run(root, ['archive', '1', '--dry-run', '--pr', '12', '--no-color'])).out).toContain('> Merged in pull request #12.\n');
    expect((await run(root, ['archive', '1', '--dry-run', '--base', 'main', '--no-color'])).out).toContain(' is already in main, so the diff from their merge base is empty  scope-unmeasured\n');
    expect((await run(root, ['archive', '1', '--dry-run', '--no-color'])).out).toContain('affectedFiles went unchecked: no commit or base was named');
  });

  it('says in the help that two values are refused, and a wrong line beside --help', () => {
    expect(HELP).toContain(
      [
        'An option that takes one value and is given two is refused, as --root a',
        '--root b, since the earlier would go unread; one value given twice, however',
        'it is written, is taken once, as --root . --root ./. A line refused for any',
        'of these is refused with --help or --version on it too, and so is --help',
        'beside --version.',
        '',
      ].join('\n'),
    );
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
    const made1 = await run(root, ['new', 'Rotate', 'the', 'tokens', '--wave', '2', '--depends-on', '7, 8', '--type', 'feature']);
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

  it('colours a terminal, and follows NO_COLOR, FORCE_COLOR, a dumb terminal and the flags', async () => {
    const root = plain('cli-lint-color', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const esc = String.fromCharCode(27);
    expect((await run(root, ['lint'], {}, true)).out).toContain(`${esc}[`);
    expect((await run(root, ['lint'])).out).not.toContain(esc);
    expect((await run(root, ['lint'], { NO_COLOR: '1' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { NO_COLOR: '' }, true)).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '1' })).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '0' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '' })).out).not.toContain(esc);
    // A terminal that says it is dumb gets none, unless colour is forced or asked for; any other terminal's name changes nothing.
    expect((await run(root, ['lint'], { TERM: 'dumb' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { TERM: 'dumb', FORCE_COLOR: '1' }, true)).out).toContain(esc);
    expect((await run(root, ['lint', '--color'], { TERM: 'dumb' }, true)).out).toContain(esc);
    expect((await run(root, ['lint'], { TERM: 'xterm-256color' }, true)).out).toContain(esc);
    expect((await run(root, ['lint'], { TERM: 'DUMB' }, true)).out).toContain(esc);
    expect((await run(root, ['lint', '--color'])).out).toContain(esc);
    expect((await run(root, ['lint', '--no-color'], { FORCE_COLOR: '1' })).out).not.toContain(esc);
    expect((await run(root, ['lint', '--format', 'json', '--color'])).out).not.toContain(esc);
  });

  it('reads FORCE_COLOR as off for exactly 0 and exactly false, and as on for any other word', async () => {
    const root = plain('cli-lint-force-color', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const esc = String.fromCharCode(27);
    // "false" forced colour on, into a pipe too, where Node itself and supports-color read it as off.
    expect((await run(root, ['lint'], { FORCE_COLOR: 'false' })).out).not.toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: 'false' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: 'false', TERM: 'xterm-256color' }, true)).out).not.toContain(esc);
    // --color still asks for colour over it, and NO_COLOR still wins over a word that forces it.
    expect((await run(root, ['lint', '--color'], { FORCE_COLOR: 'false' })).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: 'true', NO_COLOR: '1' }, true)).out).not.toContain(esc);
  });

  it.each(['true', '1', 'FALSE', 'False', 'no', '00', ' false', '2'])('reads FORCE_COLOR=%j as on, into a pipe and on a dumb terminal', async (value) => {
    // Only the two spellings are off: "FALSE" is on here, though Node reads every word it does not know as off.
    const root = plain('cli-lint-force-on', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const esc = String.fromCharCode(27);
    expect((await run(root, ['lint'], { FORCE_COLOR: value })).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: value, TERM: 'dumb' }, true)).out).toContain(esc);
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
    const root = repo('cli-archive-git', { 'briefs/001_a.md': goodBrief(), 'blank.json': '{ "archiving": { "base": " " } }' });
    // A revision that would be read as an option is never handed to git.
    expect(await run(root, ['archive', '1', '--commit=-x', '--dry-run'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: "-x" is not a revision\n' });
    expect(await run(root, ['archive', '1', '--base=-x', '--dry-run'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: "-x" is not a revision\n' });
    // Nor is one that names nothing: the option's is refused before git is reached, the configuration's here.
    expect(await run(root, ['archive', '1', '--config', 'blank.json', '--dry-run'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: " " is not a revision\n' });
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
