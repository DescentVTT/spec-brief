import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { BriefEngine } from '../src/engine.js';
import { MemoryFileSystem } from '../src/fs.js';
import { goodBrief, initRepo, Sink, tempDir, writeTree } from './helpers.js';

/**
 * What `list` answers from, held to what it read. A tool that gives the
 * answer again without starting spec-brief reads each input on the list as
 * listed, and gives the answer only where every one reads the same
 * (spec-core ADR-0005, amended 2026-10-19; ADR-0002 here, amended the same
 * day): a file read and not on the list is an answer given again after it
 * changed. So every call this process makes to the disk and every process
 * it starts are recorded while `main` answers, by the modules that make
 * them, and compared with the list it printed, both ways.
 *
 * The record is of the modules, not of spec-brief: a source that read the
 * disk some way the list does not know is recorded all the same. The mock
 * reaches everything this file imports, so it is in a file of its own.
 */

const record = vi.hoisted(() => ({ on: false, calls: [] as { readonly op: string; readonly path: string }[] }));

/** Every function a module exports, recording its first argument while the record is on. */
function recorded<T extends object>(real: T, module: string): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== 'function' || !/^[a-z]/.test(name)) {
      wrapped[name] = value;
      continue;
    }
    const call = function (this: unknown, ...args: unknown[]): unknown {
      if (record.on) {
        const first = args[0];
        record.calls.push({ op: `${module}.${name}`, path: first instanceof URL ? fileURLToPath(first) : String(first) });
      }
      return (value as (...a: unknown[]) => unknown).apply(this, args);
    };
    // realpathSync.native and the like stay where callers look for them.
    wrapped[name] = Object.assign(call, value);
  }
  return wrapped as T;
}

vi.mock('node:fs/promises', async (importOriginal) => recorded(await importOriginal<typeof import('node:fs/promises')>(), 'fs/promises'));
vi.mock('node:fs', async (importOriginal) => recorded(await importOriginal<typeof import('node:fs')>(), 'fs'));
vi.mock('node:child_process', async (importOriginal) => recorded(await importOriginal<typeof import('node:child_process')>(), 'child_process'));

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

interface Listed {
  readonly keep: boolean;
  readonly tool: string;
  readonly files: readonly { readonly path: string; readonly sha256: string | null }[];
  readonly directories: readonly { readonly path: string; readonly entries: readonly string[] }[];
  readonly git: null;
}

const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));
const VERSION = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string }).version;

/** `list --format json` in `cwd`, with what it printed and every call it made meanwhile. */
async function list(cwd: string, args: readonly string[] = []): Promise<{ readonly inputs: Listed; readonly calls: readonly { op: string; path: string }[] }> {
  const stdout = new Sink();
  const stderr = new Sink();
  record.calls = [];
  record.on = true;
  const code = await main(['list', '--archived', '--format', 'json', '--no-color', ...args], { stdout, stderr, cwd, env: {} });
  record.on = false;
  expect({ code, err: stderr.text }).toEqual({ code: 0, err: '' });
  const document = JSON.parse(stdout.text) as { inputs: Listed };
  return { inputs: document.inputs, calls: [...record.calls] };
}

const digest = (path: string): string | null => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);

/** The files directly in a directory, as a reader that checks the list would list them. */
const filesIn = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

/**
 * Holds a list that may be kept to the calls: each file read, and each name
 * looked for, is on it with what it holds now; each directory listed is on it
 * with the files it holds now; nothing else on the disk was asked and no
 * process was started; and nothing is on it that was not read.
 */
function heldTo(root: string, inputs: Listed, calls: readonly { op: string; path: string }[]): void {
  const fromRoot = (path: string): string => relative(root, path).split(sep).join('/') || '.';
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const { op, path } of calls) {
    const where = `${op} ${path}`;
    // The version is the list's own field, and the root the place it is read from.
    if (op === 'fs/promises.readFile' && path === MANIFEST) continue;
    if (op === 'fs/promises.realpath' && path === root) continue;
    if (op === 'fs/promises.readFile' || op === 'fs/promises.access' || op === 'fs/promises.stat' || op === 'fs/promises.realpath') {
      files.add(fromRoot(path));
      expect(inputs.files, where).toContainEqual({ path: fromRoot(path), sha256: digest(path) });
    } else if (op === 'fs/promises.readdir') {
      directories.add(fromRoot(path));
      expect(inputs.directories, where).toContainEqual({ path: fromRoot(path), entries: filesIn(path) });
    } else {
      expect.fail(`${where}: read, and no list here names it`);
    }
  }
  expect(inputs.files.map((file) => file.path).sort()).toEqual([...files].sort());
  expect(inputs.directories.map((directory) => directory.path).sort()).toEqual([...directories].sort());
  expect(inputs.keep).toBe(true);
  expect(inputs.tool).toBe(VERSION);
  expect(inputs.git).toBeNull();
}

