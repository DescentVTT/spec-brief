import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { MemoryFileSystem, NodeFileSystem, NotAFileError, notAFile, type Reads } from '../src/fs.js';
import { GitError, NodeGit, parseNumstat, parsePorcelain, pullRequestUrl } from '../src/git.js';
import { commitAll, git, head, initRepo, pipe, tempDir, writeTree } from './helpers.js';

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The directories a walk never enters, as the interface promises them. */
const IGNORED = ['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', 'target', '.venv', '__pycache__', '.stryker-tmp'];

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

  it("never walks into build output or another tool's state, at the root or below it", async () => {
    const files = Object.fromEntries(['src/dist.ts', ...IGNORED.flatMap((name) => [`${name}/x`, `pkg/${name}/y`])].map((path) => [path, '']));
    const root = dir('fs-ignored');
    writeTree(root, files);
    expect(await new NodeFileSystem(root).walk()).toEqual(['src/dist.ts']);
    expect(await new MemoryFileSystem(files).walk()).toEqual(['src/dist.ts']);
  });

  it('neither enters nor lists a link to a directory: one that leads back to the root would never end', async () => {
    const root = dir('fs-link');
    writeTree(root, { 'a.md': '', 'sub/b.md': '' });
    symlinkSync(root, join(root, 'sub', 'loop'), 'junction');
    expect(await new NodeFileSystem(root).walk()).toEqual(['a.md', 'sub/b.md']);
  });

  it('tells its reads each file it read, by a digest of the bytes, each it looked for, and each directory it listed', async () => {
    // A tool that gives an answer again reads each input as listed, so a
    // read that went untold is an answer given after it changed (ADR-0002,
    // amended 2026-10-19). Bytes no text keeps, so that a digest of the text
    // decoded would not be theirs.
    const root = dir('fs-reads');
    const odd = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0xff, 0x0d, 0x0a]);
    writeTree(root, { 'a/b.md': 'text\n', 'a/sub/c.md': '' });
    writeFileSync(join(root, 'a', 'odd.md'), odd);
    const reads: Reads = { files: new Map(), directories: new Map() };
    const fs = new NodeFileSystem(root, reads);
    expect(await fs.read('a/b.md')).toBe('text\n');
    expect(await fs.read('./a/odd.md')).toBe(odd.toString('utf8'));
    expect(await fs.read('missing.md')).toBeNull();
    expect((await fs.list('a'))?.sort()).toEqual(['b.md', 'odd.md']);
    expect(await fs.list('nope')).toBeNull();
    expect(await fs.list('a/b.md')).toBeNull();
    const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
    expect(reads.files).toEqual(new Map([['a/b.md', sha('text\n')], ['a/odd.md', sha(odd)], ['missing.md', null]]));
    expect([...reads.directories].map(([path, names]) => [path, names === null ? null : [...names].sort()])).toEqual([
      ['a', ['b.md', 'odd.md']],
      ['nope', null],
      ['a/b.md', null],
    ]);
    // Given none, it reads as it did.
    expect(await new NodeFileSystem(root).read('a/odd.md')).toBe(odd.toString('utf8'));
  });

  it('reads only a file: a directory, or a link to one, is refused before it is opened, and told to no reads', async () => {
    // A directory read as a file ended the run on Node's EISDIR and a stack.
    const root = dir('fs-not-a-file');
    writeTree(root, { 'a.md': 'text\n', 'd/x.md': '' });
    symlinkSync(join(root, 'd'), join(root, 'j'), 'junction');
    const reads: Reads = { files: new Map(), directories: new Map() };
    const fs = new NodeFileSystem(root, reads);
    const refusal = async (path: string): Promise<unknown> => fs.read(path).then(() => 'read', (error: unknown) => error);
    const directory = await refusal('d');
    expect(directory).toBeInstanceOf(NotAFileError);
    expect(directory).toMatchObject({ name: 'NotAFileError', message: 'd is a directory; only a file is read', path: 'd', what: 'a directory' });
    expect(await refusal('./j')).toMatchObject({ message: 'j is a directory; only a file is read', path: 'j' });
    // A file is read as it was, and a path where nothing is reads as nothing.
    expect(await fs.read('a.md')).toBe('text\n');
    expect(await fs.read('gone.md')).toBeNull();
    expect([...reads.files.keys()]).toEqual(['a.md', 'gone.md']);
    expect(await notAFile(join(root, 'd'))).toBe('a directory');
    expect(await notAFile(join(root, 'a.md'))).toBeNull();
    expect(await notAFile(join(root, 'gone.md'))).toBeNull();
    // A path a listing has just named a file is read without the question,
    // so what a listing could not have named reaches Node's own read.
    await expect(fs.read('d', true)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await fs.read('a.md', true)).toBe('text\n');
  });

  // Windows has no named pipe at a path, no socket at one, and no /dev/null.
  it.skipIf(process.platform === 'win32')(
    'refuses a named pipe, a device and a socket, through a link too, before it is opened, and reads a link to a file',
    async () => {
      // A named pipe was read without end, a link to /dev/null as nothing, and
      // a socket ended the run on Node's ENXIO and a stack.
      const root = dir('fs-neither');
      writeTree(root, { 'a.md': 'text\n' });
      pipe(join(root, 'pipe'));
      symlinkSync('pipe', join(root, 'to-pipe'));
      symlinkSync('/dev/null', join(root, 'null'));
      symlinkSync('a.md', join(root, 'to-a.md'));
      const server = createServer();
      // A short name: macOS holds a socket's path to 104 bytes.
      await new Promise<void>((done) => server.listen(join(root, 's'), done));
      try {
        const reads: Reads = { files: new Map(), directories: new Map() };
        const fs = new NodeFileSystem(root, reads);
        for (const path of ['pipe', 'to-pipe', 'null', 's']) {
          const error = await fs.read(path).then(() => 'read', (thrown: unknown) => thrown);
          expect(error, path).toBeInstanceOf(NotAFileError);
          expect(error, path).toMatchObject({ message: `${path} is neither a file nor a directory; only a file is read`, what: 'neither a file nor a directory' });
          expect(await notAFile(join(root, path)), path).toBe('neither a file nor a directory');
        }
        expect(await fs.read('to-a.md')).toBe('text\n');
        expect([...reads.files.keys()]).toEqual(['to-a.md']);
      } finally {
        server.close();
      }
    },
    // A pipe read without end is a test that does not come back, until the pipe's writer ends it.
    20_000,
  );
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

  it('lists and walks in order whatever order it was filled in, and has a root when it holds nothing', async () => {
    const fs = new MemoryFileSystem({ 'b.md': '', 'a.md': '', 'z/y.md': '', 'z/x.md': '' });
    expect(await fs.list('')).toEqual(['a.md', 'b.md']);
    expect(await fs.list('z')).toEqual(['x.md', 'y.md']);
    expect(await fs.walk()).toEqual(['a.md', 'b.md', 'z/x.md', 'z/y.md']);
    expect(await new MemoryFileSystem().list('')).toEqual([]);
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
    // Only the newlines in front of the first record are the header's: a name may hold one.
    expect(parseNumstat('\n\n-\t-\tb.bin\0')).toEqual([{ path: 'b.bin', insertions: null, deletions: null }]);
    expect(parseNumstat('1\t0\twith\nnewline\0')).toEqual([{ path: 'with\nnewline', insertions: 1, deletions: 0 }]);
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
    expect(tip).toEqual({ sha: second, author: 'Tester', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/) });
    expect(await g.commit('no-such-ref')).toBeNull();
    await expect(g.commit('--output=x')).rejects.toThrow('is not a revision');
    await expect(g.commit(' ')).rejects.toThrow('is not a revision');
    // By its class the command line tells it from a defect, and reports the
    // message alone; printed whole by a caller, it says which kind it is.
    await expect(g.commit(' ')).rejects.toBeInstanceOf(GitError);
    expect(String(new GitError('no'))).toBe('GitError: no');
    // Every revision asked at once: the commit each names, or none.
    expect(await g.commits(['HEAD', second, second.slice(0, 7), 'HEAD~1', 'main', 'nothing', '-x', 'HEAD..HEAD~1', 'HEAD '])).toEqual([second, second, second, first, second, null, null, null, null]);
    // A line break would be two questions, and one answer given for another.
    expect(await g.commits(['HEAD', `HEAD${String.fromCharCode(10)}HEAD~1`])).toEqual([null, null]);
    expect(await g.commits([])).toEqual([]);
    expect(await g.mergeBase('HEAD', first)).toBe(first);
    expect(await g.mergeBase('HEAD', 'nothing')).toBeNull();
    expect((await g.changes(null, second)).map((c) => c.path).sort()).toEqual(['a.txt', 'c.txt']);
    expect((await g.changes(null, first)).map((c) => c.path).sort()).toEqual(['a.txt', 'b.bin']);
    expect(await g.changes(first, second)).toEqual([
      { path: 'a.txt', insertions: 1, deletions: 0 },
      { path: 'c.txt', insertions: 1, deletions: 0 },
    ]);
    // What git said, without the newline it ends on.
    await expect(g.changes('nothing', second)).rejects.toThrow(new RegExp(`^git could not diff nothing\\.\\.${second}: fatal: [^]*\\S$`));
    await expect(g.changes(null, 'nothing')).rejects.toThrow(/^git could not diff nothing\^\.\.nothing: fatal: [^]*\S$/);
    await expect(g.changes('nothing', second)).rejects.toBeInstanceOf(GitError);
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
    // What git said, without the newline it ends on.
    const plain = new NodeGit(outside);
    await expect(plain.dirty()).rejects.toBeInstanceOf(GitError);
    await expect(plain.files()).rejects.toBeInstanceOf(GitError);
    await expect(plain.dirty()).rejects.toThrow(/^git status failed: fatal: not a git repository[^]*\S$/);
    // Where git answers nothing, it names no commit.
    expect(await plain.commits(['HEAD', 'main'])).toEqual([null, null]);
    // More than a pipe holds, so that the write meets a git that has gone: its
    // EPIPE ended the process, where git's answer is none for each.
    const many = Array.from({ length: 100_000 }, (_, index) => `revision-${index}`);
    expect(await plain.commits(many)).toEqual(many.map(() => null));
    await expect(plain.files()).rejects.toThrow(/^git ls-files failed: fatal: not a git repository[^]*\S$/);
  });

  it('reads a commit with nothing to start from against its first parent: a merge, a tag that names one, the first of a history', async () => {
    const root = dir('git-merge');
    initRepo(root);
    writeTree(root, { 'a.txt': 'one\n' });
    commitAll(root, 'first');
    const first = head(root);
    git(root, 'checkout', '-q', '-b', 'side');
    writeTree(root, { 'side.txt': 's\n' });
    commitAll(root, 'side');
    git(root, 'checkout', '-q', 'main');
    writeTree(root, { 'main.txt': 'm\n' });
    commitAll(root, 'main');
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    git(root, 'tag', '-a', '-m', 'the round', 'round-1');
    const g = new NodeGit(root);
    const merged = [{ path: 'side.txt', insertions: 1, deletions: 0 }];
    expect(await g.changes(null, head(root))).toEqual(merged);
    expect(await g.changes(null, 'round-1')).toEqual(merged);
    expect(await g.changes(null, first)).toEqual([{ path: 'a.txt', insertions: 1, deletions: 0 }]);
  });

  it('lists a tree whose paths together pass a megabyte, which is where a process stops being read by default', async () => {
    const root = dir('git-large');
    initRepo(root);
    // Entries in the index need no files: twelve thousand paths of a hundred characters.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: '', encoding: 'utf8' }).trim();
    const paths = Array.from({ length: 12_000 }, (_, i) => `${'d'.repeat(90)}/${String(i).padStart(9, '0')}`);
    execFileSync('git', ['update-index', '--index-info'], { cwd: root, input: paths.map((path) => `100644 ${blob}\t${path}\n`).join('') });
    const listed = await new NodeGit(root).files();
    expect(listed).toHaveLength(12_000);
    expect(listed.join('\n').length).toBeGreaterThan(1024 * 1024);
    expect(listed[11_999]).toBe(paths[11_999]);
  });
});
