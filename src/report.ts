/**
 * Rendering: findings, lists, the collision matrix and plans, for a person at
 * a terminal or for the machine reading the job.
 *
 * `json` is a document with a version, for orchestrators. `sarif` is SARIF
 * 2.1.0, for code-scanning upload. `github` is workflow commands, which put a
 * finding on the line of the pull request with no upload and no permission.
 * `gitlab` is a Code Quality report, the artifact a GitLab merge request reads,
 * so the family is not GitHub's alone.
 */

import { createHash } from 'node:crypto';

import type { Plan } from './archive.js';
import type { Brief } from './brief.js';
import type { Config, SectionRule } from './config.js';
import type { CollisionReport } from './collisions.js';
import { summarise } from './lint.js';
import { ARCHIVE_RULES, COLLISION_RULES, RULES } from './rules.js';
import { moves, type Passed, reasons, type Schedule } from './schedule.js';
import { inWords } from './text.js';
import type { Finding, Severity } from './types.js';

export type Format = 'pretty' | 'json' | 'sarif' | 'github' | 'gitlab';

export const FORMATS: readonly Format[] = ['pretty', 'json', 'sarif', 'github', 'gitlab'];

/**
 * The version of the JSON documents this tool prints, every command's alike.
 * Bumped when a field changes meaning. 2: a collision in `matrix` is a pair of
 * briefs, with every pair of patterns that meets and a witness that is always
 * a file; a shared-directory entry lists its directories; and deferred briefs,
 * and the briefs waiting on them, leave `waves[].briefs` for `deferred` and
 * `waiting`.
 */
export const JSON_SCHEMA_VERSION = 2;

export interface Style {
  readonly color: boolean;
}

const CODES: Readonly<Record<string, readonly [number, number]>> = {
  red: [31, 39],
  yellow: [33, 39],
  cyan: [36, 39],
  green: [32, 39],
  dim: [2, 22],
  bold: [1, 22],
};

export function paint(style: Style, color: keyof typeof CODES, text: string): string {
  const code = CODES[color];
  return style.color && code !== undefined ? `\u001b[${code[0]}m${text}\u001b[${code[1]}m` : text;
}

const SEVERITY_COLOR: Readonly<Record<Severity, keyof typeof CODES>> = { error: 'red', warning: 'yellow', note: 'cyan' };

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function summaryLine(findings: readonly Finding[]): string {
  const s = summarise(findings);
  return `${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')}, ${plural(s.notes, 'note')}`;
}

export function prettyFindings(findings: readonly Finding[], style: Style): string {
  const out: string[] = [];
  let file: string | undefined;
  const width = Math.max(1, ...findings.map((f) => String(f.line).length));
  for (const f of findings) {
    if (f.file !== file) {
      if (file !== undefined) out.push('');
      out.push(paint(style, 'bold', f.file));
      file = f.file;
    }
    const severity = paint(style, SEVERITY_COLOR[f.severity], f.severity.padEnd(7));
    out.push(`  ${String(f.line).padStart(width)}  ${severity}  ${f.message}  ${paint(style, 'dim', f.rule)}`);
    if (f.hint !== undefined) out.push(`  ${' '.repeat(width)}           ${paint(style, 'dim', f.hint)}`);
  }
  return out.join('\n');
}

export function jsonDocument(command: string, version: string, body: Record<string, unknown>): string {
  return `${JSON.stringify({ tool: 'spec-brief', version, schemaVersion: JSON_SCHEMA_VERSION, command, ...body }, null, 2)}\n`;
}

export function findingJson(f: Finding): Record<string, unknown> {
  const out: Record<string, unknown> = { rule: f.rule, severity: f.severity, file: f.file, line: f.line, message: f.message };
  if (f.brief !== undefined) out['brief'] = f.brief;
  if (f.hint !== undefined) out['hint'] = f.hint;
  if (f.path !== undefined) out['path'] = f.path;
  if (f.paths !== undefined) out['paths'] = f.paths;
  return out;
}

const SARIF_LEVEL: Readonly<Record<Severity, string>> = { error: 'error', warning: 'warning', note: 'note' };

