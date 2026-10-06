import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { Plan, Waiver } from '../src/archive.js';
import { BANNER_CLOSE, BANNER_OPEN } from '../src/brief.js';
import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/config.js';
import { BriefEngine, EngineError, isDate, today } from '../src/engine.js';
import { MemoryFileSystem } from '../src/fs.js';
import type { Git } from '../src/git.js';
import type { Plugin, WaiveContext } from '../src/lint.js';
import { asPlugin, asWaivers, exportsTarget, loadPlugins } from '../src/plugins.js';
import type { Finding } from '../src/types.js';
import { commitAll, goodBrief, initRepo, tempDir, writeTree } from './helpers.js';

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function memoryEngine(files: Record<string, string>, config = DEFAULT_CONFIG, git: Git | null = null): BriefEngine {
  return new BriefEngine({ root: '/virtual', config, configFile: null, fs: new MemoryFileSystem(files), git, plugins: [] });
}

describe('dates', () => {
  it('uses SOURCE_DATE_EPOCH when it is a number of seconds', () => {
    expect(today({ SOURCE_DATE_EPOCH: '1790208000' })).toBe('2026-09-24');
    expect(today({ SOURCE_DATE_EPOCH: 'soon' })).toBe(new Date().toISOString().slice(0, 10));
    expect(today({})).toBe(new Date().toISOString().slice(0, 10));
    // A number with anything before or after it is not a number of seconds.
    expect(today({ SOURCE_DATE_EPOCH: '1790208000s' })).toBe(new Date().toISOString().slice(0, 10));
    expect(today({ SOURCE_DATE_EPOCH: 's1790208000' })).toBe(new Date().toISOString().slice(0, 10));
  });

  it('accepts only real calendar dates', () => {
    expect(isDate('2026-09-24')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-9-24')).toBe(false);
    expect(isDate('yesterday')).toBe(false);
    // A year past 9999 with its month is ten characters too, and is not a date written YYYY-MM-DD.
    expect(isDate('+010000-01')).toBe(false);
  });

  it('says which kind of error it raises', () => {
    expect(String(new EngineError('invalid', 'no'))).toBe('EngineError: no');
  });
});

describe('an engine over memory', () => {
  it('refuses to be used before it has read the briefs', () => {
    expect(() => memoryEngine({}).corpus).toThrow('call load() first');
  });

  it('reads briefs by the configured file glob, skipping excluded names and other files', async () => {
    const config = resolveConfig({ exclude: ['00_*'] });
    const engine = memoryEngine(
      {
        'briefs/001_a.md': goodBrief(),
        'briefs/00_INDEX.md': '# index',
        'briefs/README.md': '# readme',
        'briefs/archive/002_b.md': goodBrief({ status: 'archived' }),
        'briefs/sub/003_c.md': goodBrief(),
      },
      config,
    );
    const corpus = await engine.load();
    expect(corpus.briefs.map((b) => [b.file, b.phase])).toEqual([
      ['briefs/001_a.md', 'live'],
      ['briefs/archive/002_b.md', 'archived'],
    ]);
    expect(await engine.repoFiles()).toHaveLength(5);
  });

  it('reads briefs from the root when that is where they live', async () => {
    const engine = memoryEngine({ '001_a.md': goodBrief(), 'done/002_b.md': goodBrief({ status: 'archived' }) }, resolveConfig({ briefs: '.', archive: 'done' }));
    expect((await engine.load()).briefs.map((b) => b.file)).toEqual(['001_a.md', 'done/002_b.md']);
  });

  it('finds one brief, and says why when it cannot', async () => {
    const engine = memoryEngine({ 'briefs/001_a.md': goodBrief(), 'briefs/001_b.md': goodBrief() });
    await engine.load();
    expect(() => engine.find('9')).toThrow(new EngineError('not-found', 'no brief is named "9"'));
    expect(() => engine.find('1')).toThrow(new EngineError('ambiguous', '"1" names 2 briefs: briefs/001_a.md, briefs/001_b.md'));
    expect(engine.find('001_b.md').file).toBe('briefs/001_b.md');
  });

  it('refuses to report on a briefs directory that is not there, and reports on one that is empty', async () => {
    const missing = memoryEngine({ 'elsewhere/001_a.md': goodBrief() });
    await missing.load();
    expect(() => missing.requireBriefs()).toThrow(
      new EngineError('not-found', 'briefs/ does not exist; run "spec-brief init", or set "briefs" in the configuration'),
    );
    const empty = memoryEngine({ 'briefs/notes.txt': '' });
    expect((await empty.load()).briefs).toEqual([]);
    expect(() => empty.requireBriefs()).not.toThrow();
  });

  it('reads no brief from a file that is gone between the listing and the read', async () => {
    const fs = new MemoryFileSystem({ 'briefs/001_a.md': goodBrief(), 'briefs/002_b.md': goodBrief() });
    const read = fs.read.bind(fs);
    fs.read = (path) => (path === 'briefs/002_b.md' ? Promise.resolve(null) : read(path));
    const engine = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs, git: null, plugins: [] });
    expect((await engine.load()).briefs.map((b) => b.file)).toEqual(['briefs/001_a.md']);
  });

  it('lints all briefs or the ones named, and knows which are ready', async () => {
    const engine = memoryEngine({
      'briefs/001_a.md': goodBrief({ dependsOn: '[002]' }),
      'briefs/002_b.md': goodBrief().replace('# A brief\n', ''),
    });
    await engine.load();
    expect((await engine.lint()).map((f) => f.file)).toEqual(['briefs/002_b.md']);
    expect(await engine.lint(['1'])).toEqual([]);
    expect(engine.ready().map((b) => b.id)).toEqual(['002']);
    expect(engine.waitingOn(engine.find('1'))).toEqual(['002']);
    const { findings } = await engine.collisions();
    expect(findings).toEqual([]);
  });

  it('treats an unreadable tree as unknown rather than empty', async () => {
    const fs = new MemoryFileSystem({});
    fs.walk = () => Promise.reject(new Error('denied'));
    const engine = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs, git: null, plugins: [] });
    expect(await engine.repoFiles()).toBeNull();
  });

  it('archives and reopens, and refuses to apply a refused plan', async () => {
    const files = { 'briefs/001_a.md': goodBrief(), 'briefs/002_b.md': goodBrief({ status: 'draft' }) };
    const engine = memoryEngine(files);
    await engine.load();
    const plan = await engine.planArchive('1', { date: '2026-09-24' });
    await engine.apply(plan);
    expect(engine.corpus.archived.map((b) => b.file)).toEqual(['briefs/archive/001_a.md']);
    // A plan with nothing left to do changes nothing, and nothing is read again.
    const archived = engine.corpus;
    await engine.apply(await engine.planArchive('1', { date: '2026-09-24' }));
    expect(engine.corpus).toBe(archived);
    const refused = await engine.planArchive('2', { date: '2026-09-24' });
    await expect(engine.apply(refused)).rejects.toThrow(
      new EngineError('refused', 'archive of briefs/002_b.md is refused: is a draft, and a draft has not been executed'),
    );
    await engine.apply(engine.planUnarchive('1'));
    expect(engine.corpus.live.map((b) => b.file)).toEqual(['briefs/001_a.md', 'briefs/002_b.md']);
    await expect(engine.planArchive('1', { date: '24/09/2026' })).rejects.toThrow(new EngineError('invalid', '"24/09/2026" is not a date written YYYY-MM-DD'));
    await expect(engine.planArchive('1', { noGit: true, commit: 'HEAD' })).rejects.toThrow(
      new EngineError('invalid', 'a commit or a base needs git; drop --no-git, or drop --commit and --base'),
    );
    // A round with no summary, pull request or commit has a banner without their sentences.
    expect((await engine.planArchive('1')).banner).toEqual([
      BANNER_OPEN,
      `> **Archived ${today()}.**`,
      '> The body below describes the tree before execution and is not maintained.',
      BANNER_CLOSE,
    ]);
  });

  it('asks git for the commit, the diff from the merge base, the tree and the remote', async () => {
    const calls: string[] = [];
    const git: Git = {
      commit: (rev) => {
        calls.push(`commit ${rev}`);
        return Promise.resolve(rev === 'missing' ? null : { sha: '1234567890ab', author: 'A', date: '2026-09-24T00:00:00Z' });
      },
      mergeBase: (a, b) => {
        calls.push(`merge-base ${a} ${b}`);
        return Promise.resolve(a === 'orphan' || a === 'missing' ? null : 'base0');
      },
      changes: (from, to) => {
        calls.push(`changes ${from ?? 'parent'} ${to}`);
        return Promise.resolve([{ path: 'src/a.ts', insertions: 2, deletions: 1 }]);
      },
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve(['src/a.ts']),
      remoteUrl: () => Promise.resolve('git@github.com:o/r.git'),
    };
    const engine = memoryEngine({ 'briefs/001_a.md': goodBrief() }, DEFAULT_CONFIG, git);
    await engine.load();
    // The tree is the one git sees, not the one on the disk.
    expect(await engine.repoFiles()).toEqual(['src/a.ts']);
    const plan = await engine.planArchive('1', { base: 'main', pr: 3, date: '2026-09-24' });
    expect(calls).toEqual(['commit HEAD', 'merge-base main 1234567890ab', 'changes base0 1234567890ab']);
    expect(plan.banner).toContain('> Merged in pull request [#3](https://github.com/o/r/pull/3).');
    expect(plan.banner).toContain('> Recorded at commit `1234567`: 1 file changed, +2 \u22121.');
    calls.length = 0;
    await engine.planArchive('1', { base: 'orphan', commit: 'v1', date: '2026-09-24' });
    expect(calls).toEqual(['commit v1', 'merge-base orphan 1234567890ab', 'commit orphan', 'changes orphan 1234567890ab']);
    // A base that names nothing is a typo, reported as one rather than as a diff git could not make.
    calls.length = 0;
    await expect(engine.planArchive('1', { base: 'missing', commit: 'v1', date: '2026-09-24' })).rejects.toThrow(
      new EngineError('not-found', 'the base "missing" names no commit; check --base and "archiving.base"'),
    );
    expect(calls).toEqual(['commit v1', 'merge-base missing 1234567890ab', 'commit missing']);
    calls.length = 0;
    await engine.planArchive('1', { commit: 'v1', date: '2026-09-24' });
    expect(calls).toEqual(['commit v1', 'changes parent 1234567890ab']);
    calls.length = 0;
    await engine.planArchive('1', { date: '2026-09-24' });
    expect(calls).toEqual([]);
    await expect(engine.planArchive('1', { commit: 'missing' })).rejects.toThrow(new EngineError('not-found', '"missing" names no commit'));
    const configured = memoryEngine({ 'briefs/001_a.md': goodBrief() }, resolveConfig({ archiving: { base: 'trunk' } }), git);
    await configured.load();
    calls.length = 0;
    await configured.planArchive('1', { date: '2026-09-24', noGit: true });
    expect(calls).toEqual([]);
    const pr = await configured.planArchive('1', { date: '2026-09-24', noGit: true, pr: 9 });
    expect(pr.banner).toContain('> Merged in pull request #9.');
  });

  it('creates a brief with the next free id, and refuses what it cannot create', async () => {
    const engine = memoryEngine({ 'briefs/archive/007_old.md': goodBrief({ status: 'archived' }) });
    await engine.load();
    const created = await engine.create({ title: '  Split the auth module ', date: '2026-09-24', type: 'refactor', wave: 2, dependsOn: ['007'] });
    expect(created.file).toBe('briefs/008_split-the-auth-module.md');
    expect(created.content).toContain('status: draft\ndate: 2026-09-24\ntype: refactor\nwave: 2\ndependsOn: ["007"]\n');
    expect(engine.corpus.live.map((b) => b.id)).toEqual(['008']);
    await expect(engine.create({ title: ' ' })).rejects.toThrow(new EngineError('invalid', 'a brief needs a title'));
    await expect(engine.create({ title: 'x', id: '008' })).rejects.toThrow(new EngineError('exists', 'the id "008" is taken'));
    await expect(engine.create({ title: 'x', id: 'a b' })).rejects.toThrow(new EngineError('invalid', '"a b" cannot be an id: no whitespace, slashes or "_"'));
    await expect(engine.create({ title: 'x', id: 'a_b' })).rejects.toThrow('cannot be an id');
    await expect(engine.create({ title: 'x', type: 'epic' })).rejects.toThrow(
      new EngineError('invalid', '"epic" is not a brief type here; use one of feature, defect, refactor, chore'),
    );
    await expect(engine.create({ title: 'x', date: 'soon' })).rejects.toThrow(new EngineError('invalid', '"soon" is not a date written YYYY-MM-DD'));
    await expect(engine.create({ title: '!!!', id: '009', date: '2026-09-24' })).resolves.toEqual(expect.objectContaining({ file: 'briefs/009.md' }));
    await expect(engine.create({ title: '!!!', id: '010', date: '2026-09-24' })).resolves.toEqual(expect.objectContaining({ file: 'briefs/010.md' }));
    await expect(engine.create({ title: 'y', id: '011', date: '2026-09-24' })).resolves.toBeDefined();
    await expect(engine.create({ title: 'y', id: '12', date: '2026-09-24' })).resolves.toBeDefined();
    const clash = memoryEngine({ 'briefs/001_y.md': 'not a brief anyone reads' }, resolveConfig({ files: 'x*.md' }));
    await clash.load();
    await expect(clash.create({ title: 'y', id: '001', date: '2026-09-24' })).rejects.toThrow(new EngineError('exists', 'briefs/001_y.md already exists'));
    const typeless = memoryEngine({}, resolveConfig({ types: {} }));
    await typeless.load();
    await expect(typeless.create({ title: 'x', type: 't' })).rejects.toThrow('use one of (none)');
  });

  it('takes an id for taken when a brief has it, not when a file only bears the name', async () => {
    // Where ids are declared, a brief that declares none has none, whatever its file is called.
    const engine = memoryEngine({ 'briefs/notes.md': goodBrief() }, resolveConfig({ files: '*.md', id: { source: 'frontmatter' } }));
    await engine.load();
    expect(engine.corpus.briefs.map((b) => [b.name, b.id])).toEqual([['notes.md', null]]);
    const created = await engine.create({ title: 'Other', id: 'notes.md', date: '2026-09-24' });
    expect(created.file).toBe('briefs/other.md');
    await expect(engine.create({ title: 'Again', id: 'notes.md', date: '2026-09-24' })).rejects.toThrow(new EngineError('exists', 'the id "notes.md" is taken'));
  });

  it('allocates no id where the ids are not numbers', async () => {
    const engine = memoryEngine({ 'briefs/B-1_x.md': goodBrief() }, resolveConfig({ files: '*.md' }));
    await engine.load();
    await expect(engine.create({ title: 'x' })).rejects.toThrow(new EngineError('invalid', 'the ids here are not numbers, so there is no next one; pass --id'));
  });

  it('fills a configured template, and refuses a template that is not there', async () => {
    const engine = memoryEngine({ 't.md': '# {id}: {title} ({type}{wave}) {status} {date} {other}\n' }, resolveConfig({ template: 't.md' }));
    await engine.load();
    const created = await engine.create({ title: 'T', date: '2026-09-24', wave: 1 });
    expect(created.content).toBe('# 001: T (1) draft 2026-09-24 {other}\n');
    const missing = memoryEngine({}, resolveConfig({ template: 'gone.md' }));
    await missing.load();
    await expect(missing.create({ title: 'x' })).rejects.toThrow(new EngineError('not-found', 'the template gone.md does not exist'));
  });
});

