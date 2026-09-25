/**
 * A brief's scope, and whether two briefs can write the same file.
 *
 * What a brief may write is its `affectedFiles` less its `protectedFiles`:
 * protection wins, so "all of `src/` but the schema" is written
 * `affectedFiles: [src/**]` with `protectedFiles: [src/db/schema.ts]`. Two
 * briefs meet when some file lies in both writable scopes - in a pattern of
 * each, and in neither brief's protections - and the witness search names
 * the shortest such file (ADR-0005).
 */

import type { Brief } from './brief.js';
import { type Glob, globCovers, globWitness, type LiteralReading, parseGlob, WITNESS_BUDGET } from './glob.js';

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
}

export interface Meeting {
  /** Every pair of patterns that meets outside both protections, the first scope's pattern first. */
  readonly overlaps: readonly Overlap[];
  /** Pairs of patterns the search could not decide within its budget. */
  readonly undecided: readonly (readonly [string, string])[];
}

/**
 * Where two writable scopes meet. Each pair of affected patterns is searched
 * for a file both cover that neither brief protects: a file one brief protects
 * is one that brief will not write, so it is no collision.
 */
export function meet(a: Scope, b: Scope, budget: number = WITNESS_BUDGET): Meeting {
  const avoid = [...a.protected, ...b.protected].map((p) => p.glob);
  const overlaps: Overlap[] = [];
  const undecided: (readonly [string, string])[] = [];
  for (const x of a.affected) {
    for (const y of b.affected) {
      const witness = globWitness([x.glob, y.glob], avoid, budget);
      if (witness.kind === 'found') overlaps.push({ patterns: [x.pattern, y.pattern], witness: witness.path });
      else if (witness.kind === 'undecided') undecided.push([x.pattern, y.pattern]);
    }
  }
  return { overlaps, undecided };
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
  if (scope.protected.length === 0) return { covered, undecided };
  const outer = scope.protected.map((p) => p.glob);
  for (const { pattern, glob } of scope.affected) {
    const answer = globCovers(outer, glob, budget);
    if (answer === true) covered.push(pattern);
    else if (answer === 'undecided') undecided.push(pattern);
  }
  return { covered, undecided };
}
