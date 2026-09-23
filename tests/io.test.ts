import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { MemoryFileSystem, NodeFileSystem } from '../src/fs.js';
import { NodeGit, parseNumstat, parsePorcelain, pullRequestUrl } from '../src/git.js';
import { commitAll, git, head, initRepo, tempDir, writeTree } from './helpers.js';

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('the Node filesystem', () => {
  it('reads, writes atomically, lists, walks and removes', async () => {
    const root = dir('fs');
    const fs = new NodeFileSystem(root);
    expect(await fs.read('missing.md')).toBeNull();
    await fs.write('a/b/c.md', 'one');
    await fs.write('a/b/c.md', 'two');
    expect(await fs.read('a/b/c.md')).toBe('two');
    expect(readdirSync(join(root, 'a', 'b'))).toEqual(['c.md']);
    await fs.write('node_modules/x.js', '');
    await fs.write('top.md', '');
    expect(await fs.list('a/b')).toEqual(['c.md']);
    expect(await fs.list('a')).toEqual([]);
    expect(await fs.list('nope')).toBeNull();
    expect(await fs.list('top.md')).toBeNull();
    expect(await fs.walk()).toEqual(['a/b/c.md', 'top.md']);
    expect(await fs.exists('a')).toBe(true);
    expect(await fs.exists('a/b/c.md')).toBe(true);
    expect(await fs.exists('zzz')).toBe(false);
    await fs.remove('a/b/c.md');
    expect(existsSync(join(root, 'a', 'b', 'c.md'))).toBe(false);
    await expect(fs.remove('a/b/c.md')).rejects.toThrow();
    await expect(fs.read('../outside')).rejects.toThrow('outside the repository');
  });

  it('rethrows what is not a missing file', async () => {
    const root = dir('fs-errors');
    writeFileSync(join(root, 'file'), '');
    const fs = new NodeFileSystem(root);
    await expect(fs.read('')).rejects.toThrow();
    await expect(fs.write('file/child', 'x')).rejects.toThrow();
  });

  it('leaves no temporary file behind when the rename fails', async () => {
    const root = dir('fs-rename');
    const fs = new NodeFileSystem(root);
    await fs.write('target/inner.md', 'x');
    await expect(fs.write('target', 'cannot replace a directory')).rejects.toThrow();
    expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the in-memory filesystem', () => {
  it('behaves like the Node one', async () => {
    const fs = new MemoryFileSystem({ 'a/b.md': '1', './c.md': '2', 'node_modules/x': '' });
    expect(await fs.read('a/b.md')).toBe('1');
    expect(await fs.read('nope')).toBeNull();
    expect(await fs.list('')).toEqual(['c.md']);
    expect(await fs.list('a')).toEqual(['b.md']);
    expect(await fs.list('zzz')).toBeNull();
    expect(await fs.walk()).toEqual(['a/b.md', 'c.md']);
    expect(await fs.exists('a')).toBe(true);
    expect(await fs.exists('')).toBe(true);
    expect(await fs.exists('a/b')).toBe(false);
    await fs.write('d.md', '3');
    await fs.remove('c.md');
    await expect(fs.remove('c.md')).rejects.toThrow('c.md does not exist');
    expect([...fs.files.keys()].sort()).toEqual(['a/b.md', 'd.md', 'node_modules/x']);
  });

  it('fails exactly the operation a test chooses', async () => {
    const fs = new MemoryFileSystem({ a: '1' });
    fs.fail = (operation, path) => operation === 'remove' && path === 'a';
    await expect(fs.remove('a')).rejects.toThrow('injected failure removing a');
    await fs.write('a', '2');
    fs.fail = (operation) => operation === 'write';
    await expect(fs.write('b', '')).rejects.toThrow('injected failure writing b');
    expect(await fs.read('a')).toBe('2');
  });
});

describe('git output', () => {
  it('parses numstat, binary files and tabs in names', () => {
    expect(parseNumstat('3\t1\ta.ts\0-\t-\timg.png\0' + '1\t0\twith\ttab\0')).toEqual([
      { path: 'a.ts', insertions: 3, deletions: 1 },
      { path: 'img.png', insertions: null, deletions: null },
      { path: 'with\ttab', insertions: 1, deletions: 0 },
    ]);
    expect(parseNumstat('\n\n2\t2\tb\0')).toEqual([{ path: 'b', insertions: 2, deletions: 2 }]);
    expect(parseNumstat('')).toEqual([]);
  });

  it('parses porcelain status, skipping the original path of a rename or copy', () => {
    expect(parsePorcelain(' M a.ts\0R  new.ts\0old.ts\0C  c2\0c1\0?? u.md\0')).toEqual(['a.ts', 'new.ts', 'c2', 'u.md']);
  });

  it('builds pull-request addresses for github.com remotes only', () => {
    expect(pullRequestUrl('https://github.com/DescentVTT/spec-brief.git', 4)).toBe('https://github.com/DescentVTT/spec-brief/pull/4');
    expect(pullRequestUrl('git@github.com:o/r.git', 5)).toBe('https://github.com/o/r/pull/5');
    expect(pullRequestUrl('https://github.com/o/r/', 6)).toBe('https://github.com/o/r/pull/6');
    expect(pullRequestUrl('https://gitlab.com/o/r.git', 7)).toBeNull();
    expect(pullRequestUrl(null, 8)).toBeNull();
  });
});

describe('real git', () => {
  it('reads commits, diffs, the working tree and remotes, and writes nothing', async () => {
    const root = dir('git');
    initRepo(root);
    writeTree(root, { 'a.txt': 'one\n', 'b.bin': 'x' });
    commitAll(root, 'first');
    const first = head(root);
    writeTree(root, { 'a.txt': 'one\ntwo\n', 'c.txt': 'new\n' });
    commitAll(root, 'second');
    const second = head(root);
    git(root, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    writeTree(root, { 'dirty.txt': 'u' });

    const g = new NodeGit(root);
    expect(await NodeGit.toplevel(join(root))).toBe(root);
    const tip = await g.commit('HEAD');
    expect(tip).toEqual({ sha: second, author: 'Tester', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(await g.commit('no-such-ref')).toBeNull();
    await expect(g.commit('--output=x')).rejects.toThrow('is not a revision');
    await expect(g.commit(' ')).rejects.toThrow('is not a revision');
    expect(await g.mergeBase('HEAD', first)).toBe(first);
    expect(await g.mergeBase('HEAD', 'nothing')).toBeNull();
    expect((await g.changes(null, second)).map((c) => c.path).sort()).toEqual(['a.txt', 'c.txt']);
    expect((await g.changes(null, first)).map((c) => c.path).sort()).toEqual(['a.txt', 'b.bin']);
    expect(await g.changes(first, second)).toEqual([
      { path: 'a.txt', insertions: 1, deletions: 0 },
      { path: 'c.txt', insertions: 1, deletions: 0 },
    ]);
    await expect(g.changes('nothing', second)).rejects.toThrow('git could not diff');
    expect(await g.dirty()).toEqual(['dirty.txt']);
    expect((await g.files()).sort()).toEqual(['a.txt', 'b.bin', 'c.txt', 'dirty.txt']);
    expect(await g.remoteUrl('origin')).toBe('https://github.com/o/r.git');
    expect(await g.remoteUrl('upstream')).toBeNull();
    expect(git(root, 'status', '--porcelain')).toBe('?? dirty.txt\n');
  });

  it('reports paths from the root when the root is below the top of the work tree', async () => {
    const top = dir('git-nested');
    initRepo(top);
    writeTree(top, { 'sub/a.txt': '1', 'other.txt': '1' });
    commitAll(top, 'first');
    writeTree(top, { 'sub/a.txt': '2', 'other.txt': '2' });
    commitAll(top, 'second');
    writeTree(top, { 'sub/new.txt': '', 'outside.txt': '' });
    const g = new NodeGit(join(top, 'sub'));
    expect(await g.changes(null, 'HEAD')).toEqual([{ path: 'a.txt', insertions: 1, deletions: 1 }]);
    expect((await g.dirty()).sort()).toEqual(['../outside.txt', 'new.txt']);
    expect(await g.files()).toEqual(['a.txt', 'new.txt']);
  });

  it('knows when it is outside a repository', async () => {
    const outside = dir('no-git');
    expect(await NodeGit.toplevel(outside)).toBeNull();
    const g = new NodeGit(join(outside, 'does-not-exist'));
    await expect(g.dirty()).rejects.toThrow('git status failed');
    await expect(g.files()).rejects.toThrow('git ls-files failed');
  });
});