describe('opening a repository', () => {
  it('opens the repository the process runs in when given no directory', async () => {
    const engine = await BriefEngine.open({ git: null });
    expect(engine.configFile).toBe('.spec-brief.json');
    expect(engine.corpus.live.length).toBeGreaterThan(0);
  });

  it('finds the configuration above the working directory and takes its directory as the root', async () => {
    const root = dir('open');
    initRepo(root);
    writeTree(root, {
      '.spec-brief.json': JSON.stringify({ briefs: 'specs' }),
      'specs/001_a.md': goodBrief(),
      'deep/er/file.txt': '',
    });
    commitAll(root, 'init');
    const engine = await BriefEngine.open({ cwd: join(root, 'deep', 'er') });
    expect(engine.root).toBe(root);
    expect(engine.configFile).toBe('.spec-brief.json');
    expect(engine.config.archive).toBe('specs/archive');
    expect(engine.git).not.toBeNull();
    expect(engine.corpus.live.map((b) => b.id)).toEqual(['001']);
    expect((await engine.repoFiles())?.sort()).toEqual(['.spec-brief.json', 'deep/er/file.txt', 'specs/001_a.md']);
  });

  it('uses an explicit file, the defaults on request, and no git when told', async () => {
    const root = dir('open-explicit');
    writeTree(root, { 'conf/b.json': JSON.stringify({ briefs: 'x' }), 'briefs/001_a.md': goodBrief() });
    const explicit = await BriefEngine.open({ cwd: root, config: 'conf/b.json', git: null });
    expect(explicit.root).toBe(join(root, 'conf'));
    expect(explicit.config.briefs).toBe('x');
    expect(explicit.configFile).toBe('b.json');
    const defaults = await BriefEngine.open({ cwd: root, noConfig: true, git: null, fs: new MemoryFileSystem({ 'briefs/001_a.md': goodBrief() }) });
    expect(defaults.configFile).toBeNull();
    expect(defaults.corpus.briefs).toHaveLength(1);
    await expect(BriefEngine.open({ cwd: root, config: 'missing.json', git: null })).rejects.toThrow(
      new EngineError('not-found', `${join(root, 'missing.json')} does not exist`),
    );
    writeFileSync(join(root, 'bad.json'), '{"briefs": 1}');
    await expect(BriefEngine.open({ cwd: root, config: 'bad.json' })).rejects.toBeInstanceOf(ConfigError);
  });

  it('uses the defaults where a configuration is there to be found, when told to', async () => {
    const root = dir('open-no-config');
    writeTree(root, { '.spec-brief.json': JSON.stringify({ briefs: 'specs' }), 'specs/001_a.md': goodBrief(), 'briefs/002_b.md': goodBrief() });
    const engine = await BriefEngine.open({ cwd: root, noConfig: true, git: null });
    expect(engine.configFile).toBeNull();
    expect(engine.corpus.live.map((b) => b.id)).toEqual(['002']);
  });

  it('leaves git out of finding the root as well, and takes a git it is handed', async () => {
    const root = dir('open-told');
    initRepo(root);
    writeTree(root, { 'sub/briefs/001_a.md': goodBrief() });
    const without = await BriefEngine.open({ cwd: join(root, 'sub'), noConfig: true, git: null });
    expect(without.root).toBe(join(root, 'sub'));
    expect(without.git).toBeNull();
    const handed: Git = {
      commit: () => Promise.resolve(null),
      mergeBase: () => Promise.resolve(null),
      changes: () => Promise.resolve([]),
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve([]),
      remoteUrl: () => Promise.resolve(null),
    };
    const given = await BriefEngine.open({ cwd: join(root, 'sub'), noConfig: true, git: handed });
    expect(given.git).toBe(handed);
    expect(given.root).toBe(root);
  });

  it('leaves git out for a configuration beside the work tree, and keeps it in a directory inside it named with two dots', async () => {
    // Outside is the parent, "..", or a path through it, "../conf". A
    // directory inside the work tree may be called "..drafts": taken for a
    // path out, it lost git, and archival there its dirty-tree and scope checks.
    const root = dir('open-beside');
    initRepo(join(root, 'repo'));
    writeTree(root, { 'conf/c.json': '{}', 'repo/..drafts/.spec-brief.json': '{}', 'repo/..drafts/briefs/001_a.md': goodBrief() });
    const beside = await BriefEngine.open({ cwd: join(root, 'repo'), config: '../conf/c.json' });
    expect(beside.root).toBe(join(root, 'conf'));
    expect(beside.git).toBeNull();
    const inside = await BriefEngine.open({ cwd: join(root, 'repo', '..drafts') });
    expect(inside.root).toBe(join(root, 'repo', '..drafts'));
    expect(inside.git).not.toBeNull();
  });

  it('runs without git outside a repository, walking the files instead', async () => {
    const root = dir('open-plain');
    writeTree(root, { '.spec-brief.json': '{}', 'briefs/001_a.md': goodBrief(), 'node_modules/x.js': '' });
    const engine = await BriefEngine.open({ cwd: root });
    expect(engine.root).toBe(root);
    expect(engine.git).toBeNull();
    expect(await engine.repoFiles()).toEqual(['.spec-brief.json', 'briefs/001_a.md']);
  });

  it('keeps git when the configuration sits below the top of the work tree', async () => {
    const root = dir('open-nested');
    initRepo(root);
    writeTree(root, { 'sub/.spec-brief.json': '{}', 'sub/briefs/001_a.md': goodBrief() });
    const engine = await BriefEngine.open({ cwd: join(root, 'sub') });
    expect(engine.root).toBe(join(root, 'sub'));
    expect(engine.git).not.toBeNull();
  });

  it('names the root as git names the work tree when it is reached through a link', async () => {
    // Git reports the top of the work tree with links followed and, on Windows,
    // short names such as RUNNER~1 expanded; a root named otherwise compared as
    // outside it, and archival lost its dirty-tree and scope checks.
    const real = dir('open-link');
    initRepo(real);
    writeTree(real, { '.spec-brief.json': '{}', 'briefs/001_a.md': goodBrief(), 'sub/x.txt': '' });
    const link = join(dir('open-link-alias'), 'repo');
    symlinkSync(real, link, 'junction');
    const found = await BriefEngine.open({ cwd: join(link, 'sub') });
    expect(found.root).toBe(real);
    expect(found.git).not.toBeNull();
    const explicit = await BriefEngine.open({ cwd: link, config: '.spec-brief.json' });
    expect(explicit.root).toBe(real);
    expect(explicit.configFile).toBe('.spec-brief.json');
    expect(explicit.git).not.toBeNull();
  });

  it('leaves git out when the configuration sits outside the work tree it was found from', async () => {
    const root = dir('open-outside');
    initRepo(join(root, 'repo'));
    writeTree(root, { 'conf.json': '{}' });
    const engine = await BriefEngine.open({ cwd: join(root, 'repo'), config: '../conf.json' });
    expect(engine.root).toBe(root);
    expect(engine.git).toBeNull();
  });

  it('archives through real git and the real filesystem, and the result lints clean', async () => {
    const root = dir('open-archive');
    initRepo(root);
    writeTree(root, {
      '.spec-brief.json': '{}',
      'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**]' }),
      'src/a.ts': 'one\n',
    });
    commitAll(root, 'init');
    writeTree(root, { 'src/a.ts': 'two\n' });
    commitAll(root, 'work');
    const engine = await BriefEngine.open({ cwd: root });
    const plan = await engine.planArchive('1', { commit: 'HEAD', pr: 5, date: '2026-09-24' });
    expect(plan.blocking).toEqual([]);
    expect(plan.changes).toEqual([{ path: 'src/a.ts', insertions: 1, deletions: 1 }]);
    await engine.apply(plan);
    const archived = readFileSync(join(root, 'briefs', 'archive', '001_a.md'), 'utf8');
    expect(archived).toContain('> Recorded at commit `');
    expect(await engine.lint()).toEqual([]);
  });

  it('does not pass the scope of a round archived on the branch it merged into', async () => {
    const root = dir('open-merged');
    initRepo(root);
    writeTree(root, {
      '.spec-brief.json': JSON.stringify({ archiving: { base: 'main' } }),
      'briefs/001_a.md': goodBrief({ affectedFiles: '[src/ok.ts]', protectedFiles: '[src/locked.ts]' }),
      'src/locked.ts': 'one\n',
    });
    commitAll(root, 'init');
    writeTree(root, { 'src/locked.ts': 'two\n' });
    commitAll(root, 'work');
    const engine = await BriefEngine.open({ cwd: root });
    const plan = await engine.planArchive('1', { date: '2026-09-24' });
    expect(plan.blocking).toEqual([]);
    expect(plan.warnings.map((f) => [f.rule, f.message])).toEqual([
      ['scope-unmeasured', expect.stringMatching(/^protectedFiles and affectedFiles went unchecked: [0-9a-f]{7} is already in main, /)],
    ]);
    const strict = await engine.planArchive('1', { date: '2026-09-24', strict: true });
    expect(strict.blocking.map((f) => f.rule)).toEqual(['scope-unmeasured']);
    // Named, the commit is measured against its parent, and the protected file is caught.
    const named = await engine.planArchive('1', { date: '2026-09-24', commit: 'HEAD', base: 'HEAD~1' });
    expect(named.blocking.map((f) => f.rule)).toEqual(['protected-file']);
    expect(named.warnings).toEqual([]);
  });
});

