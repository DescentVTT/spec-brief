/**
 * Relative links, and keeping them true when a file moves.
 *
 * Both repositories this tool was measured against archive a brief by moving
 * it one directory down and then adding `../` to its links by hand. A move
 * that breaks links is a defect the move introduced, so the move repairs them:
 * the file's own relative links, and the links other live briefs hold to it.
 */

import { linksOf, type Scan } from './markdown.js';

/** A destination that is a path relative to the file holding it. */
export function isRelativeTarget(target: string): boolean {
  if (target === '' || target.startsWith('#') || target.startsWith('/') || target.startsWith('\\')) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
}

/** The path part of a destination and whatever follows it: `?query` or `#fragment`. */
export function splitTarget(target: string): { readonly path: string; readonly suffix: string } {
  const cut = target.search(/[?#]/);
  return cut < 0 ? { path: target, suffix: '' } : { path: target.slice(0, cut), suffix: target.slice(cut) };
}

/** Normalises a repository-relative path and refuses one that leaves the repository. */
export function normalisePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) throw new Error(`"${path}" is outside the repository`);
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** Whether a repository path lies inside a directory. */
export function isInside(path: string, directory: string): boolean {
  const dir = normalisePath(directory);
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function parts(path: string): string[] {
  return path.split('/').filter((p) => p !== '' && p !== '.');
}

/** A relative path resolved against a directory, or `null` when it climbs out of the repository. */
export function resolveFrom(directory: string, relative: string): string | null {
  const out = parts(directory);
  for (const part of parts(relative)) {
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

/** The relative path from a directory to a repository path. */
export function relativePath(fromDirectory: string, to: string): string {
  const from = parts(fromDirectory);
  const target = parts(to);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common += 1;
  const up = from.slice(common).map(() => '..');
  const rest = target.slice(common);
  const joined = [...up, ...rest].join('/');
  return joined === '' ? '.' : joined;
}

function decode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Writes a path back in the encoding its original destination used. */
function encodeLike(original: string, path: string): string {
  if (!original.includes('%')) return path;
  return path
    .split('/')
    .map((p) => (p === '..' || p === '.' ? p : encodeURIComponent(p)))
    .join('/');
}

export interface LinkRewrite {
  readonly lines: string[];
  readonly count: number;
}

/**
 * Rewrites relative destinations for a file read from `directory` that will
 * be read from `newDirectory`. `retarget` maps the repository path a
 * destination resolves to now onto the one it should resolve to afterwards,
 * which differs only for a file that is itself moving.
 */
export function rewriteLinks(
  scanned: Scan,
  directory: string,
  newDirectory: string,
  retarget: (resolved: string) => string,
): LinkRewrite {
  const lines = [...scanned.lines];
  let count = 0;
  const byLine = new Map<number, { start: number; end: number; replacement: string }[]>();
  for (const link of linksOf(scanned)) {
    if (!isRelativeTarget(link.target)) continue;
    const { path, suffix } = splitTarget(link.target);
    if (path === '') continue;
    const resolved = resolveFrom(directory, decode(path));
    if (resolved === null) continue;
    const destination = retarget(resolved);
    // A destination that still resolves where it should keeps its spelling.
    if (resolveFrom(newDirectory, decode(path)) === destination) continue;
    const relative = relativePath(newDirectory, destination);
    const trailing = path.endsWith('/') && relative !== '.' ? '/' : '';
    const replacement = `${encodeLike(path, relative)}${trailing}${suffix}`;
    byLine.set(link.line, [...(byLine.get(link.line) ?? []), { start: link.start, end: link.end, replacement }]);
    count += 1;
  }
  for (const [line, edits] of byLine) {
    let text = lines[line] as string;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    }
    lines[line] = text;
  }
  return { lines, count };
}

/** Lines of `scanned` holding a relative link that resolves, from `directory`, to `target`. */
export function linesLinkingTo(scanned: Scan, directory: string, target: string): number[] {
  const found = new Set<number>();
  for (const link of linksOf(scanned)) {
    if (!isRelativeTarget(link.target)) continue;
    const { path } = splitTarget(link.target);
    if (path !== '' && resolveFrom(directory, decode(path)) === target) found.add(link.line);
  }
  return [...found].sort((a, b) => a - b);
}
