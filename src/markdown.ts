/**
 * A structural Markdown scanner: code, comments, headings, task items and link
 * destinations, each with its line.
 *
 * Not a CommonMark parser, and it does not need to be. Nothing here renders.
 * What must be exactly right is knowing what is code or a comment, because a
 * heading inside a fenced block is not a section and a template hint inside
 * `<!-- -->` is not content. Everything else is deliberately simple: ATX
 * headings only (a setext underline and a front-matter delimiter are the same
 * three characters), fences at any indentation, and no indented code blocks,
 * because inside a list four spaces of indentation is a continuation far more
 * often than code.
 */

export interface Heading {
  /** 0-based line. */
  readonly line: number;
  readonly level: number;
  readonly text: string;
}

export interface Section {
  readonly heading: Heading;
  /** 0-based line after the section's last line. The body starts on the line after the heading. */
  readonly end: number;
}

export interface TaskItem {
  /** 0-based line of the box. */
  readonly line: number;
  /** 0-based line after the item's last continuation line. */
  readonly end: number;
  readonly checked: boolean;
  readonly text: string;
}

export interface LinkDestination {
  /** 0-based line. */
  readonly line: number;
  /** Columns of the destination within the line, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly target: string;
}

export interface Scan {
  readonly lines: readonly string[];
  /** Lines with comments blanked and code kept: what counts as content. */
  readonly prose: readonly string[];
  /** Lines with comments, code spans and fenced blocks blanked: what counts as structure. */
  readonly masked: readonly string[];
  readonly headings: readonly Heading[];
  readonly tasks: readonly TaskItem[];
}

// Any indentation: a fence inside a nested list item is indented with the item.
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const TASK = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function blank(length: number): string {
  return ' '.repeat(length);
}

/**
 * Scans `lines` from line `from`; earlier lines (front matter) are blanked in
 * both masks and contribute nothing.
 */
export function scan(lines: readonly string[], from = 0): Scan {
  const prose: string[] = [];
  const masked: string[] = [];
  let fence: { readonly char: string; readonly length: number } | null = null;
  let inComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (i < from) {
      prose.push(blank(line.length));
      masked.push(blank(line.length));
      continue;
    }
    if (fence !== null) {
      prose.push(line);
      masked.push(blank(line.length));
      const close = FENCE.exec(line);
      if (close !== null) {
        const [, run = '', rest = ''] = close;
        if (run.charAt(0) === fence.char && run.length >= fence.length && rest.trim() === '') fence = null;
      }
      continue;
    }
    if (!inComment) {
      const open = FENCE.exec(line);
      const [, run = '', info = ''] = open ?? [];
      if (open !== null && !(run.charAt(0) === '`' && info.includes('`'))) {
        fence = { char: run.charAt(0), length: run.length };
        prose.push(line);
        masked.push(blank(line.length));
        continue;
      }
    }

    let proseLine = '';
    let maskedLine = '';
    let j = 0;
    while (j < line.length) {
      if (inComment) {
        const close = line.indexOf('-->', j);
        const stop = close < 0 ? line.length : close + 3;
        proseLine += blank(stop - j);
        maskedLine += blank(stop - j);
        inComment = close < 0;
        j = stop;
        continue;
      }
      if (line.startsWith('<!--', j)) {
        inComment = true;
        proseLine += blank(4);
        maskedLine += blank(4);
        j += 4;
        continue;
      }
      if (line.charAt(j) === '`') {
        const run = backtickRun(line, j);
        const close = closingRun(line, j + run, run);
        if (close >= 0) {
          const span = line.slice(j, close + run);
          proseLine += span;
          maskedLine += blank(span.length);
          j = close + run;
          continue;
        }
        proseLine += line.slice(j, j + run);
        maskedLine += line.slice(j, j + run);
        j += run;
        continue;
      }
      proseLine += line.charAt(j);
      maskedLine += line.charAt(j);
      j += 1;
    }
    prose.push(proseLine);
    masked.push(maskedLine);
  }

  const headings = findHeadings(lines, masked);
  return { lines, prose, masked, headings, tasks: findTasks(lines, masked, headings) };
}

function backtickRun(line: string, at: number): number {
  let end = at;
  while (line.charAt(end) === '`') end += 1;
  return end - at;
}

/** The index of a run of exactly `length` backticks at or after `from`, or -1. */
function closingRun(line: string, from: number, length: number): number {
  let i = from;
  while (i < line.length) {
    if (line.charAt(i) !== '`') {
      i += 1;
      continue;
    }
    const run = backtickRun(line, i);
    if (run === length) return i;
    i += run;
  }
  return -1;
}

