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
import { CONFIG_FILES, ConfigError, initialConfig } from './config.js';
import { BriefEngine, EngineError, today } from './engine.js';
import { NodeFileSystem } from './fs.js';
import { failing, sortFindings, summarise } from './lint.js';
import { normalisePath } from './links.js';
import {
  briefJson,
  findingJson,
  FORMATS,
  type Format,
  githubCommands,
  jsonDocument,
  type ListRow,
  planJson,
  prettyFindings,
  prettyList,
  prettyMatrix,
  prettyPlan,
  sarif,
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

export const HELP = `spec-brief - lint, schedule and archive task briefs

Usage:
  spec-brief <command> [options]

Commands:
  init                  write .spec-brief.json and the brief directories
  new <title>           scaffold a brief with the next free id
  lint [brief...]       check briefs against the configuration
  list                  briefs with their status, wave and readiness
  matrix                scope collisions between briefs in the same wave
  archive <brief>       close a round: check it, stamp it, freeze it, move it
  unarchive <brief>     reopen an archived brief

Options for every command:
  --root <dir>          run from this directory instead of the current one
  --config <file>       use this configuration file
  --no-config           use the defaults, ignoring any configuration file
  --format <format>     pretty (default), json, sarif or github
  --strict              treat warnings as errors
  --no-git              leave git out; read the files on disk instead
  --color, --no-color   force colour on or off
  -h, --help            show this help
  -v, --version         show the version

init:
  --briefs <dir>        the directory of live briefs; default briefs
  --archive <dir>       the directory of archived briefs; default <briefs>/archive

new:
  --id <id>             use this id instead of the next free one
  --type <type>         a brief type from the configuration
  --wave <n>            the wave it runs in
  --depends-on <ids>    comma-separated ids it runs after
  --date <YYYY-MM-DD>   the date in its front matter; default today

list:
  --ready               only live briefs whose dependencies are archived
  --archived            include archived briefs

matrix:
  --all-waves           compare every live brief, whatever its wave

archive:
  --pr <number>         the pull request the round merged in
  --commit <rev>        the commit the round landed as
  --base <rev>          the branch it started from; the diff runs from the merge base
  --summary <text>      what the round did, for the banner
  --date <YYYY-MM-DD>   the archival date; default today
  --allow-dirty         archive although the tree has uncommitted work
  --dry-run             print the plan and change nothing

unarchive:
  --dry-run             print the plan and change nothing

Exit codes: 0 clean, 1 findings or refused, 2 the run could not be trusted.
`;

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

const COMMANDS: Readonly<Record<string, { options: NonNullable<ParseArgsConfig['options']>; formats: readonly Format[] }>> = {
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
  const spec = command === undefined ? undefined : COMMANDS[command];
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

function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
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
  /** Today, as the environment the run was given says. */
  readonly today: string;
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
  const root = text(run.values, 'root');
  const config = text(run.values, 'config');
  return BriefEngine.open({
    cwd: root === undefined ? run.cwd : root,
    ...(config === undefined ? {} : { config }),
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
  const briefs = normalisePath(text(run.values, 'briefs') ?? 'briefs');
  const archive = normalisePath(text(run.values, 'archive') ?? `${briefs}/archive`);
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
    date: text(run.values, 'date') ?? run.today,
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
  return emitFindings(run, 'lint', findings, checked);
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
    run.out(jsonDocument('list', run.version, { ok: true, briefs: rows.map((r) => briefJson(r.brief, { ready: r.ready, waitingOn: r.waitingOn })) }));
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
    run.out(`${prettyMatrix(report, run.style)}\n`);
    return failing(sorted, run.strict) ? EXIT_FAILED : EXIT_OK;
  }
  const waves = report.waves.map((w) => ({
    wave: w.wave,
    briefs: w.briefs.map((b) => b.id),
    collisions: w.collisions.map((c) => ({ a: c.a.id, b: c.b.id, patterns: c.patterns, witness: c.witness })),
    sharedDirectories: w.shared.map((s) => ({ a: s.a.id, b: s.b.id, directory: s.directory })),
    unscoped: w.unscoped.map((b) => b.id),
  }));
  return emitFindings(run, 'matrix', sorted, engine.corpus.live.length, { waves, unscheduled: report.unscheduled.map((b) => b.id) });
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
          date: text(run.values, 'date') ?? run.today,
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
  if (flag(values, 'version')) {
    stdout.write(`${await version()}\n`);
    return EXIT_OK;
  }
  if (flag(values, 'help') || command === undefined) {
    stdout.write(HELP);
    return command === undefined && !flag(values, 'help') ? EXIT_ERROR : EXIT_OK;
  }
  const spec = COMMANDS[command] as (typeof COMMANDS)[string];
  const format = (text(values, 'format') ?? 'pretty') as Format;
  if (!spec.formats.includes(format)) {
    err(`--format for ${command} is one of ${spec.formats.join(', ')}, not "${format}"`);
    return EXIT_ERROR;
  }
  const run: Run = {
    today: today(io.env ?? process.env),
    out: (t) => {
      stdout.write(t);
    },
    err,
    style: { color: format === 'pretty' && useColor(values, io) },
    format,
    strict: flag(values, 'strict'),
    version: await version(),
    values,
    positionals,
    cwd: io.cwd ?? process.cwd(),
  };
  try {
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
      case 'archive':
        return await runTransition(run, 'archive');
      default:
        return await runTransition(run, 'unarchive');
    }
  } catch (error) {
    const expected = [ConfigError, UsageError, EngineError, ConflictError, TransactionError];
    if (expected.some((kind) => error instanceof kind)) {
      err((error as Error).message);
      return EXIT_ERROR;
    }
    err(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return EXIT_ERROR;
  }
}