export function sarif(findings: readonly Finding[], version: string): string {
  const described = new Map([...RULES, ...COLLISION_RULES, ...ARCHIVE_RULES].map((r) => [r.id, r]));
  const ids = [...new Set(findings.map((f) => f.rule))].sort();
  const document = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'spec-brief',
            version,
            informationUri: 'https://github.com/DescentVTT/spec-brief',
            rules: ids.map((id) => {
              const rule = described.get(id);
              return {
                id,
                shortDescription: { text: rule?.description ?? id },
                ...(rule !== undefined && rule.severity !== 'off'
                  ? { defaultConfiguration: { level: SARIF_LEVEL[rule.severity] } }
                  : {}),
              };
            }),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.rule,
          level: SARIF_LEVEL[f.severity],
          message: { text: f.hint === undefined ? f.message : `${f.message}. ${f.hint}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
                region: { startLine: f.line },
              },
            },
          ],
        })),
      },
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * GitLab's Code Quality severities. An error fails the run but is not a
 * security hole or a crash, which is what `critical` and `blocker` say in
 * GitLab's own reports, so the scale tops out at `major`.
 */
const GITLAB_SEVERITY: Readonly<Record<Severity, string>> = { error: 'major', warning: 'minor', note: 'info' };

/**
 * GitLab Code Quality: a JSON array of issues, which a merge request shows
 * beside the lines they are on. The fingerprint is how GitLab tells a new
 * issue from one it has seen, so it hashes the rule, the file and the message
 * and not the line: a finding that moves down a page is the same finding. Two
 * findings with the same three - a section duplicated twice - are told apart
 * by their order.
 */
export function gitlabCodeQuality(findings: readonly Finding[]): string {
  const seen = new Map<string, number>();
  const issues = findings.map((f) => {
    const key = `${f.rule}\u0000${f.file}\u0000${f.message}`;
    const repeat = seen.get(key) ?? 0;
    seen.set(key, repeat + 1);
    return {
      description: f.hint === undefined ? f.message : `${f.message}. ${f.hint}`,
      check_name: f.rule,
      fingerprint: createHash('sha256').update(repeat === 0 ? key : `${key}\u0000${repeat}`).digest('hex'),
      severity: GITLAB_SEVERITY[f.severity],
      location: { path: f.file, lines: { begin: f.line } },
    };
  });
  return `${JSON.stringify(issues, null, 2)}\n`;
}

function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

const GITHUB_COMMAND: Readonly<Record<Severity, string>> = { error: 'error', warning: 'warning', note: 'notice' };

export function githubCommands(findings: readonly Finding[]): string {
  return findings
    .map((f) => {
      const message = f.hint === undefined ? f.message : `${f.message}. ${f.hint}`;
      const properties = `file=${escapeProperty(f.file)},line=${f.line},title=${escapeProperty(`spec-brief ${f.rule}`)}`;
      return `::${GITHUB_COMMAND[f.severity]} ${properties}::${escapeData(message)}\n`;
    })
    .join('');
}

export function briefJson(brief: Brief, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: brief.id,
    file: brief.file,
    title: brief.title,
    phase: brief.phase,
    status: brief.status,
    type: brief.type,
    wave: brief.wave,
    dependsOn: brief.dependsOn,
    affectedFiles: brief.affectedFiles,
    protectedFiles: brief.protectedFiles,
    trigger: brief.trigger,
    tasks: { total: brief.tasks.length, checked: brief.tasks.filter((t) => t.checked).length },
    ...extra,
  };
}

/**
 * The sections the configuration asks for, each with what it must answer:
 * those every live brief carries, with `type` null, then those each type adds.
 * A tool that helps write a brief asks for these rather than for names it
 * knows in advance.
 */
export function sectionsJson(config: Config): Record<string, unknown>[] {
  const describe = (rule: SectionRule, type: string | null): Record<string, unknown> => ({
    name: rule.name,
    type,
    aliases: rule.aliases,
    optional: rule.optional,
    checklist: rule.checklist,
    mustContain: rule.mustContain,
    hint: rule.hint ?? null,
  });
  return [
    ...config.sections.map((rule) => describe(rule, null)),
    ...Object.entries(config.types).flatMap(([type, rules]) => rules.map((rule) => describe(rule, type))),
  ];
}

/** Columns padded to their widest cell; every row has the header's length. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] as string).length)));
  return all.map((r) =>
    r
      .map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] as number)))
      .join('  ')
      .trimEnd(),
  );
}

export interface ListRow {
  readonly brief: Brief;
  readonly ready: boolean;
  readonly waitingOn: readonly string[];
}

export function prettyList(rows: readonly ListRow[], style: Style): string {
  if (rows.length === 0) return 'no briefs';
  const lines = table(
    ['ID', 'STATUS', 'WAVE', 'TASKS', 'READY', 'TITLE'],
    rows.map(({ brief, ready, waitingOn }) => [
      brief.id ?? '?',
      brief.status ?? brief.statusWord ?? '?',
      brief.wave === null ? '-' : String(brief.wave),
      `${brief.tasks.filter((t) => t.checked).length}/${brief.tasks.length}`,
      brief.phase === 'archived' ? '-' : ready ? 'yes' : waitingOn.length > 0 ? `after ${waitingOn.join(', ')}` : 'no',
      brief.title ?? brief.name,
    ]),
  );
  return [paint(style, 'dim', lines[0] as string), ...lines.slice(1)].join('\n');
}

export function prettyMatrix(report: CollisionReport, style: Style): string {
  const out: string[] = [];
  const label = (b: Brief): string => b.id ?? b.name;
  for (const wave of report.waves) {
    const title = wave.wave === null ? 'all live briefs' : `wave ${wave.wave}`;
    out.push(paint(style, 'bold', `${title} \u00b7 ${plural(wave.briefs.length, 'brief')}`));
    const names = wave.briefs.map(label);
    const width = Math.max(3, ...names.map((n) => n.length));
    const pairs = (list: readonly { readonly a: Brief; readonly b: Brief }[]): Set<string> =>
      new Set(list.flatMap((p) => [`${label(p.a)}\u0000${label(p.b)}`, `${label(p.b)}\u0000${label(p.a)}`]));
    const hits = pairs(wave.collisions);
    const unknown = pairs(wave.undecided);
    const near = pairs(wave.shared);
    out.push(`  ${''.padEnd(width)}  ${names.map((n) => n.padStart(width)).join('  ')}`);
    for (const row of names) {
      const cells = names.map((col) => {
        const key = `${row}\u0000${col}`;
        const mark =
          row === col
            ? '\u00b7'
            : hits.has(key)
              ? paint(style, 'red', 'X')
              : unknown.has(key)
                ? paint(style, 'yellow', '?')
                : near.has(key)
                  ? paint(style, 'yellow', '~')
                  : '\u00b7';
        return `${' '.repeat(width - 1)}${mark}`;
      });
      out.push(`  ${row.padEnd(width)}  ${cells.join('  ')}`);
    }
    // One mark per pair of briefs; each further pair of patterns on a line beneath it.
    for (const c of wave.collisions) {
      c.overlaps.forEach((o, i) => {
        out.push(`  ${i === 0 ? paint(style, 'red', 'X') : ' '} ${label(c.a)} "${o.patterns[0]}" and ${label(c.b)} "${o.patterns[1]}" both cover ${o.witness}`);
      });
    }
    for (const u of wave.undecided) {
      u.patterns.forEach(([x, y], i) => {
        out.push(`  ${i === 0 ? paint(style, 'yellow', '?') : ' '} ${label(u.a)} "${x}" and ${label(u.b)} "${y}": undecided within the search's budget`);
      });
    }
    for (const s of wave.shared) {
      out.push(`  ${paint(style, 'yellow', '~')} ${label(s.a)} and ${label(s.b)} both write into ${inWords(s.directories.map((d) => `${d}/`))}`);
    }
    for (const b of wave.unscoped) {
      out.push(`  ${paint(style, 'cyan', '?')} ${label(b)} declares no affectedFiles and cannot be checked`);
    }
    out.push('');
  }
  if (report.unscheduled.length > 0) {
    out.push(paint(style, 'dim', `no wave: ${report.unscheduled.map(label).join(', ')}`));
  }
  for (const w of report.waiting) {
    const why = w.waitsOn.status === 'deferred' ? 'which is deferred' : 'which waits on deferred work';
    out.push(`${paint(style, 'dim', 'waits:')} ${label(w.brief)} on ${label(w.waitsOn)}, ${why}`);
  }
  if (report.deferred.length > 0) {
    out.push(paint(style, 'dim', `deferred: ${report.deferred.map(label).join(', ')}`));
  }
  if (report.waves.length === 0 && report.unscheduled.length === 0 && report.deferred.length === 0) out.push('no live briefs');
  return out.join('\n').trimEnd();
}

