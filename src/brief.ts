/**
 * One brief, read: its identity, its front matter, its sections and its task
 * items. A pure function of a file's path and text.
 */

import type { Config } from './config.js';
import { findEntry, isNull, keyName, readFrontMatter, type FrontMatter, type YamlValue } from './frontmatter.js';
import { scan, sectionsOf, titleOf, type Scan, type Section, type TaskItem } from './markdown.js';
import { splitLines, stripBom } from './text.js';
import type { Phase, Status } from './types.js';

export const BANNER_OPEN = '<!-- spec-brief:banner -->';
export const BANNER_CLOSE = '<!-- /spec-brief:banner -->';

/** Front-matter keys spec-brief itself reads, in the spelling it documents. */
export const BUILT_IN_FIELDS: readonly string[] = [
  'id',
  'title',
  'type',
  'status',
  'date',
  'wave',
  'dependsOn',
  'affectedFiles',
  'protectedFiles',
  'integrity',
];

export interface FieldProblem {
  readonly field: string;
  /** 0-based line. */
  readonly line: number;
  readonly message: string;
}

export interface Brief {
  /** `null` when no id can be read, which a rule reports. */
  readonly id: string | null;
  /** Repository-relative path. */
  readonly file: string;
  /** The file name. */
  readonly name: string;
  readonly phase: Phase;
  /** The file exactly as read, byte-order mark and line endings included. */
  readonly source: string;
  /** The text parsed: the source without a byte-order mark. */
  readonly text: string;
  readonly lines: readonly string[];
  readonly frontMatter: FrontMatter | null;
  /** 0-based first line after the front matter. */
  readonly bodyStart: number;
  readonly scan: Scan;
  readonly sections: readonly Section[];
  readonly tasks: readonly TaskItem[];
  readonly title: string | null;
  readonly status: Status | null;
  readonly statusWord: string | null;
  readonly type: string | null;
  readonly wave: number | null;
  readonly dependsOn: readonly string[];
  readonly affectedFiles: readonly string[];
  readonly protectedFiles: readonly string[];
  readonly integrity: string | null;
  /** The frozen banner's lines, markers included, end exclusive. */
  readonly banner: { readonly start: number; readonly end: number } | null;
  readonly problems: readonly FieldProblem[];
}

function valueText(value: YamlValue): string | null | { readonly problem: string } {
  if (value.kind === 'unsupported') return { problem: value.reason };
  if (value.kind === 'list') return { problem: 'must be a single value, not a list' };
  return isNull(value.scalar) ? null : value.scalar.text;
}

function valueList(value: YamlValue): string[] | { readonly problem: string } {
  if (value.kind === 'unsupported') return { problem: value.reason };
  if (value.kind === 'scalar') return isNull(value.scalar) ? [] : [value.scalar.text];
  const empty = value.items.find((item) => isNull(item) || item.text.trim() === '');
  if (empty !== undefined) return { problem: 'must not contain an empty item' };
  return value.items.map((item) => item.text.trim());
}

/** The id a file name carries: everything before the separator, or the whole stem. */
export function idFromName(name: string, separator: string): string {
  const stem = name.replace(/\.md$/i, '');
  const at = stem.indexOf(separator);
  return at > 0 ? stem.slice(0, at) : stem;
}

function statusFrom(word: string | null, config: Config, phase: Phase): Status | null {
  if (config.status.field === null) return phase === 'archived' ? 'archived' : 'active';
  if (word === null) return null;
  const lower = word.toLowerCase();
  if (lower === config.status.archived.toLowerCase()) return 'archived';
  if (lower === config.status.active.toLowerCase()) return 'active';
  if (config.status.draft !== null && lower === config.status.draft.toLowerCase()) return 'draft';
  return null;
}

export function parseBrief(file: string, text: string, config: Config, phase: Phase): Brief {
  const content = stripBom(text);
  const lines = splitLines(content);
  const frontMatter = readFrontMatter(lines);
  const bodyStart = frontMatter === null || frontMatter.close < 0 ? 0 : frontMatter.close + 1;
  const scanned = scan(lines, bodyStart);
  const problems: FieldProblem[] = [];
  const name = file.slice(file.lastIndexOf('/') + 1);

  const text1 = (field: string): string | null => {
    const entry = findEntry(frontMatter, field);
    if (entry === undefined) return null;
    const value = valueText(entry.value);
    if (value !== null && typeof value === 'object') {
      problems.push({ field, line: entry.line, message: `"${entry.key}" ${value.problem}` });
      return null;
    }
    return value;
  };
  const list = (field: string): string[] => {
    const entry = findEntry(frontMatter, field);
    if (entry === undefined) return [];
    const value = valueList(entry.value);
    if (!Array.isArray(value)) {
      problems.push({ field, line: entry.line, message: `"${entry.key}" ${value.problem}` });
      return [];
    }
    return value;
  };

  const waveText = text1('wave');
  let wave: number | null = null;
  const waveEntry = findEntry(frontMatter, 'wave');
  if (waveText !== null && waveEntry !== undefined) {
    const quoted = waveEntry.value.kind === 'scalar' && waveEntry.value.scalar.quoted;
    if (!quoted && /^\d{1,9}$/.test(waveText)) wave = Number(waveText);
    else problems.push({ field: 'wave', line: waveEntry.line, message: `"wave" must be a whole number, not "${waveText}"` });
  }

  const statusWord = config.status.field === null ? null : text1(config.status.field);
  const frontTitle = text1('title');
  const heading = titleOf(scanned);
  const id = config.id.source === 'filename' ? idFromName(name, config.id.separator) : text1('id');

  // A marker is a comment on a line of its own. Quoted in a code block it is
  // text: the prose mask keeps code and blanks comments, so a real marker is
  // a line whose prose is empty.
  const marker = (line: number, text: string): boolean =>
    (lines[line] as string).trim() === text && (scanned.prose[line] as string).trim() === '';
  let banner: Brief['banner'] = null;
  const open = lines.findIndex((_, i) => i >= bodyStart && marker(i, BANNER_OPEN));
  if (open >= 0) {
    const close = lines.findIndex((_, i) => i > open && marker(i, BANNER_CLOSE));
    if (close > open) banner = { start: open, end: close + 1 };
  }

  return {
    id: id === null || id.trim() === '' ? null : id.trim(),
    file,
    name,
    phase,
    source: text,
    text: content,
    lines,
    frontMatter,
    bodyStart,
    scan: scanned,
    sections: sectionsOf(scanned),
    tasks: scanned.tasks,
    title: frontTitle ?? (heading === undefined || heading.text === '' ? null : heading.text),
    status: statusFrom(statusWord, config, phase),
    statusWord,
    type: text1('type'),
    wave,
    dependsOn: list('dependsOn'),
    affectedFiles: list('affectedFiles'),
    protectedFiles: list('protectedFiles'),
    integrity: text1('integrity'),
    banner,
    problems,
  };
}

/** The 0-based line a front-matter key is declared on, or the first line when it is absent. */
export function lineOfField(brief: Brief, field: string): number {
  return findEntry(brief.frontMatter, field)?.line ?? 0;
}

/** Keys spec-brief knows, compared the way front matter compares them. */
export function knownFields(config: Config): Set<string> {
  const names = [...BUILT_IN_FIELDS, ...config.fields];
  if (config.status.field !== null) names.push(config.status.field);
  return new Set(names.map(keyName));
}
