/**
 * The collision matrix: which briefs scheduled to run side by side declare
 * scopes that can name the same file.
 *
 * Scopes are compared as globs, not as strings. `src/auth/**` and
 * `src/**\/session.ts` share no prefix a string comparison would see and both
 * cover `src/auth/session.ts`; the intersection finds that, and names the file.
 * A brief that declares no scope cannot be proven apart from anything, so it
 * is reported as unscoped rather than silently counted as safe.
 */

import type { Brief } from './brief.js';
import { lineOfField } from './brief.js';
import type { Corpus } from './corpus.js';
import { type Glob, globBase, intersectGlobs, parseGlob } from './glob.js';
import { severityOf } from './lint.js';
import { COLLISION_RULES, type RuleInfo } from './rules.js';
import type { Finding, Severity } from './types.js';

export interface Collision {
  readonly a: Brief;
  readonly b: Brief;
  readonly patterns: readonly [string, string];
  /** A path both scopes cover. */
  readonly witness: string;
}

export interface SharedDirectory {
  readonly a: Brief;
  readonly b: Brief;
  readonly directory: string;
}

export interface WaveMatrix {
  /** `null` when every live brief is compared regardless of wave. */
  readonly wave: number | null;
  readonly briefs: readonly Brief[];
  readonly collisions: readonly Collision[];
  readonly shared: readonly SharedDirectory[];
  readonly unscoped: readonly Brief[];
}

export interface CollisionReport {
  readonly waves: readonly WaveMatrix[];
  /** Live briefs with no wave, which the matrix does not place. */
  readonly unscheduled: readonly Brief[];
}

export interface CollisionOptions {
  /** Compare every live brief with every other, whatever its wave. */
  readonly all?: boolean;
  /** Tracked files, which tell a literal file path from a directory. */
  readonly repoFiles?: readonly string[] | null;
}

function scopes(brief: Brief, isFile: ((path: string) => boolean) | undefined): { pattern: string; glob: Glob }[] {
  return brief.affectedFiles.flatMap((pattern) => {
    const parsed = parseGlob(pattern, { isFile });
    return parsed.ok ? [{ pattern, glob: parsed.glob }] : [];
  });
}

function matrix(wave: number | null, briefs: readonly Brief[], isFile: ((path: string) => boolean) | undefined): WaveMatrix {
  const collisions: Collision[] = [];
  const shared: SharedDirectory[] = [];
  const scoped = briefs.map((brief) => ({ brief, scopes: scopes(brief, isFile) }));
  for (let i = 0; i < scoped.length; i += 1) {
    for (let j = i + 1; j < scoped.length; j += 1) {
      const left = scoped[i] as (typeof scoped)[number];
      const right = scoped[j] as (typeof scoped)[number];
      const found: Collision[] = [];
      for (const x of left.scopes) {
        for (const y of right.scopes) {
          const witness = intersectGlobs(x.glob, y.glob);
          if (witness !== null) found.push({ a: left.brief, b: right.brief, patterns: [x.pattern, y.pattern], witness });
        }
      }
      collisions.push(...found);
      if (found.length > 0) continue;
      const leftDirs = new Set(left.scopes.map((s) => globBase(s.glob)).filter((d) => d !== ''));
      const common = [...new Set(right.scopes.map((s) => globBase(s.glob)))].filter((d) => leftDirs.has(d)).sort();
      for (const directory of common) shared.push({ a: left.brief, b: right.brief, directory });
    }
  }
  const unscoped = briefs.length > 1 ? scoped.filter((s) => s.scopes.length === 0).map((s) => s.brief) : [];
  return { wave, briefs, collisions, shared, unscoped };
}

export function collisions(corpus: Corpus, options: CollisionOptions = {}): CollisionReport {
  const files = options.repoFiles === undefined || options.repoFiles === null ? null : new Set(options.repoFiles);
  const isFile = files === null ? undefined : (path: string): boolean => files.has(path);
  if (options.all === true) return { waves: [matrix(null, corpus.live, isFile)], unscheduled: [] };
  const byWave = new Map<number, Brief[]>();
  const unscheduled: Brief[] = [];
  for (const brief of corpus.live) {
    if (brief.wave === null) unscheduled.push(brief);
    else byWave.set(brief.wave, [...(byWave.get(brief.wave) ?? []), brief]);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b).map((wave) => matrix(wave, byWave.get(wave) as Brief[], isFile));
  return { waves, unscheduled };
}

function label(brief: Brief): string {
  return brief.id ?? brief.name;
}

function where(wave: number | null): string {
  return wave === null ? 'among the live briefs' : `in wave ${wave}`;
}

/**
 * The report as findings. One collision is one finding, placed on the later
 * brief of the pair, which is usually the one still being written.
 */
export function collisionFindings(corpus: Corpus, report: CollisionReport): Finding[] {
  const severity = (id: string): Severity | null => {
    const rule = COLLISION_RULES.find((r) => r.id === id) as RuleInfo;
    const setting = severityOf(corpus, id, rule.severity);
    return setting === 'off' ? null : setting;
  };
  const findings: Finding[] = [];
  const collision = severity('collision');
  const unscoped = severity('unscoped');
  const sharedDirectory = severity('shared-directory');
  for (const wave of report.waves) {
    if (collision !== null) {
      for (const c of wave.collisions) {
        findings.push({
          rule: 'collision',
          severity: collision,
          message: `"${c.patterns[1]}" overlaps ${label(c.a)}'s "${c.patterns[0]}" ${where(wave.wave)}; both cover ${c.witness}`,
          file: c.b.file,
          line: lineOfField(c.b, 'affectedFiles') + 1,
          brief: c.b.id ?? undefined,
          hint: `run them in different waves, make one depend on the other, or narrow a scope`,
        });
      }
    }
    if (sharedDirectory !== null) {
      for (const s of wave.shared) {
        findings.push({
          rule: 'shared-directory',
          severity: sharedDirectory,
          message: `writes into ${s.directory}/, as ${label(s.a)} does ${where(wave.wave)}`,
          file: s.b.file,
          line: lineOfField(s.b, 'affectedFiles') + 1,
          brief: s.b.id ?? undefined,
        });
      }
    }
    if (unscoped !== null) {
      for (const brief of wave.unscoped) {
        findings.push({
          rule: 'unscoped',
          severity: unscoped,
          message: `declares no affectedFiles, so it cannot be checked against the ${wave.briefs.length - 1} other brief(s) ${where(wave.wave)}`,
          file: brief.file,
          line: 1,
          brief: brief.id ?? undefined,
          hint: 'list the files or globs this round writes under "affectedFiles"',
        });
      }
    }
  }
  return findings;
}
