/**
 * Scopes as globs: spec-core's `path` dialect, read the way spec-brief reads a
 * brief.
 *
 * The syntax, the automaton and the witness search are spec-core's, copied
 * into `src/vendor/` and verified by hash, so the family's tools read one
 * pattern the same way (spec-core ADR-0003). What is decided here is what
 * spec-brief adds around it:
 *
 * - A pattern is relative to the repository root, so a leading `/` is refused
 *   rather than rooted at the filesystem: on the pattern, and on a text its
 *   braces give, since spec-core reads `{/docs,x}` as `/docs` or `x`, and
 *   `docs` would fall out of the scope unsaid. A leading `./` goes with the
 *   slashes after it, as POSIX reads them: `.//docs` is `docs`, and
 *   `./{/docs,x}` is `docs` or `x`. A list entry's `!` has no list to belong
 *   to in a scope, so it is refused rather than read.
 * - Paths compare case-sensitively on every host, as git's do.
 * - A path with no glob syntax is read as the tree reads it: a file the tree
 *   holds is that file, a directory it holds is everything beneath it, and a
 *   path it does not hold is a file, unless it is written with a trailing `/`.
 *   The tree, not the spelling, knows that `Dockerfile` is a file and
 *   `docs/v1.2` a directory (ADR-0005, amended 2026-09-26).
 * - A trailing `/**` is at least one segment, so `docs/**` is the directory's
 *   contents and a collision witness is always a file. A trailing `/` means
 *   the same on a brace alternative as on the whole pattern: `{src/,lib}` is
 *   `src/` or `lib`, and the tree is asked about `lib` alone.
 *
 * Nothing here compiles to a `RegExp`. Matching costs at most the pattern's
 * size times the path's length, and a question about two scopes that cannot be
 * answered within the search's budget answers `undecided`, never a guess.
 */

import {
  globAlternatives,
  globCovers as coreCovers,
  globWitness as coreWitness,
  isGlobSyntax,
  parseGlob as coreParse,
  type Glob as CoreGlob,
  type LiteralReading,
  WITNESS_BUDGET,
  type Witness,
} from './vendor/spec-core/pattern/index.js';
import { segments } from './vendor/spec-core/path/index.js';

export { isGlobSyntax, type LiteralReading, WITNESS_BUDGET, type Witness };

/** A literal path a pattern names, and how it was read. */
export interface Literal {
  readonly path: string;
  readonly reading: LiteralReading;
}

export interface Glob {
  readonly source: string;
  /** The compiled pattern: spec-core's `path` dialect, case-sensitive. */
  readonly compiled: CoreGlob;
  /**
   * Each path the pattern names with no glob syntax and no trailing `/`, one
   * per brace alternative; empty when it has none.
   */
  readonly literals: readonly Literal[];
}

export type GlobParse = { readonly ok: true; readonly glob: Glob } | { readonly ok: false; readonly error: string };

export interface ParseOptions {
  /**
   * How a path with no glob syntax is read: `file`, that path alone;
   * `directory`, everything beneath it; `either`, both. A function is asked
   * per literal path, as {@link readingIn} answers for a tree. `file` when
   * unset: a path nothing says is a directory is not read as one.
   */
  readonly literal?: LiteralReading | ((path: string) => LiteralReading) | undefined;
}

/** Parses a scope pattern, or says why it cannot. */
export function parseGlob(source: string, options: ParseOptions = {}): GlobParse {
  const pattern = source.trim();
  if (pattern.startsWith('!')) return { ok: false, error: 'negated patterns are not supported; narrow the positive pattern' };
  // spec-core's own reading of where each alternative starts, a leading `./`
  // and `/` included (spec-core ADR-0003). A pattern it refuses, the core's
  // parse refuses in the same words, so either may say so. It comes first so
  // that a pattern led by `/`, which the core roots at the filesystem's root,
  // is refused in spec-brief's words.
  const read = globAlternatives(pattern);
  if (!read.ok) return { ok: false, error: read.error };
  if (read.rooted) return { ok: false, error: 'a pattern is relative to the repository root and cannot start with "/"' };
  const given = options.literal ?? 'file';
  const literals: Literal[] = [];
  const literal = (path: string): LiteralReading => {
    const reading = typeof given === 'function' ? given(path) : given;
    literals.push({ path, reading });
    return reading;
  };
  // A pattern too large to compile is refused by the core, with its reason,
  // as a malformed one is; what the reading throws is a defect, and passes on.
  const parsed = coreParse(pattern, { dialect: 'path', caseSensitive: true, literal });
  if (!parsed.ok) return parsed;
  // Once the core has parsed the pattern, so that an alternative naming no
  // path, `{/,x}`, is refused in the core's words. The text is named behind
  // the `/` that roots it, as spec-core gives it: it reads the same written
  // alone, so a `}` or `,` no group took is written as a class, `[}]`.
  const rooted = read.alternatives.find((alternative) => alternative.rooted);
  if (rooted !== undefined) {
    return { ok: false, error: `a pattern is relative to the repository root, and the braces expand to "/${rooted.text}", which starts with "/"` };
  }
  return { ok: true, glob: { source, compiled: parsed.glob, literals } };
}

