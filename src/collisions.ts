/**
 * The collision matrix: which briefs scheduled to run side by side declare
 * scopes that can name the same file.
 *
 * Scopes are compared as globs, not as strings. `src/auth/**` and
 * `src/**\/session.ts` share no prefix a string comparison would see and both
 * cover `src/auth/session.ts`; the witness search finds that, and names the
 * file. What a brief protects it will not write, so a file either brief of a
 * pair protects is no collision. A brief that declares no scope cannot be
 * proven apart from anything, so it is reported as unscoped rather than
 * silently counted as safe, and a pair the search could not decide is reported
 * as undecided rather than as either.
 *
 * Two briefs that collide are one defect however many of their patterns
 * meet: they are fixed together, by a wave, a dependency or a narrower scope.
 * So a pair is one collision, carrying every pair of patterns that meets.
 */

import type { Brief } from './brief.js';
import { lineOfField } from './brief.js';
import type { Corpus } from './corpus.js';
import { globBases, readingIn, WITNESS_BUDGET } from './glob.js';
import { configuredSeverity } from './lint.js';
import { meet, type Overlap, type Scope, scopeOf } from './scope.js';
import { inWords } from './text.js';
import type { Finding, Severity } from './types.js';

export type { Overlap } from './scope.js';

export interface Collision {
  readonly a: Brief;
  readonly b: Brief;
  /** Every pair of patterns that meets, `a`'s first; never empty. */
  readonly overlaps: readonly Overlap[];
}

/** Two briefs no pair of whose patterns is known to meet, and some pair the search could not decide. */
export interface UndecidedPair {
  readonly a: Brief;
  readonly b: Brief;
  /** The pairs of patterns, `a`'s first; never empty. */
  readonly patterns: readonly (readonly [string, string])[];
}

export interface SharedDirectory {
  readonly a: Brief;
  readonly b: Brief;
  /** The directories both write into, sorted; never empty. */
  readonly directories: readonly string[];
}

export interface WaveMatrix {
  /** `null` when every live brief is compared regardless of wave. */
  readonly wave: number | null;
  readonly briefs: readonly Brief[];
  readonly collisions: readonly Collision[];
  readonly undecided: readonly UndecidedPair[];
  readonly shared: readonly SharedDirectory[];
  readonly unscoped: readonly Brief[];
}

export interface CollisionReport {
  readonly waves: readonly WaveMatrix[];
  /** Live briefs with no wave, which the matrix does not place. */
  readonly unscheduled: readonly Brief[];
  /** Deferred briefs, which wait for their trigger and run in no wave. */
  readonly deferred: readonly Brief[];
}

export interface CollisionOptions {
  /** Compare every live brief with every other, whatever its wave. */
  readonly all?: boolean;
  /** The files the tree holds, which say whether a literal path is a file or a directory. */
  readonly repoFiles?: readonly string[] | null;
  /** How many states one witness search may visit before it answers `undecided`. */
  readonly budget?: number;
}

function matrix(wave: number | null, briefs: readonly Brief[], scopes: ReadonlyMap<Brief, Scope>, budget: number): WaveMatrix {
  const collisions: Collision[] = [];
  const undecided: UndecidedPair[] = [];
  const shared: SharedDirectory[] = [];
  const scoped = briefs.map((brief) => scopes.get(brief) as Scope);
  for (let i = 0; i < scoped.length; i += 1) {
    for (let j = i + 1; j < scoped.length; j += 1) {
      const left = scoped[i] as Scope;
      const right = scoped[j] as Scope;
      const meeting = meet(left, right, budget);
      if (meeting.overlaps.length > 0) {
        collisions.push({ a: left.brief, b: right.brief, overlaps: meeting.overlaps });
        continue;
      }
      if (meeting.undecided.length > 0) {
        undecided.push({ a: left.brief, b: right.brief, patterns: meeting.undecided });
        continue;
      }
      const leftDirs = new Set(left.affected.flatMap((s) => globBases(s.glob)).filter((d) => d !== ''));
      const directories = [...new Set(right.affected.flatMap((s) => globBases(s.glob)))].filter((d) => leftDirs.has(d)).sort();
      if (directories.length > 0) shared.push({ a: left.brief, b: right.brief, directories });
    }
  }
  const unscoped = briefs.length > 1 ? scoped.filter((s) => s.affected.length === 0).map((s) => s.brief) : [];
  return { wave, briefs, collisions, undecided, shared, unscoped };
}