/** The matrix as JSON: briefs by id, and a collision per pair of briefs. */
export function matrixJson(report: CollisionReport): Record<string, unknown> {
  return {
    waves: report.waves.map((w) => ({
      wave: w.wave,
      briefs: w.briefs.map((b) => b.id),
      collisions: w.collisions.map((c) => ({
        a: c.a.id,
        b: c.b.id,
        overlaps: c.overlaps.map((o) => ({ patterns: o.patterns, witness: o.witness })),
      })),
      undecided: w.undecided.map((u) => ({ a: u.a.id, b: u.b.id, patterns: u.patterns })),
      sharedDirectories: w.shared.map((s) => ({ a: s.a.id, b: s.b.id, directories: s.directories })),
      unscoped: w.unscoped.map((b) => b.id),
    })),
    unscheduled: report.unscheduled.map((b) => b.id),
    deferred: report.deferred.map((b) => b.id),
    waiting: report.waiting.map((w) => ({ id: w.brief.id, file: w.brief.file, waitsOn: w.waitsOn.id })),
  };
}

/**
 * The waves a schedule uses, in order. They appear in order too: a brief goes
 * into a wave only when it is the first or the one before it is occupied.
 */
function wavesOf(s: Schedule): number[] {
  return [...new Set(s.placements.map((p) => p.proposed))];
}

