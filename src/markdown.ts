/**
 * A brief's Markdown: spec-core's scanner, copied into `src/vendor/spec-core/`,
 * read in spec-brief's dialect.
 *
 * The scanner is exact about what is code and what is a comment, as CommonMark
 * has it, and reports every heading, list item and link it finds. What of that
 * is a brief's structure is decided here (ADR-0001, amended 2026-09-26):
 *
 * - A heading is an ATX heading outside a block quote. Prose over a `---` is a
 *   setext heading to a renderer, and a brief that separates its parts that way
 *   must not grow a section from it; a heading in a block quote is quoted.
 * - A task is a list item outside a block quote with a box GFM renders: a
 *   space, `x` or `X`. The scanner reads `[~]`, `[?]` and others as well,
 *   which a brief does not write.
 * - A link destination is one written in the link or in a definition: the
 *   inline form and the definition, images included, an image or a link inside
 *   a link's text too, each once. A reference is rewritten through its
 *   definition, once.
 *
 * Everything here is in 0-based lines of the brief's `lines`, and columns
 * within them.
 */

import { type Link, linesOf, type MarkdownScan, scanMarkdown, type ScannedLine } from './vendor/spec-core/markdown/index.js';
import { textOfLines } from './text.js';

export interface Heading {
  /** 0-based line. */
  readonly line: number;
  readonly level: number;
  /** As a reader sees it: without a closing sequence or a comment. */
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
  /** 0-based line after the item's last line: its continuations and what is nested under it. */
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
  /** Lines with front matter and comments blanked, and code kept: what counts as content. */
  readonly prose: readonly string[];
  /** Lines with front matter, code, raw-text HTML and comments blanked: what counts as structure. */
  readonly masked: readonly string[];
  readonly headings: readonly Heading[];
  readonly tasks: readonly TaskItem[];
  /** Destinations outside code and comments, each once, in the order of their lines and columns. */
  readonly links: readonly LinkDestination[];
}

/** Whether a checkbox is one a task is written with. */
function isBox(checkbox: string | null): boolean {
  return checkbox === ' ' || checkbox === 'x' || checkbox === 'X';
}

/**
 * The links that write their destination - inline links and images, and
 * definitions - with offsets into the text scanned `at` that offset, added to
 * `found` by the offset of the destination.
 *
 * A link's text may hold an image, `[![diagram](d.png)](d.md)`, whose
 * destination moves with the brief as the link's does. spec-core lists it
 * after the link, and reads nothing else there: not a link in the text,
 * `[a [b](b.md)](c.md)`, which CommonMark takes as the link where spec-core
 * takes the outer pair, nor an image in an image's alt text or a wiki link's.
 * So each text is read again here, which finds spec-core's image a second
 * time. It is one destination, kept once, because two rewrites of the same
 * columns would write the second over the first. Each text is shorter than
 * the one it came from, so the reading ends.
 */
function written(core: MarkdownScan, at: number, found: Map<number, Link>): Map<number, Link> {
  for (const link of core.links) {
    written(scanMarkdown(link.text), at + core.text.indexOf(link.text, link.start), found);
    if (link.form === 'inline' || link.form === 'definition') {
      found.set(at + link.targetStart, { ...link, targetStart: at + link.targetStart, targetEnd: at + link.targetEnd });
    }
  }
  return found;
}

/** Scans a brief's lines, which carry no byte-order mark. */
export function scan(lines: readonly string[]): Scan {
  const core = scanMarkdown(textOfLines(lines));
  const unquoted = (line: number): boolean => (core.lines[line - 1] as ScannedLine).quoteDepth === 0;
  return {
    lines,
    prose: linesOf(core, 'prose'),
    masked: linesOf(core, 'structure'),
    headings: core.headings
      .filter((h) => h.form === 'atx' && unquoted(h.line))
      .map((h) => ({ line: h.line - 1, level: h.level, text: h.text })),
    tasks: core.listItems
      .filter((item) => isBox(item.checkbox) && item.quoteDepth === 0)
      .map((item) => ({ line: item.line - 1, end: item.endLine, checked: item.checkbox !== ' ', text: item.firstLine })),
    links: [...written(core, 0, new Map()).values()]
      .map((link) => {
        // A link's text may run over lines; its destination is on the last.
        const at = core.index.positionAt(link.targetStart);
        const start = at.column - 1;
        return { line: at.line - 1, start, end: start + link.targetEnd - link.targetStart, target: link.target };
      })
      .sort((a, b) => a.line - b.line || a.start - b.start),
  };
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

/** Whether a line carries anything once comments are removed. */
export function hasContent(proseLine: string): boolean {
  return proseLine.trim().length > 0;
}
