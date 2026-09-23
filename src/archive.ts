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
import { readFrontMatter, removeEntry, renderScalar, setEntry } from './frontmatter.js';
import type { CommitInfo, FileChange } from './git.js';
import { type Glob, matchGlob, parseGlob } from './glob.js';
import { INTEGRITY_FIELD, integrityOf } from './integrity.js';
import { dirOf, linesLinkingTo, normalisePath, rewriteLinks } from './links.js';
import type { Scan } from './markdown.js';
import { fillTemplate, joinLines, labelMatches, lineEnding, templateHoles } from './text.js';
import type { Finding, Severity } from './types.js';

export interface PullRequest {
  readonly number: number;
  readonly url: string | null;
}

export interface ArchiveRequest {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly summary?: string | undefined;
  readonly pr?: PullRequest | undefined;
  readonly commit?: CommitInfo | undefined;
  /** The files the round changed, when a commit is known. */
  readonly changes?: readonly FileChange[] | undefined;
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

function globs(patterns: readonly string[], isFile: (path: string) => boolean): Glob[] {
  return patterns.flatMap((p) => {
    const parsed = parseGlob(p, { isFile });
    return parsed.ok ? [parsed.glob] : [];
  });
}

/**
 * Whether an open box carries a note that closes it: "Delegated to ...",
 * "Rejected ...". The note belongs to the box above it, so the search stops at
 * the first nested box: a child's note does not close its parent.
 */
function dispositioned(scanned: Scan, line: number, end: number, markers: readonly string[]): boolean {
  const boxes = new Set(scanned.tasks.map((t) => t.line));
  for (let i = line; i < end; i += 1) {
    if (i > line && boxes.has(i)) return false;
    const text = scanned.masked[i] as string;
    if (markers.some((marker) => text.includes(marker))) return true;
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
 * pull-request sentence rather than a sentence with a hole in it.
 */
export function renderBanner(template: readonly string[], values: Readonly<Record<string, string>>): string[] {
  const kept = template
    .filter((line) => templateHoles(line).every((hole) => (values[hole] ?? '') !== ''))
    .map((line) => fillTemplate(line, values));
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

/** Lines written back with the source's byte-order mark, line ending and final newline, or lack of one. */
function encodeLike(source: string, lines: readonly string[]): string {
  const bom = source.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const eol = lineEnding(source);
  const text = joinLines(lines, eol);
  const finalNewline = source === '' || source.endsWith('\n');
  return `${bom}${finalNewline ? text : text.slice(0, text.length - eol.length)}`;
}

interface Inbound {
  readonly ops: FileOp[];
  readonly rewritten: string[];
  readonly frozen: { file: string; line: number }[];
}

/** Links other briefs hold to a file that is moving: rewritten in live briefs, reported in frozen ones. */
function inbound(corpus: Corpus, moving: Brief, to: string): Inbound {
  const result: Inbound = { ops: [], rewritten: [], frozen: [] };
  for (const other of corpus.briefs) {
    if (other === moving) continue;
    const directory = dirOf(other.file);
    const lines = linesLinkingTo(other.scan, directory, moving.file);
    if (lines.length === 0) continue;
    if (other.phase === 'archived') {
      for (const line of lines) result.frozen.push({ file: other.file, line: line + 1 });
      continue;
    }
    const rewritten = rewriteLinks(other.scan, directory, directory, (p) => (p === moving.file ? to : p));
    result.ops.push({ kind: 'write', path: other.file, content: encodeLike(other.source, rewritten.lines), before: other.source });
    result.rewritten.push(other.file);
  }
  return result;
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
  if (brief.status === 'draft') {
    blocking.push(
      problem(brief, 'archive-draft', 'error', lineOf(brief, config.status.field ?? 'status'), 'is a draft, and a draft has not been executed', `set "${config.status.field ?? 'status'}: ${config.status.active}" once the round runs`),
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
      const shown = outside.slice(0, 5).join(', ') + (outside.length > 5 ? `, and ${outside.length - 5} more` : '');
      blocking.push(
        problem(brief, 'dirty-tree', 'error', 1, `the working tree has uncommitted changes outside the briefs: ${shown}`, 'commit them so the recorded commit holds the round, or pass --allow-dirty'),
      );
    }
  }

  const work = (request.changes ?? []).filter((change) => !bookkeeping(change.path));
  // A path the round changed is a file, whatever its name looks like.
  const changed = new Set(work.map((c) => c.path));
  const isFile = (path: string): boolean => changed.has(path);
  const protectedGlobs = globs(brief.protectedFiles, isFile);
  const affectedGlobs = globs(brief.affectedFiles, isFile);
  for (const change of work) {
    if (protectedGlobs.some((g) => matchGlob(g, change.path))) {
      blocking.push(
        problem(brief, 'protected-file', 'error', lineOf(brief, 'protectedFiles'), `the round changed ${change.path}, which this brief protects`, 'revert the change, or record the departure in the brief before archiving it'),
      );
    }
  }
  // A protected file is reported once, as protected, and not again as out of scope.
  const unprotected = work.filter((c) => !protectedGlobs.some((g) => matchGlob(g, c.path)));
  const outside = affectedGlobs.length === 0 ? [] : unprotected.filter((c) => !affectedGlobs.some((g) => matchGlob(g, c.path)));
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).map((c) => c.path).join(', ') + (outside.length > 5 ? `, and ${outside.length - 5} more` : '');
    const finding = problem(
      brief,
      'out-of-scope',
      request.strict === true ? 'error' : 'warning',
      lineOf(brief, 'affectedFiles'),
      `the round changed ${outside.length} file(s) outside affectedFiles: ${shown}`,
      'widen affectedFiles if the scope was wrong, or say why in the summary',
    );
    (request.strict === true ? blocking : warnings).push(finding);
  }
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
  lines = withBanner(lines, banner);
  if (config.status.field !== null) {
    lines = setEntry(lines, readFrontMatter(lines), config.status.field, renderScalar(config.status.archived));
  }
  lines = removeEntry(lines, readFrontMatter(lines), INTEGRITY_FIELD);
  if (config.archiving.freeze) lines = withIntegrity(lines);

  const incoming = inbound(corpus, brief, to);
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

/**
 * Reopens an archived brief: the banner and the freeze come off, the status
 * goes back to the live word, and the links are rewritten for the directory
 * it returns to. What the round wrote stays in history, where it belongs.
 */
export function planUnarchive(corpus: Corpus, brief: Brief): Plan {
  if (brief.phase === 'live') return donePlan('unarchive', brief);
  const { config } = corpus;
  const briefsDir = normalisePath(config.briefs);
  const to = within(briefsDir, brief.name);
  const blocking: Finding[] = [];
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
  if (config.status.field !== null) {
    lines = setEntry(lines, readFrontMatter(lines), config.status.field, renderScalar(config.status.active));
  }

  const incoming = inbound(corpus, brief, to);
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
    warnings: [],
    linksRewritten,
    inboundRewritten: incoming.rewritten,
    inboundFrozen: incoming.frozen,
    banner: [],
    changes: [],
  };
}
