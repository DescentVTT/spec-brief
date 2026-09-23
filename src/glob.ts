/**
 * Globs: parsing, matching, and deciding whether two globs can name the same file.
 *
 * The dialect is the one people type: `**`, `*`, `?`, `[abc]`, `[!a-z]`,
 * `{a,b}` and `\` to escape. A pattern with no glob syntax at all names a
 * directory and everything beneath it, so `src/auth` covers
 * `src/auth/login.ts` - unless it names a file, one the tree holds or one with
 * an extension, which matches only itself. A trailing `/` always means a
 * directory. Paths
 * are repository-relative and POSIX, and matching is case-sensitive on every
 * host, because git's paths are and a result should not depend on who ran it.
 * `*` matches a leading dot; a scope that forgot its dotfiles is not a scope
 * that excludes them.
 *
 * Nothing here compiles to a `RegExp`. Matching and intersection are dynamic
 * programmes over the pattern and the subject, so a pattern of `*a*a*a*a*b`
 * against a long name costs the product of their lengths and cannot backtrack
 * into an exponent. The same property is why the sibling tools match their own
 * globs this way.
 */

export type CharToken =
  | { readonly kind: 'literal'; readonly char: string }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | { readonly kind: 'class'; readonly negated: boolean; readonly ranges: readonly (readonly [number, number])[] };

type Single = Exclude<CharToken, { kind: 'star' }>;

export type Segment =
  | { readonly kind: 'globstar' }
  | { readonly kind: 'pattern'; readonly tokens: readonly CharToken[]; readonly literal: boolean };

export interface Glob {
  readonly source: string;
  /** One sequence of segments per brace alternative; a path matches when any does. */
  readonly alternatives: readonly (readonly Segment[])[];
}

export type GlobParse = { readonly ok: true; readonly glob: Glob } | { readonly ok: false; readonly error: string };

/** More alternatives than this is a pattern nobody meant. */
export const MAX_ALTERNATIVES = 256;

const SLASH = 0x2f;
const GLOBSTAR: Segment = { kind: 'globstar' };

export interface ParseOptions {
  /** Whether a literal path is a file, from the tree when it is known. */
  readonly isFile?: ((path: string) => boolean) | undefined;
}

/** A name with an extension, `login.ts` or `.eslintrc.json`, and not a dot-directory such as `.github`. */
function hasExtension(name: string): boolean {
  return /.\.[^.]+$/.test(name);
}