/**
 * The schedule for a person: each wave with its briefs, and under a brief whose
 * wave would change, why it goes where it goes. `written` is `null` when
 * nothing was asked to be written.
 */
export function prettySchedule(s: Schedule, written: readonly string[] | null, style: Style): string {
  const label = (b: Brief): string => b.id ?? b.name;
  const out: string[] = [];
  const width = Math.max(3, ...s.placements.map((p) => label(p.brief).length));
  const titleOf = (b: Brief): string => b.title ?? b.name;
  const titles = Math.max(0, ...s.placements.map((p) => titleOf(p.brief).length));
  const waves = wavesOf(s);
  for (const wave of waves) {
    const here = s.placements.filter((p) => p.proposed === wave);
    out.push(paint(style, 'bold', `wave ${wave} · ${plural(here.length, 'brief')}`));
    for (const p of here) {
      const title = titleOf(p.brief);
      if (p.proposed === p.declared) {
        out.push(`  ${label(p.brief).padEnd(width)}  ${title}`);
        continue;
      }
      const from = p.declared === null ? 'no wave' : `wave ${p.declared}`;
      out.push(`  ${label(p.brief).padEnd(width)}  ${title.padEnd(titles)}  ${paint(style, 'yellow', `moves from ${from}`)}`);
      for (const reason of reasons(p)) out.push(`  ${' '.repeat(width)}    ${paint(style, 'dim', reason)}`);
    }
  }
  if (waves.length > 0) out.push('');
  for (const cycle of s.cycles) out.push(`${paint(style, 'red', 'cycle:')} ${cycle.map(label).join(' -> ')}`);
  for (const u of s.unplaced) {
    const why = u.because === 'deferred' ? 'which is deferred' : u.because === 'cycle' ? 'which is in a cycle' : 'which is not placed';
    out.push(`${paint(style, 'dim', 'waits:')} ${label(u.brief)} on ${label(u.waitsOn)}, ${why}`);
  }
  if (s.deferred.length > 0) out.push(paint(style, 'dim', `deferred: ${s.deferred.map(label).join(', ')}`));
  const moving = moves(s).length;
  if (written !== null && written.length > 0) {
    out.push(`wrote the wave of ${plural(written.length, 'brief')}: ${written.join(', ')}`);
  } else if (written !== null && moving > 0) {
    out.push(paint(style, 'red', s.cycles.length > 0 ? 'nothing was written: the dependencies form a cycle' : 'nothing was written: a front matter cannot be edited'));
  } else if (moving > 0) {
    out.push(`${plural(moving, 'brief')} would move; "spec-brief schedule --write" writes the waves`);
  } else if (s.placements.length > 0) {
    out.push('the declared waves hold');
  } else if (s.cycles.length === 0 && s.deferred.length === 0) {
    // A brief is unplaced only behind a cycle or a deferral, so this is a corpus with no live brief.
    out.push('no live briefs');
  }
  return out.join('\n');
}

