/**
 * Waves, computed: which live briefs can run side by side, so that no two in
 * one wave can write the same file and every brief runs after the briefs it
 * depends on.
 *
 * Deciding what the rounds of a goal are is prose, and an agent's work. Given
 * the rounds, placing them is not: it is precedence-constrained colouring, and
 * a tool answers it the same way every time (ADR-0011). Briefs are taken in
 * dependency order, ties broken by id, and each goes into the lowest wave that
 * is after every live dependency's and holds nothing it collides with. A brief
 * with no scope cannot be proved apart from anything, so it shares its wave
 * with nobody. The greedy answer is not always the fewest waves - no fast
 * method promises that - but it is always a valid one, and the same one.
 *
 * Nothing is written here. `planWaves` says what `--write` would write, and
 * the engine writes it as the archive writes, as one transaction.
 */

import type { FileOp } from './archive.js';
import { type Brief, lineOfField } from './brief.js';
import { undecidedFinding, unscopedFinding } from './collisions.js';
import { type Corpus, dependencyCycles, resolveDependency } from './corpus.js';
import { editable, setEntry } from './frontmatter.js';
import { readingIn, WITNESS_BUDGET } from './glob.js';
import { configuredSeverity } from './lint.js';
import { meet, type Overlap, type Scope, scopeOf } from './scope.js';
import { encodeLike } from './text.js';
import type { Finding } from './types.js';

export interface ScheduleOptions {
  /** The files the tree holds, which say whether a literal path is a file or a directory. */
  readonly repoFiles?: readonly string[] | null;
  /** How many states one witness search may visit before it answers `undecided`. */
  readonly budget?: number;
}

/** A wave a brief could not join, and the brief already there that kept it out. */
export type Passed =
  | { readonly wave: number; readonly reason: 'collision'; readonly brief: Brief; readonly overlaps: readonly Overlap[] }
  | { readonly wave: number; readonly reason: 'undecided'; readonly brief: Brief; readonly patterns: readonly (readonly [string, string])[] }
  /** One of the two declares no affectedFiles, and an unscoped brief runs alone. */
  | { readonly wave: number; readonly reason: 'unscoped'; readonly brief: Brief };

export interface Placement {
  readonly brief: Brief;
  /** The wave its front matter declares; `null` when it declares none it can read. */
  readonly declared: number | null;
  readonly proposed: number;
  /** The live dependency in the latest wave, which sets the earliest wave this one may run in. */
  readonly after: { readonly brief: Brief; readonly wave: number } | null;
  /** Every wave from that earliest one that it could not join, in order. Overlaps and patterns name its own pattern first. */
  readonly passed: readonly Passed[];
  /** Declares no affectedFiles, so it shares its wave with nobody. */
  readonly unscoped: boolean;
}

/** A live brief that can be placed in no wave, and the dependency that holds it. */
export interface Unplaced {
  readonly brief: Brief;
  readonly waitsOn: Brief;
  /** The dependency is deferred, is in a dependency cycle, or is itself unplaced. */
  readonly because: 'deferred' | 'cycle' | 'unplaced';
}

export interface Schedule {
  /** The first wave: the lowest any scheduled brief declares, or 1 when none declares one. */
  readonly first: number;
  /** In the order they were placed: dependency order, ties by id. */
  readonly placements: readonly Placement[];
  /** By id. */
  readonly unplaced: readonly Unplaced[];
  /** Dependency cycles among the scheduled briefs, each as a path back to its start. */
  readonly cycles: readonly (readonly Brief[])[];
  /** Deferred briefs, which wait for their trigger and run in no wave. By id. */
  readonly deferred: readonly Brief[];
}

function label(brief: Brief): string {
  return brief.id ?? brief.name;
}

/** Briefs by id, numbers by value; by path where two ids agree. */
export function byId(a: Brief, b: Brief): number {
  const x = label(a);
  const y = label(b);
  const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
  if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y);
  if (x < y) return -1;
  if (x > y) return 1;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** The live briefs a brief depends on, by id. Archived ones are done, and unknown ones are the dependency rule's. */
