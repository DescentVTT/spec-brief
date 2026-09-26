/**
 * Archival and its reverse, planned.
 *
 * A plan is a pure function of the corpus and a request: what would be
 * refused and why, the text every touched file would hold afterwards, and the
 * operations that get there. Nothing is written here. `--dry-run` prints a
 * plan; `apply.ts` executes one as a transaction. Splitting the two is what
 * makes the ceremony testable without a disk and previewable without risk.
 */

import { BANNER_CLOSE, BANNER_OPEN, type Brief, lineOfField } from './brief.js';
import type { Config } from './config.js';
import { type Corpus, resolveDependency } from './corpus.js';
import { editable, readFrontMatter, removeEntry, renderScalar, setEntry } from './frontmatter.js';
import type { CommitInfo, FileChange } from './git.js';
import { type Glob, matchGlob, parseGlob } from './glob.js';
import { INTEGRITY_FIELD, integrityOf } from './integrity.js';
import { dirOf, linesLinkingTo, normalisePath, rewriteLinks } from './links.js';
import { configuredSeverity } from './lint.js';
import type { Scan } from './markdown.js';
import { encodeLike, fillTemplate, joinLines, labelMatches, templateHoles } from './text.js';
import type { Finding, Severity } from './types.js';

export interface PullRequest {
  readonly number: number;
  readonly url: string | null;
}

/**
 * Why the files a round changed are unknown. `git`: there was no git to ask.
 * `revision`: no commit was named and no base configured, so no diff was
 * read. `merged`: the commit is already in the base branch, so the diff from
 * their merge base is empty whatever the round changed - archiving on the base
 * branch after the merge.
 */
export type Unmeasured =
  | { readonly reason: 'git' }
  | { readonly reason: 'revision' }
  | { readonly reason: 'merged'; readonly base: string; readonly commit: string };

export interface ArchiveRequest {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly summary?: string | undefined;
  readonly pr?: PullRequest | undefined;
  readonly commit?: CommitInfo | undefined;
  /** The files the round changed, when they were read. */
  readonly changes?: readonly FileChange[] | undefined;
  /**
   * Why `changes` is missing, when the caller knows. Without changes the
   * scope checks have nothing to check, and a plan that said nothing would
   * read as a round that stayed in scope.
   */
  readonly unmeasured?: Unmeasured | undefined;
  /** Uncommitted paths, when the working tree was read. */
  readonly dirty?: readonly string[] | undefined;
  readonly allowDirty?: boolean | undefined;
  /** Out-of-scope changes refuse the archival instead of warning. */
  readonly strict?: boolean | undefined;
  /** The corpus's lint findings; errors on the brief refuse the archival. */
  readonly findings?: readonly Finding[] | undefined;
}

export type FileOp =
  | {
      readonly kind: 'write';
      readonly path: string;
      readonly content: string;
      /** What the file holds when the plan is made; `null` for a file that must not exist yet. */
      readonly before: string | null;
    }
  | { readonly kind: 'remove'; readonly path: string; readonly before: string };

export interface Plan {
  readonly action: 'archive' | 'unarchive';
  readonly brief: Brief;
  readonly from: string;
  readonly to: string;
  /** The brief is already where this action would put it. */
  readonly done: boolean;
  readonly ops: readonly FileOp[];
  /** Why the action is refused; empty when it may proceed. */
  readonly blocking: readonly Finding[];
  readonly warnings: readonly Finding[];
  readonly linksRewritten: number;
  readonly inboundRewritten: readonly string[];
  /** Links archived briefs hold to the old path. They are frozen and left as they are. */
  readonly inboundFrozen: readonly { readonly file: string; readonly line: number }[];
  readonly banner: readonly string[];
  readonly changes: readonly FileChange[];
}

function problem(
  brief: Brief,
  rule: string,
  severity: Severity,
  line: number,
  message: string,
  hint?: string,
): Finding {
  return { rule, severity, message, file: brief.file, line, brief: brief.id ?? undefined, hint };
}

