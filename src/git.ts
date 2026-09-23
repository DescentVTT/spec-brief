/**
 * Git, read-only.
 *
 * spec-brief never stages, commits or rewrites history. It reads the commit a
 * round landed as, the files that commit touched, and whether the working tree
 * holds work the commit does not. What goes into a commit stays the decision
 * of whoever makes it, and archival is atomic over the files it writes rather
 * than over a repository state it would have to reverse.
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

import { relativePath } from './links.js';

export interface CommitInfo {
  readonly sha: string;
  readonly author: string;
  /** ISO 8601 author date. */
  readonly date: string;
}

export interface FileChange {
  readonly path: string;
  /** `null` for a binary file, which has no line counts. */
  readonly insertions: number | null;
  readonly deletions: number | null;
}

export interface Git {
  /** The commit a revision names, or `null` when it names none. */
  commit(revision: string): Promise<CommitInfo | null>;
  mergeBase(a: string, b: string): Promise<string | null>;
  /** Files changed from `from` to `to`; with no `from`, the files `to` changed against its first parent. */
  changes(from: string | null, to: string): Promise<FileChange[]>;
  /** Paths with uncommitted changes, untracked files included. */
  dirty(): Promise<string[]>;
  /** Every path git sees: tracked, or untracked and not ignored. A file a round just created counts. */
  files(): Promise<string[]>;
  remoteUrl(name: string): Promise<string | null>;
}

interface Run {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cwd: string, args: readonly string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => done({ ok: error === null, stdout, stderr }),
    );
  });
}

/** A revision that starts with "-" would be read as an option. */
function safeRevision(revision: string): string {
  if (revision.startsWith('-') || revision.trim() === '') throw new Error(`"${revision}" is not a revision`);
  return revision;
}

function records(output: string): string[] {
  return output.split('\0').filter((r) => r !== '');
}

/** Parses `--numstat -z` output with renames off: `added<TAB>deleted<TAB>path<NUL>`. */
export function parseNumstat(output: string): FileChange[] {
  // `show --format=` leaves the empty header's newline in front of the first record.
  return records(output.replace(/^\n+/, '')).map((record) => {
    const [added = '-', deleted = '-', ...path] = record.split('\t');
    return {
      path: path.join('\t'),
      insertions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    };
  });
}

/** Parses `status --porcelain=v1 -z`, where a rename's original path is a record of its own. */
export function parsePorcelain(output: string): string[] {
  const fields = records(output);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] as string;
    paths.push(field.slice(3));
    const x = field.charAt(0);
    if (x === 'R' || x === 'C') i += 1;
  }
  return paths;
}

/**
 * Git reports paths from the top of the work tree; spec-brief's paths start at
 * the root, which may be a directory below it. Every path that crosses this
 * boundary is made relative to the root.
 */
export class NodeGit implements Git {
  readonly cwd: string;
  private prefix: Promise<string> | undefined;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** The root's path from the top of the work tree, `sub/dir/` or empty. */
  private async rootPrefix(): Promise<string> {
    // Asked only after a status that succeeded, so the repository exists.
    this.prefix ??= run(this.cwd, ['rev-parse', '--show-prefix']).then((r) => r.stdout.trim());
    return this.prefix;
  }

  /** The working tree's top directory, or `null` outside a repository. */
  static async toplevel(cwd: string): Promise<string | null> {
    const result = await run(cwd, ['rev-parse', '--show-toplevel']);
    return result.ok ? resolve(result.stdout.trim()) : null;
  }

  async commit(revision: string): Promise<CommitInfo | null> {
    const sha = await run(this.cwd, ['rev-parse', '--verify', '--quiet', `${safeRevision(revision)}^{commit}`]);
    if (!sha.ok) return null;
    const hash = sha.stdout.trim();
    const show = await run(this.cwd, ['show', '-s', '--format=%an%x00%aI', hash]);
    const [author = '', date = ''] = show.stdout.trim().split('\0');
    return { sha: hash, author, date };
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const result = await run(this.cwd, ['merge-base', safeRevision(a), safeRevision(b)]);
    return result.ok ? result.stdout.trim() : null;
  }

  async changes(from: string | null, to: string): Promise<FileChange[]> {
    const target = safeRevision(to);
    let result: Run;
    if (from !== null) {
      result = await run(this.cwd, ['diff', '--numstat', '-z', '--no-renames', '--relative', safeRevision(from), target]);
    } else {
      const parent = await run(this.cwd, ['rev-parse', '--verify', '--quiet', `${target}^`]);
      result = parent.ok
        ? await run(this.cwd, ['diff', '--numstat', '-z', '--no-renames', '--relative', `${target}^`, target])
        : await run(this.cwd, ['show', '--numstat', '-z', '--no-renames', '--relative', '--format=', target]);
    }
    if (!result.ok) throw new Error(`git could not diff ${from ?? `${to}^`}..${to}: ${result.stderr.trim()}`);
    return parseNumstat(result.stdout);
  }

  async dirty(): Promise<string[]> {
    const result = await run(this.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!result.ok) throw new Error(`git status failed: ${result.stderr.trim()}`);
    const prefix = await this.rootPrefix();
    return parsePorcelain(result.stdout).map((path) => (prefix === '' ? path : relativePath(prefix, path)));
  }

  async files(): Promise<string[]> {
    const result = await run(this.cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!result.ok) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
    return records(result.stdout).sort();
  }

  async remoteUrl(name: string): Promise<string | null> {
    const result = await run(this.cwd, ['remote', 'get-url', safeRevision(name)]);
    return result.ok ? result.stdout.trim() : null;
  }
}

/** The web address of a pull request, for remotes on github.com. */
export function pullRequestUrl(remote: string | null, number: number): string | null {
  if (remote === null) return null;
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match) return null;
  return `https://github.com/${match[1] as string}/${match[2] as string}/pull/${number}`;
}