function liveDependencies(corpus: Corpus, brief: Brief): Brief[] {
  const targets = brief.dependsOn
    .map((d) => resolveDependency(corpus, d))
    .filter((t): t is Brief => t !== undefined && t !== brief && t.phase === 'live');
  return [...new Set(targets)].sort(byId);
}

/** The first brief in a wave this one cannot share it with, or `null` when it can join. */
function clash(own: Scope, wave: number, here: readonly Scope[], budget: number): Passed | null {
  for (const other of here) {
    if (own.affected.length === 0 || other.affected.length === 0) return { wave, reason: 'unscoped', brief: other.brief };
    const meeting = meet(own, other, budget);
    if (meeting.overlaps.length > 0) return { wave, reason: 'collision', brief: other.brief, overlaps: meeting.overlaps };
    if (meeting.undecided.length > 0) return { wave, reason: 'undecided', brief: other.brief, patterns: meeting.undecided };
  }
  return null;
}

export function schedule(corpus: Corpus, options: ScheduleOptions = {}): Schedule {
  const reading = readingIn(options.repoFiles ?? null);
  const budget = options.budget ?? WITNESS_BUDGET;
  const deferred = corpus.live.filter((b) => b.status === 'deferred').sort(byId);
  const briefs = corpus.live.filter((b) => b.status !== 'deferred').sort(byId);
  const dependencies = new Map(briefs.map((b) => [b, liveDependencies(corpus, b)]));
  const declared = briefs.flatMap((b) => (b.wave === null ? [] : [b.wave]));
  const first = declared.length === 0 ? 1 : Math.min(...declared);

  const waveOf = new Map<Brief, number>();
  const occupants = new Map<number, Scope[]>();
  const placements: Placement[] = [];
  const pending = [...briefs];
  // Kahn's order, taking the least id whose dependencies are all placed. A
  // brief waiting on a deferred one, or on a cycle, is never taken.
  for (;;) {
    const next = pending.find((b) => (dependencies.get(b) as Brief[]).every((d) => waveOf.has(d)));
    if (next === undefined) break;
    pending.splice(pending.indexOf(next), 1);
    let after: Placement['after'] = null;
    for (const dependency of dependencies.get(next) as Brief[]) {
      const wave = waveOf.get(dependency) as number;
      if (after === null || wave > after.wave) after = { brief: dependency, wave };
    }
    const own = scopeOf(next, reading);
    const passed: Passed[] = [];
    let wave = after === null ? first : after.wave + 1;
    // Ends by construction: a wave past every occupied one is empty, and an empty wave takes anyone.
    for (;;) {
      const found = clash(own, wave, occupants.get(wave) ?? [], budget);
      if (found === null) break;
      passed.push(found);
      wave += 1;
    }
    waveOf.set(next, wave);
    occupants.set(wave, [...(occupants.get(wave) ?? []), own]);
    placements.push({ brief: next, declared: next.wave, proposed: wave, after, passed, unscoped: own.affected.length === 0 });
  }

  const cycles = dependencyCycles(corpus).filter((cycle) => cycle.every((b) => b.status !== 'deferred'));
  const inCycle = new Set(cycles.flat());
  const unplaced = pending.map((brief): Unplaced => {
    const waitsOn = (dependencies.get(brief) as Brief[]).find((d) => !waveOf.has(d)) as Brief;
    const because = waitsOn.status === 'deferred' ? 'deferred' : inCycle.has(waitsOn) ? 'cycle' : 'unplaced';
    return { brief, waitsOn, because };
  });
  return { first, placements, unplaced, cycles, deferred };
}

/** The briefs whose declared wave the schedule would change. */
export function moves(s: Schedule): Placement[] {
  return s.placements.filter((p) => p.proposed !== p.declared);
}

