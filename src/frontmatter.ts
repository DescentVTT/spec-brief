/**
 * A front-matter reader and editor for the flat subset of YAML briefs use.
 *
 * Supported: `key: value` at the top level; plain, single-quoted and
 * double-quoted scalars; inline `[a, b]` sequences; block `- item` sequences;
 * `#` comments. Plain scalars follow the YAML 1.2 core schema, so `yes` is a
 * word and `035` keeps its leading zero for whoever reads it as text.
 *
 * Anything richer - nested mappings, block scalars, anchors, tags, a value
 * continued onto the next line - is recognised and reported as unsupported
 * rather than guessed at. A YAML library would parse more, and would be the
 * largest dependency of a package that has none; it would also not give back
 * the line of every value, and an edit that must leave every other line of a
 * file untouched needs exactly that.
 */

export interface YamlScalar {
  readonly text: string;
  readonly quoted: boolean;
}

export type YamlValue =
  | { readonly kind: 'scalar'; readonly scalar: YamlScalar }
  | { readonly kind: 'list'; readonly items: readonly YamlScalar[] }
  | { readonly kind: 'unsupported'; readonly reason: string };

export interface FrontMatterEntry {
  /** The key as written. */
  readonly key: string;
  /** The key compared: lower case, without `-` or `_`, so `depends-on` is `dependsOn`. */
  readonly name: string;
  /** 0-based line of the key. */
  readonly line: number;
  /** 0-based line after the entry's last line. */
  readonly end: number;
  readonly value: YamlValue;
}

export interface FrontMatterProblem {
  readonly line: number;
  readonly message: string;
}

