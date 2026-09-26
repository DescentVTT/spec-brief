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

import { readFrontMatter as readText, type FrontMatter } from './vendor/spec-core/markdown/index.js';
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

/** Front matter an edit can be written into: YAML, and closed. */
export function editable(frontMatter: FrontMatter): boolean {
  return frontMatter.kind === 'yaml' && frontMatter.close >= 0;
}
