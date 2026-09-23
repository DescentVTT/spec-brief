/**
 * The filesystem, behind an interface.
 *
 * Every path crossing this boundary is repository-relative and POSIX; the
 * Node implementation is the only place a host path exists. The in-memory
 * implementation is not a test double bolted on afterwards: it is how a
 * harness asks "what would archiving this do" against files that were never
 * written, and how the transaction's rollback is exercised with a failure on
 * exactly the operation that matters.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { normalisePath as repoPath } from './links.js';

export interface FileSystem {
  /** Contents, or `null` when there is no such file. */
  read(path: string): Promise<string | null>;
  /** Writes a file, creating its directory. Replaces an existing file atomically where the platform allows. */
  write(path: string, content: string): Promise<void>;
  /** Removes a file. Removing a file that is absent is an error. */
  remove(path: string): Promise<void>;
  /** Names of the files directly inside a directory, or `null` when it does not exist. */
  list(directory: string): Promise<string[] | null>;
  /** Every file beneath the root, as sorted repository-relative paths, skipping {@link IGNORED_DIRECTORIES}. */
  walk(): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

/**
 * The path as the filesystem names it: links and junctions followed, and on
 * Windows short names such as `RUNNER~1` expanded. Git reports the top of a
 * work tree this way, so a root compared with it has to be named the same.
 * A path that does not exist is returned as given, for the caller to report.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Directories a walk never enters: build output and other tools' state. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  '__pycache__',
  '.stryker-tmp',
]);

/** Errors a rename on Windows raises while another process briefly holds the file. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 6;

async function pause(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
}

export class NodeFileSystem implements FileSystem {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private host(path: string): string {
    const normal = repoPath(path);
    return normal === '' ? this.root : join(this.root, ...normal.split('/'));
  }

  async read(path: string): Promise<string | null> {
    try {
      return await readFile(this.host(path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const target = this.host(path);
    await mkdir(dirname(target), { recursive: true });
    // Written beside the target and renamed over it, so a reader never sees half a file.
    const temporary = join(dirname(target), `.${randomBytes(6).toString('hex')}.spec-brief.tmp`);
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await rename(temporary, target);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (!TRANSIENT.has(code) || attempt >= RENAME_ATTEMPTS) throw error;
          await pause(15 * attempt);
        }
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(this.host(path));
  }

  async list(directory: string): Promise<string[] | null> {
    try {
      const entries = await readdir(this.host(directory), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      /* v8 ignore next -- a permission error, which a portable test cannot provoke; it must not read as "no briefs". */
      throw error;
    }
  }

  async walk(): Promise<string[]> {
    const found: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(full);
        } else if (entry.isFile()) {
          found.push(relative(this.root, full).split(sep).join('/'));
        }
      }
    };
    await visit(this.root);
    return found.sort();
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.host(path));
      return true;
    } catch {
      return false;
    }
  }
}

export type FileOperation = 'write' | 'remove';

/**
 * Files in a `Map`. `fail` lets a test make one chosen operation throw, which
 * is the only honest way to prove a rollback restores what it claims to.
 */
export class MemoryFileSystem implements FileSystem {
  readonly files: Map<string, string>;
  fail: ((operation: FileOperation, path: string) => boolean) | undefined;

  constructor(files: Readonly<Record<string, string>> = {}) {
    this.files = new Map(Object.entries(files).map(([path, content]) => [repoPath(path), content]));
    this.fail = undefined;
  }

  read(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(repoPath(path)) ?? null);
  }

  write(path: string, content: string): Promise<void> {
    const normal = repoPath(path);
    if (this.fail?.('write', normal) === true) return Promise.reject(new Error(`injected failure writing ${normal}`));
    this.files.set(normal, content);
    return Promise.resolve();
  }

  remove(path: string): Promise<void> {
    const normal = repoPath(path);
    if (this.fail?.('remove', normal) === true) return Promise.reject(new Error(`injected failure removing ${normal}`));
    if (!this.files.delete(normal)) return Promise.reject(new Error(`${normal} does not exist`));
    return Promise.resolve();
  }

  list(directory: string): Promise<string[] | null> {
    const prefix = repoPath(directory);
    const names: string[] = [];
    let isDirectory = prefix === '';
    for (const path of this.files.keys()) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      isDirectory = true;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      if (!rest.includes('/')) names.push(rest);
    }
    return Promise.resolve(isDirectory ? names.sort() : null);
  }

  walk(): Promise<string[]> {
    const paths = [...this.files.keys()].filter((path) => !path.split('/').some((part) => IGNORED_DIRECTORIES.has(part)));
    return Promise.resolve(paths.sort());
  }

  exists(path: string): Promise<boolean> {
    const normal = repoPath(path);
    return Promise.resolve(
      this.files.has(normal) || [...this.files.keys()].some((p) => normal === '' || p.startsWith(`${normal}/`)),
    );
  }
}