/** A repository with briefs read and a file in each directory that is not, written in no order a disk keeps. */
function briefs(name: string, config: Record<string, string> = { '.spec-brief.json': '{}\n' }): string {
  const root = dir(name);
  initRepo(root);
  writeTree(root, {
    ...config,
    'briefs/003_c.md': goodBrief({ dependsOn: '[1]' }),
    'briefs/README.md': 'Not a brief.\n',
    'briefs/notes/010_n.md': goodBrief(),
    'briefs/archive/002_b.md': goodBrief({ status: 'archived' }),
    'briefs/archive/README.md': 'Not a brief either.\n',
    'briefs/.gitkeep': '',
  });
  // Bytes no text keeps: a digest of the text decoded would not be theirs.
  writeFileSync(join(root, 'briefs', '001_a.md'), Buffer.concat([Buffer.from(goodBrief().replaceAll('\n', '\r\n')), Buffer.from([0xff, 0x0a])]));
  return root;
}

describe('what list answers from', () => {
  it('names every file it read and every name it looked for, with a digest of the bytes, and each directory with its files', async () => {
    const root = briefs('inputs-default');
    const { inputs, calls } = await list(root);
    heldTo(root, inputs, calls);
    expect(inputs).toEqual({
      keep: true,
      tool: VERSION,
      files: [
        { path: '.spec-brief.json', sha256: digest(join(root, '.spec-brief.json')) },
        { path: 'briefs/001_a.md', sha256: digest(join(root, 'briefs', '001_a.md')) },
        { path: 'briefs/003_c.md', sha256: digest(join(root, 'briefs', '003_c.md')) },
        { path: 'briefs/archive/002_b.md', sha256: digest(join(root, 'briefs', 'archive', '002_b.md')) },
        { path: 'spec-brief.json', sha256: null },
      ],
      directories: [
        { path: 'briefs', entries: ['.gitkeep', '001_a.md', '003_c.md', 'README.md'] },
        { path: 'briefs/archive', entries: ['002_b.md', 'README.md'] },
      ],
      git: null,
    });
  });

  it('asks git nothing where a configuration file names the root, as it reads nothing of git', async () => {
    const root = briefs('inputs-no-git-asked');
    const { calls } = await list(root);
    expect(calls.filter(({ op }) => op.startsWith('child_process.'))).toEqual([]);
    // Without one, git still says where the root is.
    const bare = briefs('inputs-git-asked', {});
    mkdirSync(join(bare, 'sub'));
    const below = await list(join(bare, 'sub'));
    expect(below.calls.filter(({ op }) => op.startsWith('child_process.')).map(({ path }) => path)).toEqual(['git']);
  });

  it('holds the list to what it read under a configuration of the other name, with its own directories and names', async () => {
    const config = { 'spec-brief.json': JSON.stringify({ briefs: 'specs', archive: 'old', files: '*.md', exclude: ['README.md'] }) };
    const root = dir('inputs-other');
    initRepo(root);
    writeTree(root, { ...config, 'specs/README.md': 'An index.\n', 'specs/7_x.md': goodBrief(), 'old/6_y.md': goodBrief({ status: 'archived' }) });
    const { inputs, calls } = await list(root);
    heldTo(root, inputs, calls);
    // The index is a file of the directory, and read by nothing.
    expect(inputs.files.map((file) => file.path)).toEqual(['.spec-brief.json', 'old/6_y.md', 'spec-brief.json', 'specs/7_x.md']);
    expect(inputs.files[0]).toEqual({ path: '.spec-brief.json', sha256: null });
    expect(inputs.directories).toEqual([
      { path: 'old', entries: ['6_y.md'] },
      { path: 'specs', entries: ['7_x.md', 'README.md'] },
    ]);
  });

  it('holds the list to what it read under a configuration named, with no configuration and no git, and with the briefs at the root', async () => {
    const named = briefs('inputs-named', { 'team.json': '{}\n' });
    const one = await list(named, ['--config', 'team.json']);
    heldTo(named, one.inputs, one.calls);
    expect(one.inputs.files.map((file) => file.path)).toEqual(['briefs/001_a.md', 'briefs/003_c.md', 'briefs/archive/002_b.md', 'team.json']);
    const none = briefs('inputs-none', {});
    const two = await list(none, ['--no-config', '--no-git']);
    heldTo(none, two.inputs, two.calls);
    expect(two.inputs.files.map((file) => file.path)).toEqual(['briefs/001_a.md', 'briefs/003_c.md', 'briefs/archive/002_b.md']);
    const flat = dir('inputs-flat');
    writeTree(flat, { '.spec-brief.json': JSON.stringify({ briefs: '.', archive: 'done' }), '004_d.md': goodBrief(), 'done/005_e.md': goodBrief({ status: 'archived' }) });
    const three = await list(flat, ['--no-git']);
    heldTo(flat, three.inputs, three.calls);
    expect(three.inputs.directories).toEqual([
      { path: '.', entries: ['.spec-brief.json', '004_d.md'] },
      { path: 'done', entries: ['005_e.md'] },
    ]);
  });

  it('says the answer is not to be kept, with nothing listed, wherever it cannot name every input', async () => {
    const none: Listed = { keep: false, tool: VERSION, files: [], directories: [], git: null };
    // Run below the configuration's directory: the paths would be from a root the reader was not given.
    const configured = briefs('inputs-below');
    mkdirSync(join(configured, 'sub'));
    expect((await list(join(configured, 'sub'))).inputs).toEqual(none);
    // A configuration named in another directory, which is then the root.
    const elsewhere = dir('inputs-elsewhere');
    expect((await list(elsewhere, ['--config', join(configured, '.spec-brief.json'), '--no-git'])).inputs).toEqual(none);
    // No configuration: git says where the root is, from what it reads to find a work tree's top.
    const bare = briefs('inputs-bare', {});
    expect((await list(bare)).inputs).toEqual(none);
    expect((await list(bare, ['--no-config'])).inputs).toEqual(none);
    // Without git, a configuration not found was looked for above the root as well.
    expect((await list(bare, ['--no-git'])).inputs).toEqual(none);
    // An archive that is not there is a directory the list has no way to name as not there.
    const unarchived = dir('inputs-no-archive');
    writeTree(unarchived, { '.spec-brief.json': '{}\n', 'briefs/001_a.md': goodBrief() });
    expect((await list(unarchived, ['--no-git'])).inputs).toEqual(none);
  });
});

