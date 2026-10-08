/**
 * The command line: argument parsing, dispatch, output and exit codes.
 *
 * Exit 0: done, nothing found. Exit 1: findings, collisions, or an action
 * refused. Exit 2: the run could not be trusted - a bad flag, a configuration
 * that does not load, a brief that does not exist. A run that checked nothing
 * must never exit as though it found nothing.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';

import { TransactionError, ConflictError } from './apply.js';
import type { Plan } from './archive.js';
import { reported } from './collisions.js';
import { CONFIG_FILES, ConfigError, initialConfig } from './config.js';
import { BriefEngine, EngineError, today } from './engine.js';
import { NodeFileSystem } from './fs.js';
import { GitError } from './git.js';
import { failing, sortFindings, summarise } from './lint.js';
import { normalisePath } from './links.js';
import {
  briefJson,
  findingJson,
  FORMATS,
  type Format,
  githubCommands,
  gitlabCodeQuality,
  jsonDocument,
  type ListRow,
  matrixJson,
  planJson,
  prettyFindings,
  prettyList,
  prettyMatrix,
  prettyPlan,
  prettySchedule,
  sarif,
  scheduleJson,
  sectionsJson,
  type Style,
  summaryLine,
} from './report.js';
import type { Finding } from './types.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliIO {
  readonly stdout?: { write(text: string): unknown; readonly isTTY?: boolean };
  readonly stderr?: { write(text: string): unknown };
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type Values = Record<string, string | boolean | undefined>;

const GLOBAL: NonNullable<ParseArgsConfig['options']> = {
  root: { type: 'string' },
  config: { type: 'string' },
  'no-config': { type: 'boolean' },
  format: { type: 'string' },
  strict: { type: 'boolean' },
  'no-git': { type: 'boolean' },
  color: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

interface CommandSpec {
  readonly options: NonNullable<ParseArgsConfig['options']>;
  readonly formats: readonly Format[];
}

const TABLE: Readonly<Record<string, CommandSpec>> = {
  init: { options: { briefs: { type: 'string' }, archive: { type: 'string' } }, formats: ['pretty', 'json'] },
  new: {
    options: {
      id: { type: 'string' },
      type: { type: 'string' },
      wave: { type: 'string' },
      'depends-on': { type: 'string' },
      date: { type: 'string' },
    },
    formats: ['pretty', 'json'],
  },
  lint: { options: {}, formats: FORMATS },
  list: { options: { ready: { type: 'boolean' }, archived: { type: 'boolean' } }, formats: ['pretty', 'json'] },
  matrix: { options: { 'all-waves': { type: 'boolean' } }, formats: FORMATS },
  schedule: { options: { write: { type: 'boolean' } }, formats: FORMATS },
  archive: {
    options: {
      pr: { type: 'string' },
      commit: { type: 'string' },
      base: { type: 'string' },
      summary: { type: 'string' },
      date: { type: 'string' },
      'allow-dirty': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    formats: ['pretty', 'json'],
  },
  unarchive: { options: { 'dry-run': { type: 'boolean' } }, formats: ['pretty', 'json'] },
};

/**
 * The commands by name, and nothing for a command line that names none. A map,
 * because an object answers to more names than it was given: `constructor` and
 * `toString` are no commands.
 */
const COMMANDS: ReadonlyMap<string | undefined, CommandSpec> = new Map(Object.entries(TABLE));

/**
 * The formats each command writes, read from the table `main` checks a
 * `--format` against, so the help names no format a command refuses: the
 * finding formats are `lint`'s, `matrix`'s and `schedule`'s alone.
 */
function formatsHelp(): string {
  const groups = new Map<string, string[]>();
  for (const [command, spec] of Object.entries(TABLE)) {
    const formats = spec.formats.join(', ');
    groups.set(formats, [...(groups.get(formats) ?? []), command]);
  }
  const rows = [...groups].map(([formats, commands]) => [commands.join(', '), formats] as const);
  const width = Math.max(...rows.map(([commands]) => commands.length));
  return rows.map(([commands, formats]) => `  ${commands.padEnd(width)}  ${formats}`).join('\n');
}