/** Why a brief is in its wave and not an earlier one, a clause each. */
export function reasons(p: Placement): string[] {
  const out: string[] = [];
  if (p.after !== null) out.push(`after ${label(p.after.brief)}, in wave ${p.after.wave}`);
  if (p.unscoped && p.passed.length > 0) out.push('it declares no affectedFiles, so it runs in a wave of its own');
  for (const passed of p.passed) {
    const there = `not wave ${passed.wave}, where ${label(passed.brief)}`;
    if (passed.reason === 'collision') {
      const [overlap] = passed.overlaps as [Overlap];
      out.push(`${there} also writes ${overlap.witness} ("${overlap.patterns[0]}" and "${overlap.patterns[1]}")`);
    } else if (passed.reason === 'undecided') {
      out.push(`${there} may write the same files: the search could not decide within its budget`);
    } else if (!p.unscoped) {
      out.push(`${there} declares no affectedFiles and runs alone`);
    }
  }
  if (out.length === 0) out.push('nothing holds it later');
  return out;
}

/** The schedule as findings: cycles, briefs whose waves would move, briefs that run alone, and pairs it could not decide. */
export function scheduleFindings(corpus: Corpus, s: Schedule): Finding[] {
  const findings: Finding[] = [];
  const cycle = configuredSeverity(corpus, 'dependency-cycle');
  if (cycle !== null) {
    for (const members of s.cycles) {
      const start = members[0] as Brief;
      findings.push({
        rule: 'dependency-cycle',
        severity: cycle,
        message: `dependencies form a cycle, so no wave can hold them: ${members.map(label).join(' -> ')}`,
        file: start.file,
        line: lineOfField(start, 'dependsOn') + 1,
        brief: start.id ?? undefined,
        hint: 'a cycle can never become ready; remove the dependency that is not real',
      });
    }
  }
  const change = configuredSeverity(corpus, 'wave-schedule');
  if (change !== null) {
    for (const p of moves(s)) {
      const was = p.declared === null ? 'declares no wave' : `declares wave ${p.declared}`;
      findings.push({
        rule: 'wave-schedule',
        severity: change,
        message: `${was}; the schedule puts it in wave ${p.proposed}: ${reasons(p).join('; ')}`,
        file: p.brief.file,
        line: lineOfField(p.brief, 'wave') + 1,
        brief: p.brief.id ?? undefined,
        hint: `run "spec-brief schedule --write", or set "wave: ${p.proposed}"`,
      });
    }
  }
  const unscoped = configuredSeverity(corpus, 'unscoped');
  if (unscoped !== null && s.placements.length > 1) {
    for (const p of s.placements.filter((x) => x.unscoped)) {
      findings.push(unscopedFinding(unscoped, p.brief, `the ${s.placements.length - 1} other brief(s) the schedule places; it runs alone in wave ${p.proposed}`));
    }
  }
  const undecided = configuredSeverity(corpus, 'collision-undecided');
  if (undecided !== null) {
    for (const p of s.placements) {
      for (const passed of p.passed) {
        if (passed.reason !== 'undecided') continue;
        const theirsFirst = passed.patterns.map(([own, theirs]) => [theirs, own] as const);
        findings.push(undecidedFinding(undecided, passed.brief, p.brief, theirsFirst, passed.wave));
      }
    }
  }
  return findings;
}

export interface WavePlan {
  /** A write of each brief whose wave changes: its front matter's `wave`, and every other line as it was. */
  readonly ops: readonly FileOp[];
  /** Briefs whose wave cannot be written, which refuse the whole write. */
  readonly refused: readonly Finding[];
}

/** What `--write` writes. */
export function planWaves(s: Schedule): WavePlan {
  const ops: FileOp[] = [];
  const refused: Finding[] = [];
  for (const p of moves(s)) {
    const { brief } = p;
    if (brief.frontMatter !== null && !editable(brief.frontMatter)) {
      const open = brief.frontMatter.close < 0;
      refused.push({
        rule: 'front-matter',
        severity: 'error',
        message: `the front matter is ${open ? 'never closed' : 'TOML'}, so wave ${p.proposed} cannot be written into it`,
        file: brief.file,
        line: 1,
        brief: brief.id ?? undefined,
        hint: open ? 'close the front matter with a "---" line, and schedule again' : 'write the front matter as YAML between "---" lines, and schedule again',
      });
      continue;
    }
    const lines = setEntry(brief.lines, brief.frontMatter, 'wave', String(p.proposed));
    ops.push({ kind: 'write', path: brief.file, content: encodeLike(brief.source, lines), before: brief.source });
  }
  return { ops, refused };
}