describe('plugins', () => {
  it('loads a module by path, a default export or a factory, with its options', async () => {
    const root = dir('plugins');
    writeTree(root, {
      'object.mjs': "export default { name: 'obj', rules: [{ id: 'r', description: 'd', severity: 'note', check: () => [] }] };",
      'factory.mjs': "export default (options) => ({ name: 'fac-' + options.suffix, rules: [] });",
      'named.mjs': "export const plugin = { name: 'named', rules: [] };",
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', main: 'index.js' }),
      'node_modules/pkg/index.js': "module.exports = { name: 'pkg', rules: [] };",
      'node_modules/nulled/package.json': JSON.stringify({ name: 'nulled', exports: null, main: 'index.js' }),
      'node_modules/nulled/index.js': "module.exports = { name: 'nulled', rules: [] };",
      'package.json': '{}',
    });
    // "exports": null is a package that declares none, and resolves by its "main".
    expect((await loadPlugins([{ module: 'nulled', options: undefined }], root)).map((p) => p.name)).toEqual(['nulled']);
    const plugins = await loadPlugins(
      [
        { module: './object.mjs', options: undefined },
        { module: join(root, 'factory.mjs'), options: { suffix: 'x' } },
        { module: './named.mjs', options: 1 },
        { module: 'pkg', options: undefined },
      ],
      root,
    );
    expect(plugins.map((p) => p.name)).toEqual(['obj', 'fac-x', 'named', 'pkg']);
    expect(plugins[2]?.options).toBe(1);
  });

  it('loads a package that exports only for import, found from the root or above it', async () => {
    const root = dir('plugins-esm');
    const fixture = join('tests', 'fixtures', 'esm-only-plugin');
    cpSync(fixture, join(root, 'node_modules', 'esm-only-plugin'), { recursive: true });
    cpSync(fixture, join(root, 'node_modules', '@acme', 'esm-only-plugin'), { recursive: true });
    mkdirSync(join(root, 'sub'));
    const found = await loadPlugins(
      [
        { module: 'esm-only-plugin', options: undefined },
        { module: 'esm-only-plugin/extra', options: { suffix: 'x' } },
      ],
      join(root, 'sub'),
    );
    expect(found.map((p) => p.name)).toEqual(['esm-only', 'esm-extra-x']);
    expect((await loadPlugins([{ module: '@acme/esm-only-plugin', options: undefined }], root)).map((p) => p.name)).toEqual(['esm-only']);
    // A file where a package's directory would be is no package: the search goes on above it.
    writeTree(root, { 'sub/node_modules/esm-only-plugin': '' });
    expect((await loadPlugins([{ module: 'esm-only-plugin', options: undefined }], join(root, 'sub'))).map((p) => p.name)).toEqual(['esm-only']);
    await expect(loadPlugins([{ module: 'esm-only-plugin/missing', options: undefined }], root)).rejects.toThrow(
      'esm-only-plugin/missing: could not be loaded: esm-only-plugin exports no "./missing" for import',
    );
    // A package.json that cannot be read as JSON is reported as that, not searched past.
    writeTree(root, { 'node_modules/broken/package.json': '{' });
    await expect(loadPlugins([{ module: 'broken', options: undefined }], root)).rejects.toThrow(/^broken: could not be loaded: .* in JSON at /);
    await expect(loadPlugins([{ module: 'no-such-plugin-anywhere', options: undefined }], root)).rejects.toThrow(
      "no-such-plugin-anywhere: could not be loaded: Cannot find module 'no-such-plugin-anywhere'",
    );
  });

  it('reads "exports" under the conditions of an import', () => {
    expect(exportsTarget('./i.js', '.')).toBe('./i.js');
    expect(exportsTarget('./i.js', './x')).toBeNull();
    expect(exportsTarget(null, '.')).toBeNull();
    expect(exportsTarget({ require: './r.cjs', import: './i.mjs' }, '.')).toBe('./i.mjs');
    expect(exportsTarget({ node: { import: './n.mjs' }, default: './d.js' }, '.')).toBe('./n.mjs');
    expect(exportsTarget({ node: { require: './r.cjs' }, default: './d.js' }, '.')).toBe('./d.js');
    expect(exportsTarget({ browser: './b.js', default: './d.js' }, '.')).toBe('./d.js');
    expect(exportsTarget({ require: './r.cjs' }, '.')).toBeNull();
    expect(exportsTarget({ import: null, default: './d.js' }, '.')).toBeNull();
    expect(exportsTarget({ '.': ['lib/bad.js', './good.js'] }, '.')).toBe('./good.js');
    expect(exportsTarget({ '.': [{ require: './r.cjs' }] }, '.')).toBeNull();
    expect(exportsTarget({ '.': './i.js', import: './x.js' }, '.')).toBeNull();
    expect(exportsTarget({ 'module-sync': './m.js', default: './d.js' }, '.')).toBe('./m.js');
    // A target that is no path, list or map refuses the subpath, as Node does: it is not passed over for the next condition.
    expect(exportsTarget({ import: 5, default: './d.js' }, '.')).toBeNull();
    // A key with no star matches only itself.
    expect(exportsTarget({ './a': './a.js' }, './x./a')).toBeNull();
    // The longer prefix wins over the longer key, in either order.
    expect(exportsTarget({ './ab*': './long/*.js', './a*xyz': './short/*.js' }, './abxyz')).toBe('./long/xyz.js');
    expect(exportsTarget({ './a*xyz': './short/*.js', './ab*': './long/*.js' }, './abxyz')).toBe('./long/xyz.js');
    const map = { '.': './i.js', './a': { import: './a.js' }, './p/*': './dist/p/*.js', './p/x/*': './x/*.js', './hidden/*': null, './raw': './raw*.js' };
    expect(exportsTarget(map, '.')).toBe('./i.js');
    expect(exportsTarget(map, './a')).toBe('./a.js');
    expect(exportsTarget(map, './p/y')).toBe('./dist/p/y.js');
    expect(exportsTarget(map, './p/x/z')).toBe('./x/z.js');
    expect(exportsTarget(map, './hidden/q')).toBeNull();
    expect(exportsTarget(map, './raw')).toBe('./raw*.js');
    expect(exportsTarget(map, './b')).toBeNull();
    // Of two patterns with one prefix the longer key wins, and a pattern needs a match.
    expect(exportsTarget({ './a*': './y/*.js', './a*b': './x/*.js' }, './a1b')).toBe('./x/1.js');
    expect(exportsTarget({ './a*b': './x/*.js', './a*': './y/*.js' }, './a1b')).toBe('./x/1.js');
    expect(exportsTarget({ './p/x/*': './x/*.js', './p/*': './dist/p/*.js' }, './p/x/z')).toBe('./x/z.js');
    expect(exportsTarget({ './a*': './y/*.js' }, './a')).toBeNull();
    expect(exportsTarget({ './a*b*': './z.js' }, './a1b2')).toBeNull();
    // A target may not leave the package or reach into another.
    expect(exportsTarget({ './*': './*.js' }, './../x')).toBeNull();
    expect(exportsTarget({ './*': './*' }, './node_modules/x')).toBeNull();
    expect(exportsTarget({ './*': './*' }, './a/./b')).toBeNull();
    // A backslash separates segments too: Windows' join climbs through it.
    expect(exportsTarget({ './*': './lib/*.js' }, './..\\..\\..\\outside\\evil')).toBeNull();
    expect(exportsTarget({ './*': './*' }, './a\\.\\b')).toBeNull();
    expect(exportsTarget({ './*': './*' }, './a\\node_modules\\b')).toBeNull();
    expect(exportsTarget({ './*': './*' }, './NODE_MODULES/x')).toBeNull();
    expect(exportsTarget({ '.': './lib\\..\\..\\x.js' }, '.')).toBeNull();
    expect(exportsTarget({ './*': './lib/*.js' }, './ok')).toBe('./lib/ok.js');
    expect(exportsTarget({ './*': './lib/*.js' }, './..x/y')).toBe('./lib/..x/y.js');
  });

  it('refuses a package subpath that climbs out of node_modules with backslashes, before loading anything', async () => {
    const root = dir('plugins-backslash');
    writeTree(root, {
      'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', type: 'module', exports: { './*': './lib/*.js' } }),
      'node_modules/pkg/lib/ok.js': "export default { name: 'inside', rules: [] };",
      'outside/evil.js': "export default { name: 'outside', rules: [] };",
    });
    const climbing = 'pkg/..\\..\\..\\outside\\evil';
    await expect(loadPlugins([{ module: climbing, options: undefined }], root)).rejects.toThrow(`pkg exports no "./..\\..\\..\\outside\\evil" for import`);
    expect((await loadPlugins([{ module: 'pkg/ok', options: undefined }], root)).map((p) => p.name)).toEqual(['inside']);
  });

  it('refuses a module that does not load, that exports no plugin, or that repeats a name', async () => {
    const root = dir('plugins-bad');
    writeTree(root, {
      'none.mjs': 'export const other = 1;',
      'dup.mjs': "export default { name: 'dup', rules: [] };",
    });
    // A path stands for a file under the root, and the refusal names that file.
    await expect(loadPlugins([{ module: './gone.mjs', options: undefined }], root)).rejects.toThrow(
      /^\.\/gone\.mjs: could not be loaded: Cannot find module '[^']*plugins-bad-[^']*[\\/]gone\.mjs'/,
    );
    await expect(loadPlugins([{ module: './none.mjs', options: undefined }], root)).rejects.toThrow('does not export a plugin');
    await expect(
      loadPlugins(
        [
          { module: './dup.mjs', options: undefined },
          { module: './dup.mjs', options: undefined },
        ],
        root,
      ),
    ).rejects.toThrow(new ConfigError('plugins', ['two plugins are named "dup"']));
  });

  it('checks the shape of what a module exports', () => {
    expect(() => asPlugin(null, 'm', undefined)).toThrow('does not export a plugin');
    expect(() => asPlugin({ name: 'bad name', rules: {} }, 'm', undefined)).toThrow('"name" must be a plain identifier; "rules" must be a list');
    const bad = [{ id: 'Upper', description: 'd', severity: 'note', check: () => [] }, { id: 'ok', description: 'd', severity: 'loud', check: () => [] }, 'x'];
    expect(() => asPlugin({ name: 'p', rules: bad }, 'm', undefined)).toThrow(/rules\[0\].*rules\[1\].*rules\[2\]/);
    // Each part of a rule is needed, and each of the four severities is one.
    const rule = { id: 'ok', description: 'd', severity: 'note', check: (): never[] => [] };
    const lacking = [null, undefined, { ...rule, id: undefined }, { ...rule, id: 5 }, { ...rule, id: 'two words' }, { ...rule, description: undefined }, { ...rule, severity: undefined }, { ...rule, check: undefined }];
    expect(() => asPlugin({ name: 'p', rules: lacking }, 'm', undefined)).toThrow(
      new ConfigError('m', lacking.map((_, i) => `rules[${i}] needs a lower-case "id", a "description", a "severity" and a "check" function`)),
    );
    expect(asPlugin({ name: 'p', rules: ['off', 'note', 'warning', 'error'].map((severity) => ({ ...rule, severity })) }, 'm', undefined).rules).toHaveLength(4);
    expect(() => asPlugin({ rules: [] }, 'm', undefined)).toThrow(new ConfigError('m', ['"name" must be a plain identifier']));
    expect(() => asPlugin({ name: 5, rules: [] }, 'm', undefined)).toThrow(new ConfigError('m', ['"name" must be a plain identifier']));
    expect(asPlugin({ name: '@scope/p', rules: [] }, 'm', 2)).toEqual({ name: '@scope/p', rules: [], options: 2 });
    expect('waive' in asPlugin({ name: 'p', rules: [] }, 'm', undefined)).toBe(false);
    const waive = (): never[] => [];
    expect(asPlugin({ name: 'p', rules: [], waive }, 'm', undefined).waive).toBe(waive);
    expect(() => asPlugin({ name: 'p', rules: [], waive: 'yes' }, 'm', undefined)).toThrow(new ConfigError('m', ['"waive" must be a function']));
  });

  it('checks the shape of what a waive hook answers', () => {
    expect(asWaivers([{ rule: 'protected-file', path: 'a', reason: 'r', extra: 1 }], 'p')).toEqual([{ rule: 'protected-file', path: 'a', reason: 'r' }]);
    expect(asWaivers([], 'p')).toEqual([]);
    // A hook that falls off its end has found nothing to waive.
    expect(asWaivers(undefined, 'p')).toEqual([]);
    const refusal = new ConfigError('plugin "p"', ['"waive" must return a list of { rule, path, reason }, each a string']);
    for (const answer of [null, {}, [null], [undefined], ['x'], [{ rule: 'r', path: 'a' }], [{ rule: 'r', path: 1, reason: 'x' }], [{ rule: 1, path: 'a', reason: 'x' }]]) {
      expect(() => asWaivers(answer, 'p'), JSON.stringify(answer)).toThrow(refusal);
    }
  });

  it('asks a waive hook about the refusals it may lift, and turns what it lifts into notes', async () => {
    const asked: WaiveContext[] = [];
    const harness: Plugin = {
      name: 'harness',
      rules: [],
      waive: (context) => {
        asked.push(context);
        return [{ rule: 'protected-file', path: 'src/a.ts', reason: 'ruling R1 allows it' }];
      },
    };
    const silent: Plugin = { name: 'silent', rules: [] };
    const git: Git = {
      commit: () => Promise.resolve({ sha: '1234567890ab', author: 'A', date: '' }),
      mergeBase: () => Promise.resolve('base0'),
      changes: () => Promise.resolve(['src/a.ts', 'src/b.ts'].map((path) => ({ path, insertions: 1, deletions: 0 }))),
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve(['src/a.ts', 'src/b.ts']),
      remoteUrl: () => Promise.resolve(null),
    };
    const files = { 'briefs/001_a.md': goodBrief({ protectedFiles: '[src/a.ts, src/b.ts]' }) };
    const engine = new BriefEngine({ root: '/virtual', config: DEFAULT_CONFIG, configFile: null, fs: new MemoryFileSystem(files), git, plugins: [silent, harness] });
    await engine.load();
    const plan = await engine.planArchive('1', { base: 'main', date: '2026-09-26' });
    expect(plan.blocking.map((f) => [f.rule, f.path])).toEqual([['protected-file', 'src/b.ts']]);
    expect(plan.warnings.map((f) => [f.rule, f.severity, f.message])).toEqual([['waived', 'note', 'harness waives protected-file for src/a.ts: ruling R1 allows it']]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ root: '/virtual', brief: { id: '001', file: 'briefs/001_a.md', text: files['briefs/001_a.md'] }, base: 'main', commit: '1234567890ab' });
    expect(asked[0]?.findings.map((f) => [f.rule, f.path])).toEqual([
      ['protected-file', 'src/a.ts'],
      ['protected-file', 'src/b.ts'],
    ]);
    // Without a base, the context says so; with nothing to lift, the hook is not asked.
    const noBase = await engine.planArchive('1', { commit: 'HEAD', date: '2026-09-26' });
    expect(asked[1]).toMatchObject({ base: null, commit: '1234567890ab' });
    expect(noBase.blocking).toHaveLength(1);
    const calm = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs: new MemoryFileSystem({ 'briefs/001_a.md': goodBrief() }), git, plugins: [harness] });
    await calm.load();
    await calm.planArchive('1', { commit: 'HEAD', date: '2026-09-26' });
    expect(asked).toHaveLength(2);
    const draft = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs: new MemoryFileSystem({ 'briefs/001_a.md': goodBrief({ status: 'draft' }) }), git: null, plugins: [harness] });
    await draft.load();
    expect((await draft.planArchive('1', { date: '2026-09-26' })).blocking.map((f) => f.rule)).toEqual(['archive-draft']);
    expect(asked).toHaveLength(2);
  });

  it('stops the run when a waive hook throws or answers in the wrong shape', async () => {
    const git: Git = {
      commit: () => Promise.resolve({ sha: '1234567890ab', author: 'A', date: '' }),
      mergeBase: () => Promise.resolve(null),
      changes: () => Promise.resolve([{ path: 'src/a.ts', insertions: 1, deletions: 0 }]),
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve([]),
      remoteUrl: () => Promise.resolve(null),
    };
    const engineWith = async (waive: NonNullable<Plugin['waive']>): Promise<BriefEngine> => {
      const fs = new MemoryFileSystem({ 'briefs/001_a.md': goodBrief({ protectedFiles: '[src/a.ts]' }) });
      const engine = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs, git, plugins: [{ name: 'shaky', rules: [], waive }] });
      await engine.load();
      return engine;
    };
    const throwing = await engineWith(() => {
      throw new Error('no signers file');
    });
    await expect(throwing.planArchive('1', { commit: 'HEAD', date: '2026-09-26' })).rejects.toThrow(
      new ConfigError('plugin "shaky"', ['"waive" failed: no signers file']),
    );
    const rejecting = await engineWith(() => Promise.reject('down'));
    await expect(rejecting.planArchive('1', { commit: 'HEAD', date: '2026-09-26' })).rejects.toThrow('"waive" failed: down');
    const odd = await engineWith(() => [{ rule: 'protected-file' }] as never);
    await expect(odd.planArchive('1', { commit: 'HEAD', date: '2026-09-26' })).rejects.toThrow('"waive" must return a list');
  });

  it('ignores a waiver for a refusal that is not a plugin\'s to lift, with a warning that refuses under strict as any does', async () => {
    const git: Git = {
      commit: () => Promise.resolve({ sha: '1234567890ab', author: 'A', date: '' }),
      mergeBase: () => Promise.resolve(null),
      changes: () => Promise.resolve([{ path: 'src/a.ts', insertions: 1, deletions: 0 }]),
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve([]),
      remoteUrl: () => Promise.resolve(null),
    };
    const reaching: Plugin = { name: 'reaching', rules: [], waive: () => [{ rule: 'open-task', path: 'x', reason: 'r' }] };
    const fs = new MemoryFileSystem({ 'briefs/001_a.md': goodBrief({ protectedFiles: '[src/a.ts]' }) });
    const engine = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs, git, plugins: [reaching] });
    await engine.load();
    const lenient = await engine.planArchive('1', { commit: 'HEAD', date: '2026-09-26' });
    expect(lenient.blocking.map((f) => [f.rule, f.severity])).toEqual([['protected-file', 'error']]);
    expect(lenient.warnings.map((f) => [f.rule, f.severity])).toEqual([['waiver-ignored', 'warning']]);
    const strict = await engine.planArchive('1', { commit: 'HEAD', date: '2026-09-26', strict: true });
    expect(strict.blocking.map((f) => [f.rule, f.severity])).toEqual([
      ['protected-file', 'error'],
      ['waiver-ignored', 'error'],
    ]);
    expect(strict.warnings).toEqual([]);
  });

  describe('a waive hook that writes to what it is handed', () => {
    const git: Git = {
      commit: () => Promise.resolve({ sha: '1234567890ab', author: 'A', date: '' }),
      mergeBase: () => Promise.resolve(null),
      changes: () => Promise.resolve([{ path: 'src/a.ts', insertions: 1, deletions: 0 }]),
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve([]),
      remoteUrl: () => Promise.resolve(null),
    };
    // An open box and a changed protected file: two refusals, one a plugin may lift.
    const brief = goodBrief({ protectedFiles: '[src/a.ts]' }, ['', '- [ ] an open task nobody did', ''].join('\n'));
    const planWith = async (waive: NonNullable<Plugin['waive']>): Promise<Plan> => {
      const fs = new MemoryFileSystem({ 'briefs/001_a.md': brief });
      const engine = new BriefEngine({ root: '/v', config: DEFAULT_CONFIG, configFile: null, fs, git, plugins: [{ name: 'p', rules: [], waive }] });
      await engine.load();
      return engine.planArchive('1', { commit: 'HEAD', date: '2026-09-26' });
    };

    it('is handed a copy in which every finding is frozen', async () => {
      let seen: WaiveContext | undefined;
      const plan = await planWith((context) => {
        seen = context;
        return [];
      });
      expect(seen?.findings).not.toBe(plan.blocking);
      expect(seen?.findings).toEqual(plan.blocking);
      expect(Object.isFrozen(seen)).toBe(true);
      expect(Object.isFrozen(seen?.findings)).toBe(true);
      expect(seen?.findings.every((f) => Object.isFrozen(f))).toBe(true);
    });

    it('cannot drop a refusal: splicing the list stops the run, and the plan never saw it', async () => {
      const splice = (context: WaiveContext): [] => {
        (context.findings as Finding[]).splice(0, context.findings.length);
        return [];
      };
      await expect(planWith(splice)).rejects.toThrow(ConfigError);
      await expect(planWith(splice)).rejects.toThrow(/^plugin "p": "waive" failed: /);
    });

    it('cannot relabel a refusal it may not lift into one it may', async () => {
      // A strict hook, as every ES module is, throws on the write.
      const relabel = (context: WaiveContext): Waiver[] => {
        const task = context.findings.find((f) => f.rule === 'open-task') as { rule: string; path?: string };
        task.rule = 'protected-file';
        task.path = 'x';
        return [{ rule: 'protected-file', path: 'x', reason: 'r' }];
      };
      await expect(planWith(relabel)).rejects.toThrow(/^plugin "p": "waive" failed: /);
      // A sloppy one, as a CommonJS plugin may be, writes nothing, and its
      // waiver for the relabelled finding matches no refusal of the plan's.
      const sloppy = new Function(
        'context',
        "const task = context.findings.find((f) => f.rule === 'open-task'); task.rule = 'protected-file'; task.path = 'x'; return [{ rule: 'protected-file', path: 'x', reason: 'r' }];",
      ) as NonNullable<Plugin['waive']>;
      const plan = await planWith(sloppy);
      expect(plan.blocking.map((f) => [f.rule, f.path])).toEqual([
        ['open-task', undefined],
        ['protected-file', 'src/a.ts'],
      ]);
      expect(plan.warnings).toEqual([]);
    });

    it('that returns nothing waives nothing, and the run goes on', async () => {
      const plan = await planWith(() => undefined);
      expect(plan.blocking.map((f) => f.rule)).toEqual(['open-task', 'protected-file']);
      expect(plan.warnings).toEqual([]);
    });
  });

  it('loads a waiving plugin from a subpath of a scoped package, and the archive takes what it waives and refuses what it does not', async () => {
    const root = dir('plugins-waive');
    initRepo(root);
    cpSync(join('tests', 'fixtures', 'waiving-plugin'), join(root, 'node_modules', '@fixture', 'waiver'), { recursive: true });
    writeTree(root, {
      '.gitignore': 'node_modules/\n',
      '.spec-brief.json': JSON.stringify({ plugins: [{ module: '@fixture/waiver/spec-brief-plugin', options: { allow: ['src/a.ts'] } }] }),
      'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**]', protectedFiles: '[src/a.ts, src/b.ts]' }),
      'src/a.ts': 'a\n',
      'src/b.ts': 'b\n',
    });
    commitAll(root, 'start');
    writeTree(root, { 'src/a.ts': 'a2\n', 'src/b.ts': 'b2\n' });
    commitAll(root, 'the round');
    const engine = await BriefEngine.open({ cwd: root });
    const plan = await engine.planArchive('1', { commit: 'HEAD', date: '2026-09-26' });
    expect(plan.blocking.map((f) => [f.rule, f.path])).toEqual([['protected-file', 'src/b.ts']]);
    const sha = (await engine.git?.commit('HEAD'))?.sha.slice(0, 7);
    expect(plan.warnings.map((f) => f.message)).toEqual([`waiver waives protected-file for src/a.ts: allowed for 001 (briefs/001_a.md, read) at ${sha} from no base`]);
    const allowed = join(root, '.spec-brief.json');
    writeFileSync(allowed, JSON.stringify({ plugins: [{ module: '@fixture/waiver/spec-brief-plugin', options: { allow: ['src/a.ts', 'src/b.ts'] } }] }));
    const both = await BriefEngine.open({ cwd: root });
    const accepted = await both.planArchive('1', { commit: 'HEAD', date: '2026-09-26', allowDirty: true });
    expect(accepted.blocking).toEqual([]);
    expect(accepted.warnings.map((f) => [f.rule, f.path])).toEqual([
      ['waived', 'src/a.ts'],
      ['waived', 'src/b.ts'],
    ]);
  });

  it('runs a configured plugin inside lint', async () => {
    const root = dir('plugins-lint');
    writeTree(root, {
      '.spec-brief.json': JSON.stringify({ plugins: [{ module: './p.mjs', options: { word: 'Latest' } }] }),
      'p.mjs': [
        'export default (options) => ({',
        "  name: 'acme',",
        '  rules: [{',
        "    id: 'says-word', description: 'the brief says the word', severity: 'error',",
        "    check: ({ brief }) => brief.text.includes(options.word) ? [] : [{ line: 1, message: 'does not say ' + options.word }],",
        '  }],',
        '});',
      ].join('\n'),
      'briefs/001_a.md': goodBrief(),
    });
    const engine = await BriefEngine.open({ cwd: root, git: null });
    expect((await engine.lint()).map((f) => [f.rule, f.message])).toEqual([['acme/says-word', 'does not say Latest']]);
    expect(await engine.loadedPlugins()).toBe(await engine.loadedPlugins());
  });
});
