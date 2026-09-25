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
 *   rather than rooted at the filesystem; and a list entry's `!` has no list to
 *   belong to in a scope, so it is refused rather than read.
 * - Paths compare case-sensitively on every host, as git's do.
 * - A path with no glob syntax is read as the tree reads it: a file the tree
 *   holds is that file, a directory it holds is everything beneath it, and a
 *   path it does not hold is a file, unless it is written with a trailing `/`.
 *   The tree, not the spelling, knows that `Dockerfile` is a file and
 *   `docs/v1.2` a directory (ADR-0005, amended 2026-09-26).
 * - A trailing `/**` is at least one segment, so `docs/**` is the directory's
 *   contents and a collision witness is always a file.
 *
 * Nothing here compiles to a `RegExp`. Matching costs at most the pattern's
 * size times the path's length, and a question about two scopes that cannot be
 * answered within the search's budget answers `undecided`, never a guess.
 */

import {
  AutomatonTooLarge,
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
  /** Each path the pattern names with no glob syntax, one per brace alternative; empty when it has none. */
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
  if (pattern.startsWith('/')) return { ok: false, error: 'a pattern is relative to the repository root and cannot start with "/"' };
  const given = options.literal ?? 'file';
  const literals: Literal[] = [];
  const literal = (path: string): LiteralReading => {
    const reading = typeof given === 'function' ? given(path) : given;
    literals.push({ path, reading });
    return reading;
  };
  try {
    const parsed = coreParse(pattern, { dialect: 'path', caseSensitive: true, literal });
    return parsed.ok ? { ok: true, glob: { source, compiled: parsed.glob, literals } } : parsed;
  } catch (error) {
    // Too many states is a pattern nobody meant; anything else is a defect to surface.
    if (error instanceof AutomatonTooLarge) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Whether a path matches. The path is read as a repository path: empty and
 * `.` segments are dropped, so `./src//a.ts` is `src/a.ts`.
 */
export function matchGlob(glob: Glob, path: string): boolean {
  const canonical = segments(path).join('/');
  return canonical !== '' && glob.compiled.match(canonical);
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
  return glob.compiled.bases[0] ?? '';
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
    for (let slash = file.indexOf('/'); slash > 0; slash = file.indexOf('/', slash + 1)) directories.add(file.slice(0, slash));
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