function lineOf(brief: Brief, key: string): number {
  return lineOfField(brief, key) + 1;
}

function protectedFinding(brief: Brief, path: string): Finding {
  return {
    ...problem(brief, 'protected-file', 'error', lineOf(brief, 'protectedFiles'), `the round changed ${path}, which this brief protects`, 'revert the change, or record the departure in the brief before archiving it'),
    path,
  };
}

/**
 * The files a round changed outside its scope: one finding, since the scope
 * is one defect however many files show it - widened once, or explained once.
 */
function outOfScopeFinding(brief: Brief, paths: readonly string[], strict: boolean): Finding {
  return {
    ...problem(
      brief,
      'out-of-scope',
      strict ? 'error' : 'warning',
      lineOf(brief, 'affectedFiles'),
      `the round changed ${paths.length} file(s) outside affectedFiles: ${listed(paths)}`,
      'widen affectedFiles if the scope was wrong, or say why in the summary',
    ),
    paths,
  };
}

/** Where an archive rule's finding goes: an error refuses, and under --strict a warning refuses as an error, as out-of-scope does. */
function place(finding: Finding, strict: boolean, blocking: Finding[], warnings: Finding[]): void {
  if (finding.severity === 'error') blocking.push(finding);
  else if (strict && finding.severity === 'warning') blocking.push({ ...finding, severity: 'error' });
  else warnings.push(finding);
}

const UNMEASURED: Readonly<Record<Unmeasured['reason'], { readonly why: string; readonly hint: string }>> = {
  git: {
    why: 'without git, the files the round changed cannot be read',
    hint: 'archive inside the git work tree without --no-git, and name the round with --commit <rev> or --base <rev>',
  },
  revision: {
    why: 'no commit or base was named, so the files the round changed were not read',
    hint: 'pass --commit <rev> for the commit the round landed as, or --base <rev> for the branch it started from, or set "archiving.base"',
  },
  merged: {
    why: 'the diff from their merge base is empty',
    hint: "archive on the round's branch before it merges, or pass --base <rev> naming the commit the round started from",
  },
};

/**
 * The finding for scope checks that had nothing to check. A brief with no
 * scope has nothing to check either way, so it gets none.
 */
function unmeasuredScope(brief: Brief, request: ArchiveRequest, severity: Severity): Finding | null {
  const unmeasured = request.unmeasured ?? (request.changes === undefined ? { reason: 'revision' as const } : undefined);
  const fields = [
    ...(brief.protectedFiles.length > 0 ? ['protectedFiles'] : []),
    ...(brief.affectedFiles.length > 0 ? ['affectedFiles'] : []),
  ];
  if (unmeasured === undefined || fields.length === 0) return null;
  const { why, hint } = UNMEASURED[unmeasured.reason];
  const cause = unmeasured.reason === 'merged' ? `${unmeasured.commit.slice(0, 7)} is already in ${unmeasured.base}, so ${why}` : why;
  return problem(brief, 'scope-unmeasured', severity, lineOf(brief, fields[0] as string), `${fields.join(' and ')} went unchecked: ${cause}`, hint);
}

/**
 * Scope patterns, for matching the files a round changed. A changed path is a
 * file that exists or existed, so a literal pattern is read as either: its own
 * path, and everything beneath it. Nothing can lie beneath a file, so the
 * reading cannot invent a match, and the tree need not be asked - it has
 * changed since the scope was written, by the round itself.
 */
function globs(patterns: readonly string[]): Glob[] {
  return patterns.flatMap((p) => {
    const parsed = parseGlob(p, { literal: 'either' });
    return parsed.ok ? [parsed.glob] : [];
  });
}

/** Where a note's text starts: after its indentation and a list marker, if it has one. */
const NOTE_START = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?/;

