/**
 * A brief's scope, and whether two briefs can write the same file.
 *
 * What a brief may write is its `affectedFiles` less its `protectedFiles`:
 * protection wins, so "all of `src/` but the schema" is written
 * `affectedFiles: [src/**]` with `protectedFiles: [src/db/schema.ts]`. Two
 * briefs meet when some file lies in both writable scopes - in a pattern of
 * each, and in neither brief's protections - and the witness is such a file
 * the tree holds, or else the shortest such path the search builds, as an
 * example (ADR-0005).
 */

import type { Brief } from './brief.js';
import { filesMatching, type Glob, globCovers, globWitness, type LiteralReading, matchGlob, parseGlob, WITNESS_BUDGET } from './glob.js';

/** How a literal path is read, as {@link readingIn} answers for a tree. */
export type Reading = (path: string) => LiteralReading;

export interface ScopePattern {
  readonly pattern: string;
  readonly glob: Glob;
}

export interface Scope {
  readonly brief: Brief;
  /** The `affectedFiles` that parse. One that does not is the `glob` rule's finding, and scopes nothing. */
  readonly affected: readonly ScopePattern[];
  readonly protected: readonly ScopePattern[];
}

/** Patterns that parse, read with one reading. */
export function patternsOf(patterns: readonly string[], reading: Reading): ScopePattern[] {
  return patterns.flatMap((pattern) => {
    const parsed = parseGlob(pattern, { literal: reading });
    return parsed.ok ? [{ pattern, glob: parsed.glob }] : [];
  });
}

export function scopeOf(brief: Brief, reading: Reading): Scope {
  return { brief, affected: patternsOf(brief.affectedFiles, reading), protected: patternsOf(brief.protectedFiles, reading) };
}

/** A pattern from each scope, and a file both may write. */
export interface Overlap {
  readonly patterns: readonly [string, string];
  readonly witness: string;
  /**
   * `true` when the witness is a file the tree holds; `false` when the tree
   * holds none both patterns match outside the protections, and the witness
   * is an example the search built; `null` when no tree was given.
   */
  readonly inTree: boolean | null;
}

export interface Meeting {
  /** Every pair of patterns that meets outside both protections, the first scope's pattern first. */
  readonly overlaps: readonly Overlap[];
  /** Pairs of patterns the search could not decide within its budget, and no file of the tree decides. */
  readonly undecided: readonly (readonly [string, string])[];
}

const matched = new WeakMap<readonly string[], WeakMap<Glob, ReadonlySet<string>>>();

/**
 * The files of a tree a pattern matches, in the tree's order. Found once per
 * pattern and tree, which every pair a brief is in shares; kept or not, the
 * answer is the same, and only the time differs.
 */
function matching(files: readonly string[], glob: Glob): ReadonlySet<string> {
  let byGlob = matched.get(files);
  if (byGlob === undefined) {
    byGlob = new WeakMap();
    matched.set(files, byGlob);
  }
  let found = byGlob.get(glob);
  if (found === undefined) {
    found = new Set(filesMatching(glob, files));
    byGlob.set(glob, found);
  }
  return found;
}

/**
 * The first file of the tree, in its order, that both patterns match and no
 * protection does. The engine's list is sorted, so the file named is the same
 * on every run.
 */
function heldInBoth(files: readonly string[], x: Glob, y: Glob, avoid: readonly Glob[]): string | undefined {
  const other = matching(files, y);
  for (const file of matching(files, x)) {
    if (other.has(file) && !avoid.some((glob) => matchGlob(glob, file))) return file;
  }
  return undefined;
}

/**
 * Where two writable scopes meet. Each pair of affected patterns is searched
 * for a file both cover that neither brief protects: a file one brief protects
 * is one that brief will not write, so it is no collision.
 *
 * The search names the shortest such path, which the tree need not hold:
 * `src/Shop/OrderService.cs` where the tree has `src/Shop/Orders/OrderService.cs`.
 * So where the search finds a meeting, or cannot decide one, the tree's files
 * are read, and the first both patterns match outside the protections is the
 * witness (ADR-0005, amended 2026-09-30). A file that exists and both briefs
 * may write settles a pair the search could not: it is a collision, proved by
 * the file, not a guess. Where the tree holds none, the search's path stands,
 * as an example. A pair the search proves apart has no such file, and the tree
 * is not read for it.
 */
export function meet(a: Scope, b: Scope, budget: number = WITNESS_BUDGET, files: readonly string[] | null = null): Meeting {
  const avoid = [...a.protected, ...b.protected].map((p) => p.glob);
  const overlaps: Overlap[] = [];
  const undecided: (readonly [string, string])[] = [];
  for (const x of a.affected) {
    for (const y of b.affected) {
      const witness = globWitness([x.glob, y.glob], avoid, budget);
      if (witness.kind === 'none') continue;
      const patterns = [x.pattern, y.pattern] as const;
      const held = files === null ? undefined : heldInBoth(files, x.glob, y.glob, avoid);
      if (held !== undefined) overlaps.push({ patterns, witness: held, inTree: true });
      else if (witness.kind === 'found') overlaps.push({ patterns, witness: witness.path, inTree: files === null ? null : false });
      else undecided.push(patterns);
    }
  }
  return { overlaps, undecided };
}

/**
 * A witness as a reader is told it: a file of the tree by its path, and a path
 * the search built with a word that it is an example.
 */
export function witnessText(overlap: Overlap): string {
  return overlap.inTree === false ? `${overlap.witness}, an example not in the tree` : overlap.witness;
}

export interface Contradiction {
  /** Affected patterns every file of which is protected: nothing of them is writable. */
  readonly covered: readonly string[];
  /** Affected patterns for which the search could not decide within its budget. */
  readonly undecided: readonly string[];
}

/** The affected patterns a brief's own protections cover entirely. */
export function contradictions(scope: Scope, budget: number = WITNESS_BUDGET): Contradiction {
  const covered: string[] = [];
  const undecided: string[] = [];
  const outer = scope.protected.map((p) => p.glob);
  for (const { pattern, glob } of scope.affected) {
    const answer = globCovers(outer, glob, budget);
    if (answer === true) covered.push(pattern);
    else if (answer === 'undecided') undecided.push(pattern);
  }
  return { covered, undecided };
}
