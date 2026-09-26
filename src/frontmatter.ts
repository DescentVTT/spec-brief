/**
 * A brief's front matter: spec-core's reader and editor, copied into
 * `src/vendor/spec-core/`, over a brief's lines.
 *
 * The flat subset of YAML briefs use: `key: value` lines, plain and quoted
 * scalars, inline and block lists, comments. Anything richer is reported as
 * unsupported rather than guessed at, TOML between `+++` lines included, and
 * every value keeps its line, so an edit leaves every other line of the file
 * as it was (ADR-0001). Offsets in what it reads count in the lines joined by
 * `\n`, which for a brief are its `lines`, not its `text`.
 */

import { findEntry, readFrontMatter as readText, setEntry, type FrontMatter } from './vendor/spec-core/markdown/index.js';
import { textOfLines } from './text.js';

export {
  findEntry,
  isNull,
  keyName,
  parseInline,
  removeEntry,
  renderScalar,
  setEntry,
  type FrontMatter,
  type FrontMatterEntry,
  type FrontMatterProblem,
  type YamlScalar,
  type YamlValue,
} from './vendor/spec-core/markdown/index.js';

/** Reads the front matter at the top of `lines`, or `null` when there is none. */
export function readFrontMatter(lines: readonly string[]): FrontMatter | null {
  return readText(textOfLines(lines));
}

/**
 * Sets one key as `setEntry` does, and keeps a comment that followed the old
 * value on its line: `wave: 2  # after the review` becomes `wave: 3  # after
 * the review`. spec-core's editor writes the key and the value alone, and a
 * comment beside a value is often the only record of why it was chosen. A
 * value over several lines is rewritten as `setEntry` rewrites it.
 */
export function setEntryKeepingComment(lines: readonly string[], frontMatter: FrontMatter | null, key: string, rendered: string): string[] {
  const edited = setEntry(lines, frontMatter, key, rendered);
  const entry = findEntry(frontMatter, key);
  if (entry === undefined || entry.end !== entry.line + 1) return edited;
  // Offsets count in the lines joined by one character each.
  const lineStart = lines.slice(0, entry.line).reduce((sum, line) => sum + line.length + 1, 0);
  const rest = (lines[entry.line] as string).slice(entry.valueEnd - lineStart);
  if (!/^[ \t]+#/.test(rest)) return edited;
  return edited.map((line, i) => (i === entry.line ? `${line}${rest}` : line));
}

/** Front matter an edit can be written into: YAML, and closed. */
export function editable(frontMatter: FrontMatter): boolean {
  return frontMatter.kind === 'yaml' && frontMatter.close >= 0;
}