export function parseGlob(source: string, options: ParseOptions = {}): GlobParse {
  let pattern = source.trim();
  if (pattern.length === 0) return { ok: false, error: 'the pattern is empty' };
  if (pattern.startsWith('!')) return { ok: false, error: 'negated patterns are not supported; narrow the positive pattern' };
  if (pattern.startsWith('/')) return { ok: false, error: 'a pattern is relative to the repository root and cannot start with "/"' };
  // A backslash before a letter, a digit or a slash is a Windows separator, not an escape.
  if (/\\(?:[A-Za-z0-9/]|$)/.test(pattern)) {
    return { ok: false, error: '"\\" escapes glob syntax; separate directories with "/"' };
  }
  if (/(?:^|[^\\])[@+!?*]\(/.test(pattern)) return { ok: false, error: 'extended globs such as "+(a|b)" are not supported' };
  while (pattern.startsWith('./')) pattern = pattern.slice(2);
  if (pattern.endsWith('/')) pattern = `${pattern}**`;

  const expanded = expandBraces(pattern);
  if (typeof expanded === 'string') return { ok: false, error: expanded };

  const alternatives: Segment[][] = [];
  for (const alternative of expanded) {
    const segments: Segment[] = [];
    for (const raw of alternative.split('/')) {
      if (raw === '' || raw === '.') continue;
      if (raw === '..') return { ok: false, error: 'a pattern cannot leave the repository with ".."' };
      if (raw === '**') {
        if (segments[segments.length - 1]?.kind !== 'globstar') segments.push(GLOBSTAR);
        continue;
      }
      const tokens = tokenize(raw);
      if (typeof tokens === 'string') return { ok: false, error: tokens };
      segments.push({ kind: 'pattern', tokens, literal: tokens.every((t) => t.kind === 'literal') });
    }
    if (segments.length === 0) return { ok: false, error: 'the pattern names no path' };
    // A path with no glob syntax names a directory and everything beneath it,
    // unless it names a file: one the tree has, or one with an extension.
    // Treating a file as a directory would let "src/a.ts" overlap
    // "**/session.ts" through a "src/a.ts/session.ts" nobody can create.
    if (segments.every((s) => s.kind === 'pattern' && s.literal)) {
      const path = segments
        .map((s) => (s.kind === 'pattern' ? s.tokens.map((t) => (t.kind === 'literal' ? t.char : '')).join('') : ''))
        .join('/');
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (options.isFile?.(path) !== true && !hasExtension(last)) segments.push(GLOBSTAR);
    }
    alternatives.push(segments);
  }
  return { ok: true, glob: { source, alternatives } };
}

/** Expands `{a,b}` groups, innermost last, or says why the pattern is malformed. */
function expandBraces(pattern: string): string[] | string {
  let open = -1;
  let depth = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = classEnd(pattern, i);
      if (close > 0) i = close;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) open = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth === 0) return 'a "}" closes no "{"';
      depth -= 1;
      if (depth === 0) {
        const options = splitTopLevel(pattern.slice(open + 1, i));
        const prefix = pattern.slice(0, open);
        const suffix = pattern.slice(i + 1);
        const results: string[] = [];
        for (const option of options) {
          const expanded = expandBraces(`${prefix}${option}${suffix}`);
          if (typeof expanded === 'string') return expanded;
          results.push(...expanded);
          if (results.length > MAX_ALTERNATIVES) return `the braces expand to more than ${MAX_ALTERNATIVES} patterns`;
        }
        return results;
      }
    }
  }
  if (depth > 0) return 'a "{" is never closed';
  return [pattern];
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** The index of the `]` closing a class opened at `open`, or -1. */
function classEnd(pattern: string, open: number): number {
  let i = open + 1;
  if (pattern.charAt(i) === '!' || pattern.charAt(i) === '^') i += 1;
  if (pattern.charAt(i) === ']') i += 1;
  for (; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '/') return -1;
    if (ch === ']') return i;
  }
  return -1;
}

function tokenize(segment: string): CharToken[] | string {
  const tokens: CharToken[] = [];
  const chars = Array.from(segment);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    if (ch === '\\') {
      const next = chars[i + 1];
      if (next === undefined || /[A-Za-z0-9/]/.test(next)) return '"\\" escapes glob syntax; separate directories with "/"';
      tokens.push({ kind: 'literal', char: next });
      i += 1;
    } else if (ch === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
    } else if (ch === '?') {
      tokens.push({ kind: 'any' });
    } else if (ch === '[') {
      const parsed = readClass(chars, i);
      if (typeof parsed === 'string') return parsed;
      tokens.push(parsed.token);
      i = parsed.end;
    } else {
      tokens.push({ kind: 'literal', char: ch });
    }
  }
  return tokens;
}

function readClass(chars: readonly string[], open: number): { token: CharToken; end: number } | string {
  let i = open + 1;
  let negated = false;
  if (chars[i] === '!' || chars[i] === '^') {
    negated = true;
    i += 1;
  }
  const ranges: [number, number][] = [];
  let first = true;
  for (; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    if (ch === ']' && !first) {
      if (ranges.length === 0) return 'a character class is empty';
      return { token: { kind: 'class', negated, ranges }, end: i };
    }
    first = false;
    let lo = ch;
    if (ch === '\\' && chars[i + 1] !== undefined) {
      i += 1;
      lo = chars[i] as string;
    }
    let hi = lo;
    if (chars[i + 1] === '-' && chars[i + 2] !== undefined && chars[i + 2] !== ']') {
      hi = chars[i + 2] as string;
      i += 2;
    }
    const from = lo.codePointAt(0) as number;
    const to = hi.codePointAt(0) as number;
    if (to < from) return `the range "${lo}-${hi}" runs backwards`;
    ranges.push([from, to]);
  }
  return 'a "[" is never closed';
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '' && s !== '.');
}