export interface FrontMatter {
  /** 0-based line of the closing delimiter, or -1 when the block is never closed. */
  readonly close: number;
  readonly entries: readonly FrontMatterEntry[];
  readonly problems: readonly FrontMatterProblem[];
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const KEY = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/;
const SEQUENCE_ITEM = /^([ \t]*)-(?:[ \t]+(.*))?$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;

export function keyName(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Reads the front matter at the top of `lines`, or `null` when there is none. */
export function readFrontMatter(lines: readonly string[]): FrontMatter | null {
  if (lines.length === 0 || !OPEN.test(lines[0] as string)) return null;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (CLOSE.test(lines[i] as string)) {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return {
      close: -1,
      entries: [],
      problems: [{ line: 0, message: 'the front matter opened on line 1 is never closed' }],
    };
  }

  const entries: FrontMatterEntry[] = [];
  const problems: FrontMatterProblem[] = [];
  const seen = new Map<string, number>();
  let i = 1;
  while (i < close) {
    const line = lines[i] as string;
    if (BLANK_OR_COMMENT.test(line)) {
      i += 1;
      continue;
    }
    const match = KEY.exec(line);
    if (!match) {
      problems.push({
        line: i,
        message: /^\s/.test(line) ? 'an indented line belongs to no key' : 'not a "key: value" line',
      });
      i += 1;
      continue;
    }
    const key = match[1] as string;
    const inline = stripLeadingComment((match[2] ?? '').trim());
    let end = i + 1;
    while (end < close && belongsToBlock(lines[end] as string)) end += 1;
    while (end > i + 1 && BLANK_OR_COMMENT.test(lines[end - 1] as string)) end -= 1;
    const block = lines.slice(i + 1, end);

    let value: YamlValue;
    if (inline.length > 0) {
      value = block.some((l) => !BLANK_OR_COMMENT.test(l))
        ? unsupported('the value continues on the next line; keep it on one line, or quote it')
        : parseInline(inline);
    } else {
      value = parseBlock(block);
    }

    const name = keyName(key);
    const previous = seen.get(name);
    if (previous !== undefined) {
      problems.push({ line: i, message: `"${key}" is declared twice (first on line ${previous + 1})` });
    } else {
      seen.set(name, i);
    }
    entries.push({ key, name, line: i, end, value });
    i = end;
  }
  return { close, entries, problems };
}

/** A line under a key is part of its value when it is indented or starts a sequence item. */
function belongsToBlock(line: string): boolean {
  return /^[ \t]/.test(line) || /^-(?:[ \t]|$)/.test(line) || line.trim() === '';
}

function stripLeadingComment(text: string): string {
  return text.startsWith('#') ? '' : text;
}

function unsupported(reason: string): YamlValue {
  return { kind: 'unsupported', reason };
}

function parseBlock(block: readonly string[]): YamlValue {
  const content = block.filter((l) => !BLANK_OR_COMMENT.test(l));
  if (content.length === 0) return { kind: 'scalar', scalar: { text: '', quoted: false } };
  const first = SEQUENCE_ITEM.exec(content[0] as string);
  if (!first) {
    return KEY.test((content[0] as string).trim())
      ? unsupported('nested mappings are not supported; flatten the key')
      : unsupported('the value continues on the next line; keep it on one line, or quote it');
  }
  const indent = (first[1] as string).length;
  const items: YamlScalar[] = [];
  for (const line of content) {
    const item = SEQUENCE_ITEM.exec(line);
    if (!item || (item[1] as string).length !== indent) {
      return unsupported('a list item is continued or nested; keep each item on one line');
    }
    const text = stripLeadingComment((item[2] ?? '').trim());
    if (text.length === 0) return unsupported('a list item is empty');
    const parsed = parseInline(text);
    if (parsed.kind !== 'scalar') {
      return parsed.kind === 'list' ? unsupported('nested lists are not supported') : parsed;
    }
    items.push(parsed.scalar);
  }
  return { kind: 'list', items };
}

/** Parses a value written on the key's own line. `text` is trimmed and non-empty. */
export function parseInline(text: string): YamlValue {
  const head = text.charAt(0);
  if (head === '"' || head === "'") {
    const quoted = head === '"' ? readDoubleQuoted(text) : readSingleQuoted(text);
    if (typeof quoted === 'string') return unsupported(quoted);
    return trailingIsComment(text.slice(quoted.next))
      ? { kind: 'scalar', scalar: { text: quoted.text, quoted: true } }
      : unsupported('text follows a closing quote');
  }
  if (head === '[') return parseFlowSequence(text);
  if (head === '{') return unsupported('inline mappings are not supported');
  if (head === '|' || head === '>') return unsupported('block scalars are not supported; keep the value on one line');
  if (head === '&' || head === '*' || head === '!') return unsupported('anchors, aliases and tags are not supported');
  if (head === '@' || head === '`') return unsupported(`a plain value cannot start with "${head}"; quote it`);
  const plain = stripTrailingComment(text);
  if (/:(?:\s|$)/.test(plain)) return unsupported('a plain value cannot contain ": "; quote it');
  if (/^-(?:\s|$)/.test(plain)) return unsupported('a list must start on the line after its key');
  return { kind: 'scalar', scalar: { text: plain, quoted: false } };
}

function stripTrailingComment(text: string): string {
  const hash = text.search(/\s#/);
  return (hash < 0 ? text : text.slice(0, hash)).trim();
}

function trailingIsComment(rest: string): boolean {
  return /^\s*(?:#.*)?$/.test(rest) && (rest.trim() === '' || /^\s/.test(rest));
}

interface Quoted {
  readonly text: string;
  /** Index just past the closing quote. */
  readonly next: number;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  '0': '\0',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

const HEX_ESCAPE_LENGTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** Reads a double-quoted scalar starting at index 0, or returns why it cannot. */
function readDoubleQuoted(text: string): Quoted | string {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '"') return { text: out, next: i + 1 };
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const code = text.charAt(i + 1);
    const simple = ESCAPES[code];
    if (simple !== undefined) {
      out += simple;
      i += 1;
      continue;
    }
    const width = HEX_ESCAPE_LENGTH[code];
    const hex = width === undefined ? '' : text.slice(i + 2, i + 2 + width);
    if (width === undefined || hex.length !== width || !/^[0-9A-Fa-f]+$/.test(hex)) {
      return `"\\${code}" is not an escape this reader knows`;
    }
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff) return `"\\${code}${hex}" is not a character`;
    out += String.fromCodePoint(point);
    i += 1 + width;
  }
  return 'a double-quoted value is never closed';
}

function readSingleQuoted(text: string): Quoted | string {
  let out = '';
  for (let i = 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== "'") {
      out += ch;
      continue;
    }
    if (text.charAt(i + 1) === "'") {
      out += "'";
      i += 1;
      continue;
    }
    return { text: out, next: i + 1 };
  }
  return 'a single-quoted value is never closed';
}

function parseFlowSequence(text: string): YamlValue {
  const items: YamlScalar[] = [];
  let i = 1;
  for (;;) {
    while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
    if (i >= text.length) return unsupported('an inline list is never closed; keep it on one line');
    const ch = text.charAt(i);
    if (ch === ']') {
      return trailingIsComment(text.slice(i + 1))
        ? { kind: 'list', items }
        : unsupported('text follows the end of an inline list');
    }
    if (ch === '[' || ch === '{') return unsupported('nested lists and mappings are not supported');
    if (ch === ',') return unsupported('an inline list has an empty item');
    let item: YamlScalar;
    if (ch === '"' || ch === "'") {
      const rest = text.slice(i);
      const quoted = ch === '"' ? readDoubleQuoted(rest) : readSingleQuoted(rest);
      if (typeof quoted === 'string') return unsupported(quoted);
      item = { text: quoted.text, quoted: true };
      i += quoted.next;
    } else {
      let j = i;
      while (j < text.length && !',]'.includes(text.charAt(j))) j += 1;
      const plain = text.slice(i, j).trim();
      if (/[[{]/.test(plain) || /:(?:\s|$)/.test(plain) || plain.includes(' #')) {
        return unsupported(`"${plain}" needs quoting inside an inline list`);
      }
      item = { text: plain, quoted: false };
      i = j;
    }
    items.push(item);
    while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
    if (i >= text.length) return unsupported('an inline list is never closed; keep it on one line');
    // After a comma the next pass reads an item or, legally in YAML, the bracket.
    if (text.charAt(i) === ',') i += 1;
    else if (text.charAt(i) !== ']') return unsupported('inline list items must be separated by commas');
  }
}

/** Null in the YAML 1.2 core schema: empty, `~` or `null` in any of its three spellings. */
export function isNull(scalar: YamlScalar): boolean {
  return !scalar.quoted && ['', '~', 'null', 'Null', 'NULL'].includes(scalar.text);
}

/** Renders a string as a scalar that reads back as the same string. */
export function renderScalar(value: string): string {
  const reserved = /^(?:true|false|null|yes|no|on|off|~)$/i.test(value);
  const plain = /^[A-Za-z][A-Za-z0-9 ._/+-]*$/.test(value) && !value.endsWith(' ');
  return plain && !reserved ? value : JSON.stringify(value);
}

export function findEntry(frontMatter: FrontMatter | null, key: string): FrontMatterEntry | undefined {
  const name = keyName(key);
  return frontMatter?.entries.find((entry) => entry.name === name);
}

/**
 * Sets one key, leaving every other line as it was. An existing entry keeps the
 * spelling of its key; a new one goes last. A file with no front matter gains
 * a block.
 */
export function setEntry(
  lines: readonly string[],
  frontMatter: FrontMatter | null,
  key: string,
  rendered: string,
): string[] {
  if (frontMatter === null) return ['---', `${key}: ${rendered}`, '---', ...lines];
  if (frontMatter.close < 0) throw new Error('cannot edit front matter that is never closed');
  const entry = findEntry(frontMatter, key);
  if (entry === undefined) {
    return [...lines.slice(0, frontMatter.close), `${key}: ${rendered}`, ...lines.slice(frontMatter.close)];
  }
  return [...lines.slice(0, entry.line), `${entry.key}: ${rendered}`, ...lines.slice(entry.end)];
}

/** Removes one key and its value lines; a key that is absent changes nothing. */
export function removeEntry(lines: readonly string[], frontMatter: FrontMatter | null, key: string): string[] {
  const entry = findEntry(frontMatter, key);
  if (entry === undefined) return [...lines];
  return [...lines.slice(0, entry.line), ...lines.slice(entry.end)];
}

/** Front matter an edit can be written into: one that is closed. */
export function editable(frontMatter: FrontMatter): boolean {
  return frontMatter.close >= 0;
}