export function collisions(corpus: Corpus, options: CollisionOptions = {}): CollisionReport {
  const reading = readingIn(options.repoFiles ?? null);
  const budget = options.budget ?? WITNESS_BUDGET;
  const deferred = corpus.live.filter((b) => b.status === 'deferred');
  const live = corpus.live.filter((b) => b.status !== 'deferred');
  const scopes = new Map(live.map((brief) => [brief, scopeOf(brief, reading)]));
  if (options.all === true) return { waves: [matrix(null, live, scopes, budget)], unscheduled: [], deferred };
  const byWave = new Map<number, Brief[]>();
  const unscheduled: Brief[] = [];
  for (const brief of live) {
    if (brief.wave === null) unscheduled.push(brief);
    else byWave.set(brief.wave, [...(byWave.get(brief.wave) ?? []), brief]);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b).map((wave) => matrix(wave, byWave.get(wave) as Brief[], scopes, budget));
  return { waves, unscheduled, deferred };
}

function label(brief: Brief): string {
  return brief.id ?? brief.name;
}

function where(wave: number | null): string {
  return wave === null ? 'among the live briefs' : `in wave ${wave}`;
}

function collisionMessage(c: Collision, wave: number | null): string {
  if (c.overlaps.length === 1) {
    const only = c.overlaps[0] as Overlap;
    return `"${only.patterns[1]}" overlaps ${label(c.a)}'s "${only.patterns[0]}" ${where(wave)}; both cover ${only.witness}`;
  }
  const each = c.overlaps.map((o) => `"${o.patterns[1]}" and ${label(c.a)}'s "${o.patterns[0]}" both cover ${o.witness}`);
  return `overlaps ${label(c.a)} ${where(wave)} through ${c.overlaps.length} pairs of patterns: ${each.join('; ')}`;
}

/** A pair whose collision the search could not decide, as one finding on the later brief. */
export function undecidedFinding(severity: Severity, a: Brief, b: Brief, patterns: readonly (readonly [string, string])[], wave: number | null): Finding {
  const pairs = patterns.map(([x, y]) => `"${y}" and ${label(a)}'s "${x}"`);
  return {
    rule: 'collision-undecided',
    severity,
    message: `whether it can write a file ${label(a)} writes ${where(wave)} is undecided: the search met its budget for ${inWords(pairs)}`,
    file: b.file,
    line: lineOfField(b, 'affectedFiles') + 1,
    brief: b.id ?? undefined,
    hint: 'narrow one of the patterns, or run the two in different waves',
  };
}

/**
 * The report as findings. One pair of briefs is one finding, placed on the
 * later brief of the pair, which is usually the one still being written.
 */
export function collisionFindings(corpus: Corpus, report: CollisionReport): Finding[] {
  const findings: Finding[] = [];
  const collision = configuredSeverity(corpus, 'collision');
  const undecided = configuredSeverity(corpus, 'collision-undecided');
  const unscoped = configuredSeverity(corpus, 'unscoped');
  const sharedDirectory = configuredSeverity(corpus, 'shared-directory');
  for (const wave of report.waves) {
    if (collision !== null) {
      for (const c of wave.collisions) {
        findings.push({
          rule: 'collision',
          severity: collision,
          message: collisionMessage(c, wave.wave),
          file: c.b.file,
          line: lineOfField(c.b, 'affectedFiles') + 1,
          brief: c.b.id ?? undefined,
          hint: `run them in different waves, make one depend on the other, or narrow a scope`,
        });
      }
    }
    if (undecided !== null) {
      for (const u of wave.undecided) findings.push(undecidedFinding(undecided, u.a, u.b, u.patterns, wave.wave));
    }
    if (sharedDirectory !== null) {
      for (const s of wave.shared) {
        findings.push({
          rule: 'shared-directory',
          severity: sharedDirectory,
          message: `writes into ${inWords(s.directories.map((d) => `${d}/`))}, as ${label(s.a)} does ${where(wave.wave)}`,
          file: s.b.file,
          line: lineOfField(s.b, 'affectedFiles') + 1,
          brief: s.b.id ?? undefined,
          hint: 'check that the two do not depend on one decision in that directory; if they do, order them',
        });
      }
    }
    if (unscoped !== null) {
      for (const brief of wave.unscoped) findings.push(unscopedFinding(unscoped, brief, `the ${wave.briefs.length - 1} other brief(s) ${where(wave.wave)}`));
    }
  }
  return findings;
}

/** A brief with no scope, which nothing can be proved apart from. */
export function unscopedFinding(severity: Severity, brief: Brief, others: string): Finding {
  return {
    rule: 'unscoped',
    severity,
    message: `declares no affectedFiles, so it cannot be checked against ${others}`,
    file: brief.file,
    line: 1,
    brief: brief.id ?? undefined,
    hint: 'list the files or globs this round writes under "affectedFiles"',
  };
}