/**
 * Whether a path matches. The path is read as a repository path: empty and
 * `.` segments are dropped, so `./src//a.ts` is `src/a.ts`.
 */
export function matchGlob(glob: Glob, path: string): boolean {
  const canonical = segments(path).join('/');
  return canonical !== '' && glob.compiled.match(canonical);
}

/** A list of files by path, so the files below a directory are one run of it. */
interface FileIndex {
  /** Each path the list holds, as {@link matchGlob} reads it, once, in code-unit order. */
  readonly paths: readonly string[];
  /** The positions in the list of each path's files. */
  readonly positions: ReadonlyMap<string, readonly number[]>;
}

const indexes = new WeakMap<readonly string[], FileIndex>();

/** The index of a list. Built once per list, which every pattern of a run shares, as {@link treeOf} is. */
function indexOf(files: readonly string[]): FileIndex {
  const known = indexes.get(files);
  if (known !== undefined) return known;
  const positions = new Map<string, number[]>();
  files.forEach((file, position) => {
    const path = segments(file).join('/');
    const others = positions.get(path);
    if (others === undefined) positions.set(path, [position]);
    else others.push(position);
  });
  const index = { paths: [...positions.keys()].sort(), positions };
  indexes.set(files, index);
  return index;
}

/**
 * The positions of the files a glob can match: the run of the index below
 * each of its bases. spec-core names, for each brace alternative, the
 * directory every match of it lies below, or `''` where a match can lie
 * anywhere, so a file below none of them cannot match. Asking every pattern
 * about every file made `lint`, `matrix` and `schedule` grow with patterns
 * times files: over 240 briefs and 93,000 files a lint took 35 s, nine tenths
 * of it matching.
 */
function* candidates(index: FileIndex, glob: Glob): Generator<number> {
  const { paths, positions } = index;
  for (const base of glob.compiled.bases) {
    const prefix = base === '' ? '' : `${base}/`;
    // The first path that sorts at or after the prefix. `<=` finds the same
    // one, an equivalent mutant: no path read so ends with `/`, so none
    // equals a prefix but `''`, which no glob matches.
    let low = 0;
    let high = paths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((paths[middle] as string) < prefix) low = middle + 1;
      else high = middle;
    }
    for (let place = low; place < paths.length && (paths[place] as string).startsWith(prefix); place += 1) {
      yield* positions.get(paths[place] as string) as readonly number[];
    }
  }
}

/**
 * The files of a list a glob matches, in the list's order: those
 * {@link matchGlob} matches, asked only of the files below one of the glob's
 * bases.
 */
export function filesMatching(glob: Glob, files: readonly string[]): string[] {
  const index = indexOf(files);
  const matched = new Set<number>();
  for (const position of candidates(index, glob)) {
    if (matchGlob(glob, files[position] as string)) matched.add(position);
  }
  return [...matched].sort((a, b) => a - b).map((position) => files[position] as string);
}

/** Whether a glob matches any file of a list, asked only of the files below one of its bases. */
export function matchesAny(glob: Glob, files: readonly string[]): boolean {
  const index = indexOf(files);
  for (const position of candidates(index, glob)) {
    if (matchGlob(glob, files[position] as string)) return true;
  }
  return false;
}

/**
 * A shortest path every glob in `include` matches and none in `exclude` does,
 * `none` as a proof that there is no such path, or `undecided` when the search
 * met its budget first.
 */
export function globWitness(include: readonly Glob[], exclude: readonly Glob[] = [], budget: number = WITNESS_BUDGET): Witness {
  return coreWitness(
    include.map((g) => g.compiled),
    exclude.map((g) => g.compiled),
    budget,
  );
}

/** Whether every path `inner` matches is matched by one of `outer`, or `undecided`. */
export function globCovers(outer: readonly Glob[], inner: Glob, budget: number = WITNESS_BUDGET): boolean | 'undecided' {
  return coreCovers(
    outer.map((g) => g.compiled),
    inner.compiled,
    budget,
  );
}

/**
 * A path both globs match, or `null` when there is none: the 0.1 interface,
 * kept for the library's callers. It cannot say `undecided`, so a search that
 * meets its budget throws; {@link globWitness} answers in three ways.
 */