export const HELP = `spec-brief - lint, schedule and archive task briefs

Usage:
  spec-brief <command> [options]

Commands:
  init                  write .spec-brief.json and the brief directories
  new <title>           scaffold a brief with the next free id
  lint [brief...]       check briefs against the configuration
  list                  briefs with their status, wave and readiness
  matrix                scope collisions between briefs in the same wave
  schedule              the waves the live briefs can run in, computed
  archive <brief>       close a round: check it, stamp it, freeze it, move it
  unarchive <brief>     reopen an archived brief

Options for every command:
  --root <dir>          run from this directory instead of the current one
  --config <file>       use this configuration file
  --no-config           use the defaults, ignoring any configuration file
  --format <format>     the output format, pretty by default; each command's are below
  --strict              treat warnings as errors
  --no-git              leave git out; read the files on disk instead
  --color, --no-color   force colour on or off
  -h, --help            show this help
  -v, --version         show the version

Formats:
${formatsHelp()}

init:
  --briefs <dir>        the directory of live briefs; default briefs
  --archive <dir>       the directory of archived briefs; default <briefs>/archive

new:
  --id <id>             use this id instead of the next free one
  --type <type>         a brief type from the configuration
  --wave <n>            the wave it runs in
  --depends-on <ids>    comma-separated ids it runs after
  --date <YYYY-MM-DD>   the date in its front matter; default SOURCE_DATE_EPOCH's, or today's in UTC

list:
  --ready               only briefs that can run now: dependencies archived, not drafts or deferred
  --archived            include archived briefs

matrix:
  --all-waves           compare every live brief, whatever its wave

schedule:
  --write               write each proposed wave into its brief's front matter

archive:
  --pr <number>         the pull request the round merged in
  --commit <rev>        the commit the round landed as
  --base <rev>          the branch it started from; the diff runs from the merge base
  --summary <text>      what the round did, for the banner
  --date <YYYY-MM-DD>   the archival date; default SOURCE_DATE_EPOCH's, or today's in UTC
  --allow-dirty         archive although the tree has uncommitted work
  --dry-run             print the plan and change nothing

unarchive:
  --dry-run             print the plan and change nothing

Exit codes: 0 clean, 1 findings or refused, 2 the run could not be trusted.
`;

interface Parsed {
  readonly command: string | undefined;
  readonly values: Values;
  readonly positionals: readonly string[];
}

/** Global options that take a value, so the value is not mistaken for the command. */
const VALUED = new Set(['--root', '--config', '--format']);

function commandOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') return argv[i + 1];
    if (VALUED.has(arg)) {
      i += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

export function parse(argv: readonly string[]): Parsed {
  const command = commandOf(argv);
  const spec = COMMANDS.get(command);
  if (command !== undefined && spec === undefined) {
    throw new UsageError(`"${command}" is not a command; run spec-brief --help`);
  }
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { ...GLOBAL, ...(spec?.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
    return { command, values: values as Values, positionals: positionals.slice(1) };
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

/** The value of an option declared a string, which is all `parseArgs` gives one. */
function text(values: Values, key: string): string | undefined {
  return values[key] as string | undefined;
}

function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

function integer(values: Values, key: string, minimum: number): number | undefined {
  const raw = text(values, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < minimum) throw new UsageError(`--${key} must be a whole number of at least ${minimum}, not "${raw}"`);
  return Number(raw);
}

async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

interface Run {
  /**
   * Today, as the environment the run was given says. Asked only by a command
   * that writes a date and was given none: a `SOURCE_DATE_EPOCH` that cannot
   * be read stops the run that would have written the clock's date for it,
   * and no run whose answer it has no part in.
   */
  readonly today: () => string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly style: Style;
  readonly format: Format;
  readonly strict: boolean;
  readonly version: string;
  readonly values: Values;
  readonly positionals: readonly string[];
  readonly cwd: string;
}

function useColor(values: Values, io: CliIO): boolean {
  if (flag(values, 'no-color')) return false;
  if (flag(values, 'color')) return true;
  const env = io.env ?? process.env;
  if ((env['NO_COLOR'] ?? '') !== '') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '') return force !== '0';
  return (io.stdout ?? process.stdout).isTTY === true;
}

async function openEngine(run: Run): Promise<BriefEngine> {
  return BriefEngine.open({
    cwd: text(run.values, 'root') ?? run.cwd,
    config: text(run.values, 'config'),
    ...(flag(run.values, 'no-git') ? { git: null } : {}),
    noConfig: flag(run.values, 'no-config'),
  });
}

function emitFindings(run: Run, command: string, findings: readonly Finding[], checked: number, extra: Record<string, unknown> = {}): number {
  const failed = failing(findings, run.strict);
  switch (run.format) {
    case 'json':
      run.out(jsonDocument(command, run.version, { ok: !failed, checked, summary: summarise(findings), findings: findings.map(findingJson), ...extra }));
      break;
    case 'sarif':
      run.out(sarif(findings, run.version));
      break;
    case 'github':
      run.out(githubCommands(findings));
      break;
    case 'gitlab':
      run.out(gitlabCodeQuality(findings));
      break;
    case 'pretty':
      if (findings.length > 0) run.out(`${prettyFindings(findings, run.style)}\n\n`);
      run.out(`${findings.length === 0 ? `${checked} brief(s) checked, no findings` : `${summaryLine(findings)} in ${checked} brief(s)`}\n`);
      break;
  }
  return failed ? EXIT_FAILED : EXIT_OK;
}

async function runInit(run: Run): Promise<number> {
  const root = text(run.values, 'root') ?? run.cwd;
  const fs = new NodeFileSystem(root);
  for (const name of CONFIG_FILES) {
    if (await fs.exists(name)) throw new UsageError(`${name} already exists here; edit it instead`);
  }
  // A directory above the root is refused as the configuration refuses one
  // (config.ts), in the same words, before anything is written.
  const inside = (option: string, given: string): string => {
    try {
      return normalisePath(given);
    } catch {
      throw new UsageError(`--${option} must be a directory inside the repository, not "${given}"`);
    }
  };
  const briefs = inside('briefs', text(run.values, 'briefs') ?? 'briefs');
  const archive = inside('archive', text(run.values, 'archive') ?? `${briefs}/archive`);
  if (briefs === '' || archive === '' || briefs === archive) throw new UsageError('--briefs and --archive must be two directories');
  const config = `${JSON.stringify(initialConfig(briefs, archive), null, 2)}\n`;
  await fs.write('.spec-brief.json', config);
  const written = ['.spec-brief.json'];
  for (const dir of [briefs, archive]) {
    const keep = `${dir}/.gitkeep`;
    if ((await fs.list(dir)) === null) {
      await fs.write(keep, '');
      written.push(keep);
    }
  }
  if (run.format === 'json') run.out(jsonDocument('init', run.version, { ok: true, written }));
  else run.out(`${written.map((w) => `wrote ${w}`).join('\n')}\nnext: spec-brief new "<title>"\n`);
  return EXIT_OK;
}

async function runNew(run: Run): Promise<number> {
  const title = run.positionals.join(' ').trim();
  if (title === '') throw new UsageError('new needs a title: spec-brief new "<title>"');
  const engine = await openEngine(run);
  const dependsOn = text(run.values, 'depends-on')
    ?.split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
  const created = await engine.create({
    title,
    id: text(run.values, 'id'),
    type: text(run.values, 'type'),
    wave: integer(run.values, 'wave', 0),
    dependsOn,
    date: text(run.values, 'date') ?? run.today(),
  });
  if (run.format === 'json') run.out(jsonDocument('new', run.version, { ok: true, file: created.file }));
  else run.out(`wrote ${created.file}\n`);
  return EXIT_OK;
}

async function runLint(run: Run): Promise<number> {
  const engine = await openEngine(run);
  engine.requireBriefs();
  const findings = await engine.lint(run.positionals);
  const checked = run.positionals.length === 0 ? engine.corpus.briefs.length : run.positionals.length;
  return emitFindings(run, 'lint', findings, checked, { sections: sectionsJson(engine.config) });
}

async function runList(run: Run): Promise<number> {
  const engine = await openEngine(run);
  engine.requireBriefs();
  const briefs = flag(run.values, 'archived') ? engine.corpus.briefs : engine.corpus.live;
  const ready = new Set(engine.ready());
  const rows: ListRow[] = briefs
    .map((brief) => ({ brief, ready: ready.has(brief), waitingOn: engine.waitingOn(brief) }))
    .filter((row) => !flag(run.values, 'ready') || row.ready);
  if (run.format === 'json') {
    run.out(
      jsonDocument('list', run.version, {
        ok: true,
        briefs: rows.map((r) => briefJson(r.brief, { ready: r.ready, waitingOn: r.waitingOn })),
        sections: sectionsJson(engine.config),
      }),
    );
  } else {
    run.out(`${prettyList(rows, run.style)}\n`);
  }
  return EXIT_OK;
}

async function runMatrix(run: Run): Promise<number> {
  const engine = await openEngine(run);
  engine.requireBriefs();
  const { report, findings } = await engine.collisions({ all: flag(run.values, 'all-waves') });
  const sorted = sortFindings(findings);
  if (run.format === 'pretty') {
    // Drawn from what the run reports, so a rule that is off marks nothing in the grid.
    run.out(`${prettyMatrix(reported(engine.corpus, report), run.style)}\n`);
    return failing(sorted, run.strict) ? EXIT_FAILED : EXIT_OK;
  }
  return emitFindings(run, 'matrix', sorted, engine.corpus.live.length, matrixJson(report));
}

/**
 * The waves, computed. The view shows the moves, their reasons and the
 * cycles; the other findings - briefs that run alone, pairs the search could
 * not decide, a front matter that cannot take a wave - print beneath it.
 */
async function runSchedule(run: Run): Promise<number> {
  const engine = await openEngine(run);
  engine.requireBriefs();
  const { schedule: computed, findings } = await engine.schedule();
  let written: string[] | null = null;
  let reported: Finding[] = findings;
  if (flag(run.values, 'write')) {
    const result = await engine.writeWaves(computed);
    written = result.written;
    // Written, the waves hold, and the findings that said they did not are answered.
    reported = [...(written.length > 0 ? findings.filter((f) => f.rule !== 'wave-schedule') : findings), ...result.refused];
  }
  const sorted = sortFindings(reported);
  if (run.format === 'pretty') {
    run.out(`${prettySchedule(computed, written, run.style)}\n`);
    const rest = sorted.filter((f) => f.rule !== 'wave-schedule' && f.rule !== 'dependency-cycle');
    if (rest.length > 0) run.out(`\n${prettyFindings(rest, run.style)}\n`);
    return failing(sorted, run.strict) ? EXIT_FAILED : EXIT_OK;
  }
  return emitFindings(run, 'schedule', sorted, engine.corpus.live.length, { ...scheduleJson(computed), written });
}

async function runTransition(run: Run, action: 'archive' | 'unarchive'): Promise<number> {
  const reference = run.positionals[0];
  if (reference === undefined || run.positionals.length > 1) throw new UsageError(`${action} takes one brief: spec-brief ${action} <brief>`);
  const engine = await openEngine(run);
  const dryRun = flag(run.values, 'dry-run');
  const plan: Plan =
    action === 'archive'
      ? await engine.planArchive(reference, {
          pr: integer(run.values, 'pr', 1),
          commit: text(run.values, 'commit'),
          base: text(run.values, 'base'),
          summary: text(run.values, 'summary'),
          date: text(run.values, 'date') ?? run.today(),
          allowDirty: flag(run.values, 'allow-dirty'),
          strict: run.strict,
          noGit: flag(run.values, 'no-git'),
        })
      : engine.planUnarchive(reference, { strict: run.strict });
  const refused = plan.blocking.length > 0;
  if (!refused && !dryRun) await engine.apply(plan);
  if (run.format === 'json') run.out(jsonDocument(action, run.version, { ok: !refused, dryRun, plan: planJson(plan) }));
  else run.out(`${prettyPlan(plan, dryRun, run.style)}\n`);
  return refused ? EXIT_FAILED : EXIT_OK;
}

export async function main(argv: readonly string[] = process.argv.slice(2), io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const err = (message: string): void => {
    stderr.write(`spec-brief: ${message}\n`);
  };
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    err((error as Error).message);
    return EXIT_ERROR;
  }
  const { command, values, positionals } = parsed;
  // From here on, so that what comes before a command is covered as the
  // command is: --version and --help, the package's own manifest, the colour.
  // An error there left main as a rejection, which the launcher ended as
  // Node's uncaught error with exit 1, "findings" to a script.
  try {
    if (flag(values, 'version')) {
      stdout.write(`${await version()}\n`);
      return EXIT_OK;
    }
    if (flag(values, 'help') || command === undefined) {
      stdout.write(HELP);
      // Asked for, the help is the answer; printed because no command was named, it is the error.
      return flag(values, 'help') ? EXIT_OK : EXIT_ERROR;
    }
    const spec = COMMANDS.get(command) as CommandSpec;
    const format = (text(values, 'format') ?? 'pretty') as Format;
    if (!spec.formats.includes(format)) {
      err(`--format for ${command} is one of ${spec.formats.join(', ')}, not "${format}"`);
      return EXIT_ERROR;
    }
    const run: Run = {
      today: () => today(io.env ?? process.env),
      out: (t) => {
        stdout.write(t);
      },
      err,
      // Read by the pretty format alone: the others have nothing to colour.
      style: { color: useColor(values, io) },
      format,
      strict: flag(values, 'strict'),
      version: await version(),
      values,
      positionals,
      cwd: io.cwd ?? process.cwd(),
    };
    switch (command) {
      case 'init':
        return await runInit(run);
      case 'new':
        return await runNew(run);
      case 'lint':
        return await runLint(run);
      case 'list':
        return await runList(run);
      case 'matrix':
        return await runMatrix(run);
      case 'schedule':
        return await runSchedule(run);
      case 'archive':
        return await runTransition(run, 'archive');
      default:
        return await runTransition(run, 'unarchive');
    }
  } catch (error) {
    // What git refused or could not do is git's message, and no line here.
    const expected = [ConfigError, UsageError, EngineError, ConflictError, TransactionError, GitError];
    if (expected.some((kind) => error instanceof kind)) {
      err((error as Error).message);
      return EXIT_ERROR;
    }
    // A write its reader had closed the pipe for is no defect either: the
    // answer was not delivered, which is still 2, and no stack sends a person
    // looking for a bug. The process's own streams report it as an event,
    // which the launcher answers in the same words; here it is a caller's
    // stream that throws it. It is read by its code: stdout and stderr are the
    // only pipes spec-brief writes to.
    if (!(error instanceof Error)) err(`unexpected error: ${String(error)}`);
    else if ((error as NodeJS.ErrnoException).code === 'EPIPE') err('stdout was closed before all of the output was written');
    else err(`unexpected error: ${error.stack ?? error.message}`);
    return EXIT_ERROR;
  }
}
