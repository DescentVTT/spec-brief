import type { Dirent, PathLike } from 'node:fs';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { NodeFileSystem } from '../src/fs.js';
import { tempDir, writeTree } from './helpers.js';

/**
 * The filesystem when it is less obliging than a temporary directory: a
 * rename another process blocks for a moment, a directory that may not be
 * read, names that come in no order.
 *
 * None of these is reliably this host's. Windows blocks a rename where Linux
 * does not, a portable test cannot take a directory's permissions away, and
 * Windows lists names in order where Linux need not. So the two calls that
 * meet them are put under the test's control here, in a file of their own,
 * because the mock reaches everything the file imports; every other call
 * reaches the real filesystem.
 */

const disk = vi.hoisted(() => ({
  /** What the next renames fail with, first first: an error code, or `null` for an error that has none. */
  renames: [] as (string | null)[],
  attempts: 0,
  /** The code a listing fails with. */
  listing: null as string | null,
  /** Names come back last first, as no host gives them. */
  backwards: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const failure = (code: string | null): Error => (code === null ? new Error('an error with no code') : Object.assign(new Error(code), { code }));
  const rename = async (from: PathLike, to: PathLike): Promise<void> => {
    disk.attempts += 1;
    const next = disk.renames.shift();
    if (next !== undefined) throw failure(next);
    await real.rename(from, to);
  };
  const readdir = async (path: PathLike, options: { withFileTypes: true }): Promise<Dirent[]> => {
    if (disk.listing !== null) throw failure(disk.listing);
    const entries = await real.readdir(path, options);
    return disk.backwards ? [...entries].sort((a, b) => (a.name < b.name ? 1 : -1)) : entries;
  };
  return { ...real, rename, readdir };
});

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterEach(() => {
  disk.renames = [];
  disk.attempts = 0;
  disk.listing = null;
  disk.backwards = false;
});
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('a rename another process blocks', () => {
  it('is tried again when the block is one that passes, and the file is then written whole', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const root = dir(`rename-${code}`);
      disk.renames = [code];
      disk.attempts = 0;
      await new NodeFileSystem(root).write('a/b.md', 'whole');
      expect(disk.attempts, code).toBe(2);
      expect(readFileSync(join(root, 'a', 'b.md'), 'utf8'), code).toBe('whole');
      expect(readdirSync(join(root, 'a')), code).toEqual(['b.md']);
    }
  });

  it('is not tried again after any other error, and leaves no temporary file', async () => {
    const root = dir('rename-other');
    const fs = new NodeFileSystem(root);
    for (const code of ['EXDEV', 'ENOSPC', null]) {
      disk.renames = [code];
      disk.attempts = 0;
      await expect(fs.write('a.md', 'x'), String(code)).rejects.toThrow(code ?? 'an error with no code');
      expect(disk.attempts, String(code)).toBe(1);
      expect(readdirSync(root), String(code)).toEqual([]);
    }
  });

  it('is given up on at the sixth refusal, with the error and no temporary file', async () => {
    const root = dir('rename-held');
    disk.renames = ['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'];
    await expect(new NodeFileSystem(root).write('a.md', 'x')).rejects.toThrow('EBUSY');
    expect(disk.attempts).toBe(6);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('a directory', () => {
  it('that may not be read is an error, where one that is not there is no directory', async () => {
    const root = dir('list-denied');
    writeTree(root, { 'briefs/001_a.md': '' });
    const fs = new NodeFileSystem(root);
    disk.listing = 'EACCES';
    await expect(fs.list('briefs')).rejects.toThrow('EACCES');
    disk.listing = null;
    expect(await fs.list('briefs')).toEqual(['001_a.md']);
    expect(await fs.list('absent')).toBeNull();
  });

  it('is walked into sorted paths, whatever order its names come in', async () => {
    const root = dir('walk-order');
    writeTree(root, { 'b.md': '', 'a.md': '', 'c/d.md': '', 'c.md': '' });
    disk.backwards = true;
    expect(await new NodeFileSystem(root).walk()).toEqual(['a.md', 'b.md', 'c.md', 'c/d.md']);
  });
});