export function intersectGlobs(a: Glob, b: Glob, budget: number = WITNESS_BUDGET): string | null {
  const witness = globWitness([a, b], [], budget);
  if (witness.kind === 'undecided') {
    throw new Error(`whether "${a.source}" and "${b.source}" meet is undecided within the search's budget`);
  }
  return witness.kind === 'found' ? witness.path : null;
}

/**
 * The directories a walk must enter to find every match, one per brace
 * alternative: the leading literal segments, or a literal file's directory.
 * `''` for an alternative that can match at the root.
 */
export function globBases(glob: Glob): readonly string[] {
  return glob.compiled.bases;
}

/** The first of {@link globBases}: the 0.1 interface, kept for the library's callers. */
export function globBase(glob: Glob): string {
  // One base per alternative, and a pattern has at least one.
  return glob.compiled.bases[0] as string;
}

/** A brace alternative as its pattern writes it, and the index in the pattern where it ends. */
export interface WrittenAlternative {
  readonly written: string;
  readonly end: number;
}

/**
 * Each alternative of a pattern as written, in the order the core expands
 * them, and where each ends, when a `/` written there ends that alternative
 * and no other: the pattern itself when it has no braces, or the alternatives
 * of braces that end the pattern and whose own braces end theirs -
 * `lib/{util,new}`, `{a,b/{c,d}}`. `null` when more of the pattern follows
 * braces, `{a,b}/new`, since every alternative they give ends where the
 * pattern does; and for a pattern with a class, which may hold a brace or a
 * comma of its own and which this does not read.
 *
 * spec-core expands braces and keeps nothing of where an alternative was
 * written, and a note's advice is built from what was written, as the core
 * builds its own. So this reads braces as the expansion does, for a pattern
 * that parses: a `\` escapes the next character, and a `}` with no `{` open
 * is a literal.
 */
export function writtenAlternatives(pattern: string): WrittenAlternative[] | null {
  let depth = 0;
  let open = 0;
  const stops: number[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern.charAt(i);
    if (ch === '\\') {
      i += 1;
    } else if (ch === '[') {
      return null;
    } else if (ch === '{') {
      if (depth === 0) open = i;
      depth += 1;
    } else if (ch === ',' && depth === 1) {
      stops.push(i);
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) return i === pattern.length - 1 ? optionsOf(pattern, open, [...stops, i]) : null;
    }
  }
  return [{ written: pattern, end: pattern.length }];
}

/** The alternatives of the braces opened at `open`, each option ending at one of `stops`. */
function optionsOf(pattern: string, open: number, stops: readonly number[]): WrittenAlternative[] | null {
  const prefix = pattern.slice(0, open);
  const alternatives: WrittenAlternative[] = [];
  let start = open + 1;
  for (const stop of stops) {
    const inner = writtenAlternatives(pattern.slice(start, stop));
    if (inner === null) return null;
    for (const { written, end } of inner) alternatives.push({ written: prefix + written, end: start + end });
    start = stop + 1;
  }
  return alternatives;
}

/** A name with an extension, `login.ts` or `.eslintrc.json`, and not a dot-name such as `.github`. */
export function hasExtension(name: string): boolean {
  return /.\.[^.]+$/.test(name);
}

/** The files a tree holds, and every directory above one. */
export interface Tree {
  readonly files: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

const trees = new WeakMap<readonly string[], Tree>();

/** The tree a list of files describes. Built once per list, which every brief of a run shares. */
export function treeOf(files: readonly string[]): Tree {
  const known = trees.get(files);
  if (known !== undefined) return known;
  const directories = new Set<string>();
  for (const file of files) {
    for (let slash = file.indexOf('/'); slash !== -1; slash = file.indexOf('/', slash + 1)) directories.add(file.slice(0, slash));
  }
  const tree = { files: new Set(files), directories };
  trees.set(files, tree);
  return tree;
}

/** What the tree holds at a path: a file, a directory, or nothing. */
export function held(tree: Tree, path: string): 'file' | 'directory' | null {
  if (tree.files.has(path)) return 'file';
  return tree.directories.has(path) ? 'directory' : null;
}

/**
 * How a tree reads a literal path: a directory it holds is a directory, and
 * anything else is a file. Without a tree nothing is known to be a directory,
 * so every literal is a file; a trailing `/` says otherwise, and never reaches
 * this question.
 */
export function readingIn(files: readonly string[] | null): (path: string) => LiteralReading {
  if (files === null) return () => 'file';
  const tree = treeOf(files);
  return (path) => (held(tree, path) === 'directory' ? 'directory' : 'file');
}