function inClass(token: Extract<CharToken, { kind: 'class' }>, point: number): boolean {
  if (point === SLASH) return false;
  const inside = token.ranges.some(([lo, hi]) => point >= lo && point <= hi);
  return token.negated ? !inside : inside;
}

function charMatches(token: Single, char: string): boolean {
  switch (token.kind) {
    case 'literal':
      return token.char === char;
    case 'any':
      return char !== '/';
    case 'class':
      return inClass(token, char.codePointAt(0) as number);
  }
}

/** Whether one segment of a path matches a pattern segment's tokens. */
function tokensMatch(tokens: readonly CharToken[], subject: string): boolean {
  const chars = Array.from(subject);
  // next[j]: tokens[i+1..] match chars[j..]; filled from the end of both.
  let next = new Array<boolean>(chars.length + 1).fill(false);
  next[chars.length] = true;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i] as CharToken;
    const row = new Array<boolean>(chars.length + 1).fill(false);
    for (let j = chars.length; j >= 0; j -= 1) {
      row[j] =
        token.kind === 'star'
          ? (next[j] as boolean) || (j < chars.length && (row[j + 1] as boolean))
          : j < chars.length && charMatches(token, chars[j] as string) && (next[j + 1] as boolean);
    }
    next = row;
  }
  return next[0] as boolean;
}

function segmentsMatch(segments: readonly Segment[], path: readonly string[]): boolean {
  let next = new Array<boolean>(path.length + 1).fill(false);
  next[path.length] = true;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i] as Segment;
    const row = new Array<boolean>(path.length + 1).fill(false);
    for (let j = path.length; j >= 0; j -= 1) {
      row[j] =
        segment.kind === 'globstar'
          ? (next[j] as boolean) || (j < path.length && (row[j + 1] as boolean))
          : j < path.length && tokensMatch(segment.tokens, path[j] as string) && (next[j + 1] as boolean);
    }
    next = row;
  }
  return next[0] as boolean;
}

export function matchGlob(glob: Glob, path: string): boolean {
  const segments = splitPath(path);
  if (segments.length === 0) return false;
  return glob.alternatives.some((alternative) => segmentsMatch(alternative, segments));
}

/**
 * A path both globs match, or `null` when there is none. The answer is exact
 * for the dialect above: a `null` means no file can be in both scopes, and a
 * path is a witness a reader can check by eye.
 */
export function intersectGlobs(a: Glob, b: Glob): string | null {
  for (const left of a.alternatives) {
    for (const right of b.alternatives) {
      const witness = intersectSegments(left, right);
      if (witness !== null) return witness.length === 0 ? 'x' : witness.join('/');
    }
  }
  return null;
}

const ANY_SEGMENT: readonly CharToken[] = [{ kind: 'star' }];

function intersectSegments(p: readonly Segment[], q: readonly Segment[]): string[] | null {
  const memo = new Map<number, string[] | null>();
  const width = q.length + 1;
  const visit = (i: number, j: number): string[] | null => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result = step(i, j);
    memo.set(key, result);
    return result;
  };
  const prepend = (head: string | null, tail: string[] | null): string[] | null =>
    head === null || tail === null ? null : [head, ...tail];

  const step = (i: number, j: number): string[] | null => {
    if (i === p.length && j === q.length) return [];
    const x = p[i];
    const y = q[j];
    if (x?.kind === 'globstar') {
      const skip = visit(i + 1, j);
      if (skip !== null) return skip;
      if (y === undefined) return null;
      if (y.kind === 'globstar') return visit(i, j + 1);
      return prepend(intersectTokens(y.tokens, ANY_SEGMENT), visit(i, j + 1));
    }
    if (y?.kind === 'globstar') {
      const skip = visit(i, j + 1);
      if (skip !== null) return skip;
      if (x === undefined) return null;
      return prepend(intersectTokens(x.tokens, ANY_SEGMENT), visit(i + 1, j));
    }
    if (x === undefined || y === undefined) return null;
    const head = intersectTokens(x.tokens, y.tokens);
    return head === null ? null : prepend(head, visit(i + 1, j + 1));
  };
  return visit(0, 0);
}