function findHeadings(lines: readonly string[], masked: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const match = HEADING.exec(masked[i] as string);
    if (!match) continue;
    const level = (match[1] as string).length;
    const original = lines[i] as string;
    const text = original
      .replace(/^ {0,3}#{1,6}/, '')
      .replace(/[ \t]+#+[ \t]*$/, '')
      .replace(/^#+[ \t]*$/, '')
      .trim();
    headings.push({ line: i, level, text });
  }
  return headings;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function findTasks(lines: readonly string[], masked: readonly string[], headings: readonly Heading[]): TaskItem[] {
  const headingLines = new Set(headings.map((h) => h.line));
  const tasks: TaskItem[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const match = TASK.exec(masked[i] as string);
    if (!match) continue;
    const indent = (match[1] as string).length;
    const original = TASK.exec(lines[i] as string);
    const text = (original?.[3] ?? '').trim();
    tasks.push({ line: i, end: itemEnd(lines, masked, headingLines, i, indent), checked: match[2] !== ' ', text });
  }
  return tasks;
}

/**
 * Where the list item starting at `start` ends: after its last line indented
 * past the marker, or its last lazy continuation line - text directly under
 * the item with no blank line between, which CommonMark folds into the item's
 * paragraph.
 */
function itemEnd(
  lines: readonly string[],
  masked: readonly string[],
  headingLines: ReadonlySet<number>,
  start: number,
  indent: number,
): number {
  let last = start;
  let previousBlank = false;
  for (let k = start + 1; k < lines.length; k += 1) {
    const line = lines[k] as string;
    if (headingLines.has(k)) break;
    if (line.trim() === '') {
      previousBlank = true;
      continue;
    }
    const nested = indentOf(line) > indent;
    const lazy = !previousBlank && !LIST_ITEM.test(masked[k] as string) && !FENCE.test(line) && !/^\s*>/.test(line);
    if (!nested && !lazy) break;
    last = k;
    previousBlank = false;
  }
  return last + 1;
}

/** Sections: every heading below the title, running to the next heading at its level or above. */
export function sectionsOf(result: Scan): Section[] {
  const sections: Section[] = [];
  const { headings } = result;
  for (let h = 0; h < headings.length; h += 1) {
    const heading = headings[h] as Heading;
    if (heading.level < 2) continue;
    let end = result.lines.length;
    for (let k = h + 1; k < headings.length; k += 1) {
      const next = headings[k] as Heading;
      if (next.level <= heading.level) {
        end = next.line;
        break;
      }
    }
    sections.push({ heading, end });
  }
  return sections;
}

/** The first level-one heading, which is what a reader takes as the title. */
export function titleOf(result: Scan): Heading | undefined {
  return result.headings.find((h) => h.level === 1);
}

const DEFINITION = /^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*/;
/** What may follow a definition's destination: nothing, or a title. */
const TITLE = /^(?:"[^"]*"|'[^']*'|\([^)]*\))?$/;

/**
 * Link and image destinations outside code and comments: `[text](dest)`,
 * `![alt](dest)`, and reference definitions `[label]: dest`.
 */
export function linksOf(result: Scan): LinkDestination[] {
  const links: LinkDestination[] = [];
  result.masked.forEach((masked, line) => {
    const original = result.lines[line] as string;
    const definition = DEFINITION.exec(masked);
    if (definition) {
      // `[Note]: this matters` is prose that looks like a definition; a real one
      // has nothing after its destination but an optional title.
      const found = readDestination(masked, original, definition[0].length);
      if (found && TITLE.test(masked.slice(found.end + (masked.charAt(found.end) === '>' ? 1 : 0)).trim())) {
        links.push({ line, ...found });
      }
    }
    let from = 0;
    for (;;) {
      const at = masked.indexOf('](', from);
      if (at < 0) break;
      let start = at + 2;
      while (masked.charAt(start) === ' ' || masked.charAt(start) === '\t') start += 1;
      const found = readDestination(masked, original, start);
      if (found) links.push({ line, ...found });
      from = at + 2;
    }
  });
  return links;
}

function readDestination(
  masked: string,
  original: string,
  start: number,
): { start: number; end: number; target: string } | undefined {
  if (masked.charAt(start) === '<') {
    const close = masked.indexOf('>', start + 1);
    if (close < 0) return undefined;
    return { start: start + 1, end: close, target: original.slice(start + 1, close) };
  }
  let depth = 0;
  let end = start;
  while (end < masked.length) {
    const ch = masked.charAt(end);
    if (ch === ' ' || ch === '\t') break;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    end += 1;
  }
  if (end === start) return undefined;
  return { start, end, target: original.slice(start, end) };
}

/** Whether a line carries anything once comments are removed. */
export function hasContent(proseLine: string): boolean {
  return proseLine.trim().length > 0;
}