describe('what an engine can name of what it read', () => {
  const nothing = { keep: false, files: [], directories: [], git: null };

  it('names nothing it did not read from the disk itself, or after git or a plugin was asked', async () => {
    const root = briefs('inputs-engine');
    const opened = { cwd: root, needsGit: false } as const;
    expect((await BriefEngine.open(opened)).inputs().keep).toBe(true);
    // Read from a filesystem of the caller's, which tells it nothing.
    expect((await BriefEngine.open({ ...opened, fs: new MemoryFileSystem({ 'briefs/001_a.md': goodBrief() }) })).inputs()).toEqual(nothing);
    // Opened for a caller that reads git, which is asked where the work tree's top is.
    expect((await BriefEngine.open({ cwd: root })).inputs()).toEqual(nothing);
    // Asked which files there are, or for its plugins.
    const linted = await BriefEngine.open(opened);
    await linted.repoFiles();
    expect(linted.inputs()).toEqual(nothing);
    const plugged = await BriefEngine.open(opened);
    await plugged.loadedPlugins();
    expect(plugged.inputs()).toEqual(nothing);
    // Made by its caller, not opened.
    const made = new BriefEngine({ root, config: plugged.config, configFile: null, fs: new MemoryFileSystem(), git: null });
    expect(made.inputs()).toEqual(nothing);
  });
});