/**
 * A non-empty string both token sequences match, or `null`.
 *
 * Complete by a shortest-witness argument: in a shortest common string, no
 * character is absorbed by a star on both sides at once (dropping it would
 * leave a shorter one), so every character advances at least one sequence,
 * and the five moves below are all the ways that can happen.
 */
export function intersectTokens(x: readonly CharToken[], y: readonly CharToken[]): string | null {
  const memo = new Map<number, string | null>();
  const width = y.length + 1;
  const visit = (i: number, j: number): string | null => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result = step(i, j);
    memo.set(key, result);
    return result;
  };
  const prepend = (head: string | null, tail: string | null): string | null =>
    head === null || tail === null ? null : head + tail;

  const step = (i: number, j: number): string | null => {
    if (i === x.length && j === y.length) return '';
    const a = x[i];
    const b = y[j];
    if (a?.kind === 'star') {
      const skip = visit(i + 1, j);
      if (skip !== null) return skip;
      if (b === undefined) return null;
      if (b.kind === 'star') return visit(i, j + 1);
      return prepend(witnessChar(b), visit(i, j + 1));
    }
    if (b?.kind === 'star') {
      const skip = visit(i, j + 1);
      if (skip !== null) return skip;
      if (a === undefined) return null;
      return prepend(witnessChar(a), visit(i + 1, j));
    }
    if (a === undefined || b === undefined) return null;
    return prepend(meet(a, b), visit(i + 1, j + 1));
  };
  const witness = visit(0, 0);
  // Empty only when both sides are nothing but stars, and then any name will do.
  return witness === '' ? 'x' : witness;
}

function accepts(token: Single, point: number): boolean {
  if (point === SLASH) return false;
  switch (token.kind) {
    case 'literal':
      return token.char.codePointAt(0) === point;
    case 'any':
      return true;
    case 'class':
      return inClass(token, point);
  }
}

function candidates(tokens: readonly Single[]): number[] {
  const points = [0x78, 0x61, 0x30, 0x5f, 0x2d];
  for (const token of tokens) {
    if (token.kind === 'literal') points.push(token.char.codePointAt(0) as number);
    if (token.kind === 'class') {
      for (const [lo, hi] of token.ranges) points.push(lo, hi, lo - 1, hi + 1);
    }
  }
  return points;
}

/** A character every token accepts, or `null`. */
function pick(tokens: readonly Single[]): string | null {
  const ok = (point: number): boolean => point >= 0 && point <= 0x10ffff && tokens.every((t) => accepts(t, point));
  for (const point of candidates(tokens)) if (ok(point)) return String.fromCodePoint(point);
  // Bounded by the size of Unicode: reached only by classes that exclude every
  // candidate above, which a real scope never writes.
  for (let point = 0x21; point <= 0x10ffff; point += 1) if (ok(point)) return String.fromCodePoint(point);
  return null;
}

function witnessChar(token: Single): string | null {
  return pick([token]);
}

function meet(a: Single, b: Single): string | null {
  return pick([a, b]);
}

/**
 * The directory a glob is rooted in: its leading literal segments. A pattern
 * that names a file is rooted in that file's directory.
 */
export function globBase(glob: Glob): string {
  const first = glob.alternatives[0] as readonly Segment[];
  const literal: string[] = [];
  for (const segment of first) {
    if (segment.kind !== 'pattern' || !segment.literal) break;
    literal.push(segment.tokens.map((t) => (t.kind === 'literal' ? t.char : '')).join(''));
  }
  // A literal file path is rooted in its directory; a literal directory in itself.
  if (literal.length === first.length) literal.pop();
  return literal.join('/');
}
