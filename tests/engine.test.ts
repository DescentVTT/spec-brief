import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ConfigError, DEFAULT_CONFIG, resolveConfig } from '../src/config.js';
import { BriefEngine, EngineError, isDate, today } from '../src/engine.js';
import { MemoryFileSystem } from '../src/fs.js';
import type { Git } from '../src/git.js';
import { asPlugin, exportsTarget, loadPlugins } from '../src/plugins.js';
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
  });

  it('accepts only real calendar dates', () => {
    expect(isDate('2026-09-24')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(isDate('2026-9-24')).toBe(false);
    expect(isDate('yesterday')).toBe(false);
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
    expect(() => engine.find('1')).toThrow('"1" names 2 briefs: briefs/001_a.md, briefs/001_b.md');
    expect(engine.find('001_b.md').file).toBe('briefs/001_b.md');
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
    await engine.apply(await engine.planArchive('1', { date: '2026-09-24' }));
    const refused = await engine.planArchive('2', { date: '2026-09-24' });
    await expect(engine.apply(refused)).rejects.toThrow('archive of briefs/002_b.md is refused: is a draft');
    await engine.apply(engine.planUnarchive('1'));
    expect(engine.corpus.live.map((b) => b.file)).toEqual(['briefs/001_a.md', 'briefs/002_b.md']);
    await expect(engine.planArchive('1', { date: '24/09/2026' })).rejects.toThrow('is not a date written YYYY-MM-DD');
    await expect(engine.planArchive('1', { noGit: true, commit: 'HEAD' })).rejects.toThrow('a commit or a base needs git');
    expect((await engine.planArchive('1')).banner[1]).toBe(`> **Archived ${today()}.**`);
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
    await expect(engine.planArchive('1', { commit: 'missing' })).rejects.toThrow('"missing" names no commit');
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
    await expect(engine.create({ title: ' ' })).rejects.toThrow('a brief needs a title');
    await expect(engine.create({ title: 'x', id: '008' })).rejects.toThrow('the id "008" is taken');
    await expect(engine.create({ title: 'x', id: 'a b' })).rejects.toThrow('cannot be an id');
    await expect(engine.create({ title: 'x', id: 'a_b' })).rejects.toThrow('cannot be an id');
    await expect(engine.create({ title: 'x', type: 'epic' })).rejects.toThrow('"epic" is not a brief type here; use one of feature, defect, refactor, chore');
    await expect(engine.create({ title: 'x', date: 'soon' })).rejects.toThrow('is not a date');
    await expect(engine.create({ title: '!!!', id: '009', date: '2026-09-24' })).resolves.toEqual(expect.objectContaining({ file: 'briefs/009.md' }));
    await expect(engine.create({ title: '!!!', id: '010', date: '2026-09-24' })).resolves.toEqual(expect.objectContaining({ file: 'briefs/010.md' }));
    await expect(engine.create({ title: 'y', id: '011', date: '2026-09-24' })).resolves.toBeDefined();
    await expect(engine.create({ title: 'y', id: '12', date: '2026-09-24' })).resolves.toBeDefined();
    const clash = memoryEngine({ 'briefs/001_y.md': 'not a brief anyone reads' }, resolveConfig({ files: 'x*.md' }));
    await clash.load();
    await expect(clash.create({ title: 'y', id: '001', date: '2026-09-24' })).rejects.toThrow('briefs/001_y.md already exists');
    const typeless = memoryEngine({}, resolveConfig({ types: {} }));
    await typeless.load();
    await expect(typeless.create({ title: 'x', type: 't' })).rejects.toThrow('use one of (none)');
  });

  it('allocates no id where the ids are not numbers', async () => {
    const engine = memoryEngine({ 'briefs/B-1_x.md': goodBrief() }, resolveConfig({ files: '*.md' }));
    await engine.load();
    await expect(engine.create({ title: 'x' })).rejects.toThrow('there is no next one; pass --id');
  });

  it('fills a configured template, and refuses a template that is not there', async () => {
    const engine = memoryEngine({ 't.md': '# {id}: {title} ({type}{wave}) {status} {date} {other}\n' }, resolveConfig({ template: 't.md' }));
    await engine.load();
    const created = await engine.create({ title: 'T', date: '2026-09-24', wave: 1 });
    expect(created.content).toBe('# 001: T (1) draft 2026-09-24 {other}\n');
    const missing = memoryEngine({}, resolveConfig({ template: 'gone.md' }));
    await missing.load();
    await expect(missing.create({ title: 'x' })).rejects.toThrow('the template gone.md does not exist');
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
    const defaults = await BriefEngine.open({ cwd: root, noConfig: true, git: null, fs: new MemoryFileSystem({ 'briefs/001_a.md': goodBrief() }) });
    expect(defaults.configFile).toBeNull();
    expect(defaults.corpus.briefs).toHaveLength(1);
    await expect(BriefEngine.open({ cwd: root, config: 'missing.json' })).rejects.toThrow('does not exist');
    writeFileSync(join(root, 'bad.json'), '{"briefs": 1}');
    await expect(BriefEngine.open({ cwd: root, config: 'bad.json' })).rejects.toBeInstanceOf(ConfigError);
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
      'package.json': '{}',
    });
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
    await expect(loadPlugins([{ module: 'esm-only-plugin/missing', options: undefined }], root)).rejects.toThrow(
      'esm-only-plugin/missing: could not be loaded: esm-only-plugin exports no "./missing" for import',
    );
    writeTree(root, { 'node_modules/broken/package.json': '{' });
    await expect(loadPlugins([{ module: 'broken', options: undefined }], root)).rejects.toThrow('broken: could not be loaded');
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
  });

  it('refuses a module that does not load, that exports no plugin, or that repeats a name', async () => {
    const root = dir('plugins-bad');
    writeTree(root, {
      'none.mjs': 'export const other = 1;',
      'dup.mjs': "export default { name: 'dup', rules: [] };",
    });
    await expect(loadPlugins([{ module: './gone.mjs', options: undefined }], root)).rejects.toThrow('./gone.mjs: could not be loaded');
    await expect(loadPlugins([{ module: './none.mjs', options: undefined }], root)).rejects.toThrow('does not export a plugin');
    await expect(
      loadPlugins(
        [
          { module: './dup.mjs', options: undefined },
          { module: './dup.mjs', options: undefined },
        ],
        root,
      ),
    ).rejects.toThrow('two plugins are named "dup"');
  });

  it('checks the shape of what a module exports', () => {
    expect(() => asPlugin(null, 'm', undefined)).toThrow('does not export a plugin');
    expect(() => asPlugin({ name: 'bad name', rules: {} }, 'm', undefined)).toThrow('"name" must be a plain identifier; "rules" must be a list');
    const bad = [{ id: 'Upper', description: 'd', severity: 'note', check: () => [] }, { id: 'ok', description: 'd', severity: 'loud', check: () => [] }, 'x'];
    expect(() => asPlugin({ name: 'p', rules: bad }, 'm', undefined)).toThrow(/rules\[0\].*rules\[1\].*rules\[2\]/);
    expect(asPlugin({ name: '@scope/p', rules: [] }, 'm', 2)).toEqual({ name: '@scope/p', rules: [], options: 2 });
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