/** The schedule as JSON: a row per placed brief with its declared and proposed wave and why. */
export function scheduleJson(s: Schedule): Record<string, unknown> {
  const passed = (p: Passed): Record<string, unknown> => {
    const base = { wave: p.wave, reason: p.reason, brief: p.brief.id };
    if (p.reason === 'collision') return { ...base, overlaps: p.overlaps.map((o) => ({ patterns: o.patterns, witness: o.witness })) };
    if (p.reason === 'undecided') return { ...base, patterns: p.patterns };
    return base;
  };
  const waves = wavesOf(s);
  return {
    first: s.first,
    waves: waves.map((wave) => ({ wave, briefs: s.placements.filter((p) => p.proposed === wave).map((p) => p.brief.id) })),
    briefs: s.placements.map((p) => ({
      id: p.brief.id,
      file: p.brief.file,
      declared: p.declared,
      proposed: p.proposed,
      moves: p.proposed !== p.declared,
      after: p.after === null ? null : { brief: p.after.brief.id, wave: p.after.wave },
      passed: p.passed.map(passed),
      unscoped: p.unscoped,
      reasons: reasons(p),
    })),
    unplaced: s.unplaced.map((u) => ({ id: u.brief.id, file: u.brief.file, waitsOn: u.waitsOn.id, because: u.because })),
    cycles: s.cycles.map((cycle) => cycle.map((b) => b.id)),
    deferred: s.deferred.map((b) => b.id),
  };
}

export function prettyPlan(plan: Plan, dryRun: boolean, style: Style): string {
  const out: string[] = [];
  const verb = plan.action === 'archive' ? 'archive' : 'unarchive';
  if (plan.done) return `${plan.brief.file} is already ${plan.action === 'archive' ? 'archived' : 'live'}; nothing to do`;
  if (plan.blocking.length > 0) {
    out.push(paint(style, 'red', `cannot ${verb} ${plan.brief.file}:`), prettyFindings(plan.blocking, style));
    if (plan.warnings.length > 0) out.push('', prettyFindings(plan.warnings, style));
    return out.join('\n');
  }
  out.push(`${dryRun ? 'would move' : 'moved'} ${plan.from} -> ${plan.to}`);
  if (plan.linksRewritten > 0) out.push(`  ${plural(plan.linksRewritten, 'relative link')} rewritten`);
  for (const file of plan.inboundRewritten) out.push(`  ${file}: links to it rewritten`);
  for (const f of plan.inboundFrozen) out.push(`  ${f.file}:${f.line}: links to the old path, and is frozen, so it was left as it is`);
  if (plan.changes.length > 0) out.push(`  the round changed ${plural(plan.changes.length, 'file')}`);
  if (plan.warnings.length > 0) out.push('', prettyFindings(plan.warnings, style));
  if (dryRun && plan.banner.length > 0) out.push('', paint(style, 'dim', 'banner:'), ...plan.banner.map((l) => `  ${l}`));
  if (!dryRun) out.push('', paint(style, 'dim', 'nothing was committed; review the change and commit it with the round'));
  return out.join('\n');
}

export function planJson(plan: Plan): Record<string, unknown> {
  return {
    action: plan.action,
    brief: plan.brief.id,
    from: plan.from,
    to: plan.to,
    done: plan.done,
    refused: plan.blocking.length > 0,
    blocking: plan.blocking.map(findingJson),
    warnings: plan.warnings.map(findingJson),
    linksRewritten: plan.linksRewritten,
    inboundRewritten: plan.inboundRewritten,
    inboundFrozen: plan.inboundFrozen,
    operations: plan.ops.map((op) => ({ kind: op.kind, path: op.path })),
    banner: plan.banner,
    changes: plan.changes,
  };
}