/**
 * Whether an open box carries a note that closes it: a line under the box,
 * within its item, that starts with a disposition marker - "**Rejected** by
 * ...", "- **Delegated to** 012". The box's own line is the task, not a note
 * on it, and a marker in the middle of a sentence is a word in it: "Explain
 * why the **Rejected** designs failed" is an open task. The note belongs to
 * the box above it, so the search stops at the first nested box: a child's
 * note does not close its parent.
 *
 * Where the note starts is read from the line as written, and the marker from
 * the masked line, so a marker in code or a comment, or one after a code span,
 * closes nothing.
 */
function dispositioned(scanned: Scan, line: number, end: number, markers: readonly string[]): boolean {
  const boxes = new Set(scanned.tasks.map((t) => t.line));
  for (let i = line + 1; i < end; i += 1) {
    if (boxes.has(i)) return false;
    const start = (NOTE_START.exec(scanned.lines[i] as string) as RegExpExecArray)[0].length;
    const text = scanned.masked[i] as string;
    if (markers.some((marker) => text.startsWith(marker, start))) return true;
  }
  return false;
}

/** A path inside a directory that may be the root itself. */
function within(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

/**
 * Whether a path is a brief: a file directly in the live or archive directory
 * whose name the configuration takes for a brief. Edits to briefs are the
 * ceremony, not the round, and are left out of the scope and tree checks.
 * Nothing else in those directories is: a README beside the briefs is work.
 */
function isBriefPath(path: string, config: Config): boolean {
  const directory = dirOf(path);
  if (directory !== normalisePath(config.briefs) && directory !== normalisePath(config.archive)) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const accept = parseGlob(config.files);
  const excluded = config.exclude.some((e) => {
    const parsed = parseGlob(e);
    return parsed.ok && matchGlob(parsed.glob, name);
  });
  return accept.ok && matchGlob(accept.glob, name) && !excluded;
}

/** Task items that must be closed before a brief can be archived. */
export function openTasks(brief: Brief, corpus: Corpus): Brief['tasks'] {
  const { tasks: scope, dispositions } = corpus.config.archiving;
  const inScope =
    scope === 'all'
      ? brief.tasks
      : brief.tasks.filter((task) =>
          brief.sections.some(
            (s) => task.line > s.heading.line && task.line < s.end && scope.some((name) => labelMatches(s.heading.text, name)),
          ),
        );
  return inScope.filter((task) => !task.checked && !dispositioned(brief.scan, task.line, task.end, dispositions));
}

function diffstat(changes: readonly FileChange[]): string {
  const insertions = changes.reduce((sum, c) => sum + (c.insertions ?? 0), 0);
  const deletions = changes.reduce((sum, c) => sum + (c.deletions ?? 0), 0);
  const files = changes.length === 1 ? '1 file changed' : `${changes.length} files changed`;
  return `${files}, +${insertions} \u2212${deletions}`;
}

/**
 * The banner's lines, markers included. A template line whose placeholders
 * are not all filled is left out, so a round with no pull request has no
 * pull-request sentence rather than a sentence with a hole in it. A template
 * with nothing left writes no banner at all, markers included.
 */
export function renderBanner(template: readonly string[], values: Readonly<Record<string, string>>): string[] {
  const kept = template
    .filter((line) => templateHoles(line).every((hole) => (values[hole] ?? '') !== ''))
    .map((line) => fillTemplate(line, values));
  if (kept.length === 0) return [];
  return [BANNER_OPEN, ...kept.map((line) => (line === '' ? '>' : `> ${line}`)), BANNER_CLOSE];
}

/**
 * Removes a banner block and the blank line written after it. The exact
 * reverse of {@link withBanner}, so reopening a brief leaves its blank lines
 * as they were.
 */
function withoutBanner(lines: readonly string[], banner: Brief['banner']): string[] {
  if (banner === null) return [...lines];
  const after = lines[banner.end]?.trim() === '' ? banner.end + 1 : banner.end;
  return [...lines.slice(0, banner.start), ...lines.slice(after)];
}

/**
 * Inserts a banner under the front matter, after the blank line that usually
 * follows it, and writes one blank line after the banner.
 */
function withBanner(lines: readonly string[], banner: readonly string[]): string[] {
  const frontMatter = readFrontMatter(lines);
  let at = frontMatter === null || frontMatter.close < 0 ? 0 : frontMatter.close + 1;
  if (at > 0 && lines[at]?.trim() === '') at += 1;
  return [...lines.slice(0, at), ...banner, '', ...lines.slice(at)];
}

/**
 * Sets the integrity field to the hash of everything else. The field is put in
 * place before hashing, so the lines hashed are exactly the lines a later
 * check sees once it takes the field back out.
 */
function withIntegrity(lines: readonly string[]): string[] {
  const placed = setEntry(lines, readFrontMatter(lines), INTEGRITY_FIELD, 'pending');
  const hash = integrityOf(joinLines(placed, '\n'));
  return setEntry(placed, readFrontMatter(placed), INTEGRITY_FIELD, hash);
}

/**
 * Whether a plan can write into the brief's front matter: it has none, or one
 * closed and written in YAML. One never closed, or TOML, cannot be written
 * into. The front-matter rule reports both, and a plan that `edits` the front
 * matter and is not refused by it already - the rule lowered, or a reopening,
 * which lint does not gate - is refused here. It leaves the front matter as
 * written rather than half edited.
 */
function writable(brief: Brief, edits: boolean, blocking: Finding[]): boolean {
  const frontMatter = brief.frontMatter;
  if (frontMatter === null || editable(frontMatter)) return true;
  if (edits && !blocking.some((f) => f.rule === 'front-matter')) {
    const open = frontMatter.close < 0;
    blocking.push(
      problem(
        brief,
        'front-matter',
        'error',
        1,
        open ? 'the front matter is never closed, so it cannot be written into' : 'the front matter is TOML, which spec-brief does not write',
        open ? 'close the front matter with a "---" line' : 'write the front matter as YAML between "---" lines',
      ),
    );
  }
  return false;
}

interface Place {
  readonly file: string;
  readonly line: number;
}

interface Inbound {
  readonly ops: FileOp[];
  readonly rewritten: string[];
  readonly frozen: Place[];
  /** Links live briefs hold to it, left as they are because rewriting is off. */
  readonly stale: Place[];
}

/**
 * Links other briefs hold to a file that is moving: rewritten in live briefs,
 * reported in frozen ones. `archiving.rewriteLinks` governs these as it does
 * the moving brief's own links, so with it off a live brief is not written,
 * and the links it is left holding are reported instead.
 */
function inbound(corpus: Corpus, moving: Brief, to: string): Inbound {
  const result: Inbound = { ops: [], rewritten: [], frozen: [], stale: [] };
  for (const other of corpus.briefs) {
    if (other === moving) continue;
    const directory = dirOf(other.file);
    const lines = linesLinkingTo(other.scan, directory, moving.file);
    if (lines.length === 0) continue;
    if (other.phase === 'archived' || !corpus.config.archiving.rewriteLinks) {
      const left = other.phase === 'archived' ? result.frozen : result.stale;
      for (const line of lines) left.push({ file: other.file, line: line + 1 });
      continue;
    }
    const rewritten = rewriteLinks(other.scan, directory, directory, (p) => (p === moving.file ? to : p));
    result.ops.push({ kind: 'write', path: other.file, content: encodeLike(other.source, rewritten.lines), before: other.source });
    result.rewritten.push(other.file);
  }
  return result;
}

/** Five items, and a count of the rest. */
function listed(items: readonly string[]): string {
  return items.slice(0, 5).join(', ') + (items.length > 5 ? `, and ${items.length - 5} more` : '');
}

/**
 * Links live briefs will hold to nothing once the brief moves, when rewriting
 * is off: the move is what breaks them, so the move says where they are.
 */
function staleLinks(corpus: Corpus, brief: Brief, stale: readonly Place[], strict: boolean, blocking: Finding[], warnings: Finding[]): void {
  const severity = configuredSeverity(corpus, 'stale-link');
  if (severity === null || stale.length === 0) return;
  const finding = problem(
    brief,
    'stale-link',
    severity,
    1,
    `links on ${stale.length} line(s) of other live briefs will stop resolving when it moves: ${listed(stale.map((s) => `${s.file}:${s.line}`))}`,
    'turn "archiving.rewriteLinks" on to have them rewritten, or fix them by hand',
  );
  place(finding, strict, blocking, warnings);
}

function donePlan(action: Plan['action'], brief: Brief): Plan {
  return {
    action,
    brief,
    from: brief.file,
    to: brief.file,
    done: true,
    ops: [],
    blocking: [],
    warnings: [],
    linksRewritten: 0,
    inboundRewritten: [],
    inboundFrozen: [],
    banner: [],
    changes: [],
  };
}

export function planArchive(corpus: Corpus, brief: Brief, request: ArchiveRequest): Plan {
  if (brief.phase === 'archived') return donePlan('archive', brief);
  const { config } = corpus;
  const archiveDir = normalisePath(config.archive);
  const to = within(archiveDir, brief.name);
  const blocking: Finding[] = [];
  const warnings: Finding[] = [];

  // Under --strict a warning is an error, here as in lint.
  for (const finding of request.findings ?? []) {
    const refuses = finding.severity === 'error' || (request.strict === true && finding.severity === 'warning');
    if (finding.file === brief.file && refuses) blocking.push(finding);
  }
  // Only a status field can say "draft" or "deferred", so there is one to point at.
  const field = config.status.field as string;
  if (brief.status === 'draft') {
    blocking.push(
      problem(brief, 'archive-draft', 'error', lineOf(brief, field), 'is a draft, and a draft has not been executed', `set "${field}: ${config.status.active}" once the round runs`),
    );
  }
  if (brief.status === 'deferred') {
    blocking.push(
      problem(
        brief,
        'archive-deferred',
        'error',
        lineOf(brief, field),
        'is deferred, and deferred work has not been executed',
        `set "${field}: ${config.status.active}" when its trigger fires and the round runs`,
      ),
    );
  }
  for (const task of openTasks(brief, corpus)) {
    blocking.push(
      problem(
        brief,
        'open-task',
        'error',
        task.line + 1,
        `"${task.text === '' ? '(empty)' : task.text}" is neither ticked nor dispositioned`,
        `tick it, or say why under it with a note starting ${config.archiving.dispositions.map((d) => `"${d}"`).join(', ')}`,
      ),
    );
  }
  for (const dependency of brief.dependsOn) {
    const target = resolveDependency(corpus, dependency);
    if (target !== undefined && target !== brief && target.phase === 'live') {
      blocking.push(
        problem(brief, 'dependency-open', 'error', lineOf(brief, 'dependsOn'), `depends on ${target.id ?? target.name}, which is not archived yet`, `archive ${target.id ?? target.name} first, or drop the dependency if it was never real`),
      );
    }
  }
  const bookkeeping = (path: string): boolean => isBriefPath(path, config);
  if (request.dirty !== undefined && request.allowDirty !== true) {
    const outside = request.dirty.filter((path) => !bookkeeping(path));
    if (outside.length > 0) {
      blocking.push(
        problem(brief, 'dirty-tree', 'error', 1, `the working tree has uncommitted changes outside the briefs: ${listed(outside)}`, 'commit them so the recorded commit holds the round, or pass --allow-dirty'),
      );
    }
  }

  const work = (request.changes ?? []).filter((change) => !bookkeeping(change.path));
  const protectedGlobs = globs(brief.protectedFiles);
  const affectedGlobs = globs(brief.affectedFiles);
  // Each protected file changed is its own defect - reverted, or ruled on,
  // one file at a time - so each is a finding that names its path.
  for (const change of work) {
    if (protectedGlobs.some((g) => matchGlob(g, change.path))) blocking.push(protectedFinding(brief, change.path));
  }
  // A protected file is reported once, as protected, and not again as out of scope.
  const unprotected = work.filter((c) => !protectedGlobs.some((g) => matchGlob(g, c.path)));
  const outside = affectedGlobs.length === 0 ? [] : unprotected.filter((c) => !affectedGlobs.some((g) => matchGlob(g, c.path)));
  if (outside.length > 0) {
    const finding = outOfScopeFinding(brief, outside.map((c) => c.path), request.strict === true);
    (request.strict === true ? blocking : warnings).push(finding);
  }
  const scopeSeverity = configuredSeverity(corpus, 'scope-unmeasured');
  const unmeasured = scopeSeverity === null ? null : unmeasuredScope(brief, request, scopeSeverity);
  if (unmeasured !== null) place(unmeasured, request.strict === true, blocking, warnings);
  if (corpus.briefs.some((b) => b.file === to)) {
    blocking.push(problem(brief, 'archive-exists', 'error', 1, `${to} already exists`, 'an archived brief is never overwritten'));
  }

  let lines: string[] = [...brief.lines];
  let linksRewritten = 0;
  if (config.archiving.rewriteLinks) {
    const rewritten = rewriteLinks(brief.scan, dirOf(brief.file), archiveDir, (p) => (p === brief.file ? to : p));
    lines = rewritten.lines;
    linksRewritten = rewritten.count;
  }
  lines = withoutBanner(lines, brief.banner);

  const pr = request.pr;
  const values: Record<string, string> = {
    date: request.date,
    summary: request.summary?.trim() ?? '',
    pr: pr === undefined ? '' : pr.url === null ? `#${pr.number}` : `[#${pr.number}](${pr.url})`,
    commit: request.commit?.sha.slice(0, 7) ?? '',
    diffstat: request.commit === undefined || request.changes === undefined ? '' : diffstat(request.changes),
    links:
      linksRewritten === 0
        ? ''
        : `Relative links were rewritten to resolve from \`${archiveDir}/\` (${linksRewritten}); no other word changed.`,
    id: brief.id ?? '',
    title: brief.title ?? '',
    author: request.commit?.author ?? '',
  };
  const banner = renderBanner(config.archiving.banner, values);
  if (banner.length > 0) lines = withBanner(lines, banner);
  const writes = writable(brief, config.status.field !== null || config.archiving.freeze, blocking);
  if (writes && config.status.field !== null) {
    lines = setEntry(lines, readFrontMatter(lines), config.status.field, renderScalar(config.status.archived));
  }
  lines = removeEntry(lines, readFrontMatter(lines), INTEGRITY_FIELD);
  if (writes && config.archiving.freeze) lines = withIntegrity(lines);

  const incoming = inbound(corpus, brief, to);
  staleLinks(corpus, brief, incoming.stale, request.strict === true, blocking, warnings);
  return {
    action: 'archive',
    brief,
    from: brief.file,
    to,
    done: false,
    ops: [
      { kind: 'write', path: to, content: encodeLike(brief.source, lines), before: null },
      ...incoming.ops,
      { kind: 'remove', path: brief.file, before: brief.source },
    ],
    blocking,
    warnings,
    linksRewritten,
    inboundRewritten: incoming.rewritten,
    inboundFrozen: incoming.frozen,
    banner,
    changes: request.changes ?? [],
  };
}

/** A plugin's answer to a refusal it may lift: which rule, for which path, and why. */
export interface Waiver {
  readonly rule: string;
  readonly path: string;
  readonly reason: string;
}

/**
 * The refusals a plugin may lift. A tool that verifies a ruling can say a
 * protected file was allowed to change, or that a file outside the scope was;
 * whether a round is done is spec-brief's to say.
 */
export const WAIVABLE: readonly string[] = ['protected-file', 'out-of-scope'];

/**
 * The plan with the refusals plugins waived turned into notes. A waiver
 * matches a blocking finding by rule and path: a protected-file finding is
 * replaced by the note, and an out-of-scope finding loses the path and goes
 * when none is left. A waiver that matches nothing changes nothing, and one
 * for any other rule is ignored with a warning, which refuses under --strict
 * as any warning does.
 */
export function applyWaivers(plan: Plan, waivers: readonly { readonly plugin: string; readonly waiver: Waiver }[], strict = false): Plan {
  const { brief } = plan;
  const blocking = [...plan.blocking];
  const warnings = [...plan.warnings];
  for (const { plugin, waiver } of waivers) {
    if (!WAIVABLE.includes(waiver.rule)) {
      const ignored = problem(
        brief,
        'waiver-ignored',
        'warning',
        1,
        `${plugin} asked to waive ${waiver.rule} for ${waiver.path}; a plugin may waive only ${WAIVABLE.join(' and ')}`,
        `report it to the plugin's authors: ${waiver.rule} is spec-brief's to decide`,
      );
      place(ignored, strict, blocking, warnings);
      continue;
    }
    const at = blocking.findIndex((f) => f.rule === waiver.rule && (f.path === waiver.path || f.paths?.includes(waiver.path) === true));
    if (at < 0) continue;
    const found = blocking[at] as Finding;
    const rest = (found.paths ?? []).filter((p) => p !== waiver.path);
    blocking.splice(at, 1, ...(rest.length > 0 ? [outOfScopeFinding(brief, rest, true)] : []));
    warnings.push({
      ...problem(brief, 'waived', 'note', found.line, `${plugin} waives ${waiver.rule} for ${waiver.path}: ${waiver.reason}`, 'review the waiver with the round; it stands where the refusal was'),
      path: waiver.path,
    });
  }
  return { ...plan, blocking, warnings };
}

export interface UnarchiveRequest {
  /** Warnings refuse the reopening, as they fail lint. */
  readonly strict?: boolean | undefined;
}

/**
 * Reopens an archived brief: the banner and the freeze come off, the status
 * goes back to the live word, and the links are rewritten for the directory
 * it returns to. What the round wrote stays in history, where it belongs.
 */
export function planUnarchive(corpus: Corpus, brief: Brief, request: UnarchiveRequest = {}): Plan {
  if (brief.phase === 'live') return donePlan('unarchive', brief);
  const { config } = corpus;
  const briefsDir = normalisePath(config.briefs);
  const to = within(briefsDir, brief.name);
  const blocking: Finding[] = [];
  const warnings: Finding[] = [];
  if (corpus.briefs.some((b) => b.file === to)) {
    blocking.push(problem(brief, 'unarchive-exists', 'error', 1, `${to} already exists`, 'rename one of them first'));
  }

  let lines: string[] = [...brief.lines];
  let linksRewritten = 0;
  if (config.archiving.rewriteLinks) {
    const rewritten = rewriteLinks(brief.scan, dirOf(brief.file), briefsDir, (p) => (p === brief.file ? to : p));
    lines = rewritten.lines;
    linksRewritten = rewritten.count;
  }
  lines = withoutBanner(lines, brief.banner);
  lines = removeEntry(lines, readFrontMatter(lines), INTEGRITY_FIELD);
  const field = config.status.field;
  if (writable(brief, field !== null, blocking) && field !== null) {
    lines = setEntry(lines, readFrontMatter(lines), field, renderScalar(config.status.active));
  }

  const incoming = inbound(corpus, brief, to);
  staleLinks(corpus, brief, incoming.stale, request.strict === true, blocking, warnings);
  return {
    action: 'unarchive',
    brief,
    from: brief.file,
    to,
    done: false,
    ops: [
      { kind: 'write', path: to, content: encodeLike(brief.source, lines), before: null },
      ...incoming.ops,
      { kind: 'remove', path: brief.file, before: brief.source },
    ],
    blocking,
    warnings,
    linksRewritten,
    inboundRewritten: incoming.rewritten,
    inboundFrozen: incoming.frozen,
    banner: [],
    changes: [],
  };
}
