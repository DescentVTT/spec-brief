import { describe, expect, it } from 'vitest';

import {
  filesMatching,
  type Glob,
  globBase,
  globBases,
  globCovers,
  globWitness,
  hasExtension,
  held,
  intersectGlobs,
  type LiteralReading,
  matchesAny,
  matchGlob,
  parseGlob,
  readingIn,
  treeOf,
  writtenAlternatives,
} from '../src/glob.js';
import { parseGlob as coreParse } from '../src/vendor/spec-core/pattern/index.js';

function glob(source: string, literal?: LiteralReading | ((path: string) => LiteralReading)): Glob {
  const parsed = parseGlob(source, literal === undefined ? {} : { literal });
  if (!parsed.ok) throw new Error(`${source}: ${parsed.error}`);
  return parsed.glob;
}

function error(source: string): string {
  const parsed = parseGlob(source);
  return parsed.ok ? 'parsed' : parsed.error;
}

const matches = (pattern: string, path: string, literal?: LiteralReading): boolean => matchGlob(glob(pattern, literal), path);

/**
 * Patterns built from `atoms`, each some text, perhaps with braces in it,
 * then braces, drawn from a sequence seeded with `start`, so that a failure
 * names a pattern that fails again.
 */
function patternsOver(atoms: readonly string[], start: number): () => string {
  let seed = start;
  const random = (n: number): number => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const group = (depth: number): string => `{${Array.from({ length: 2 + random(2) }, () => text(depth + 1)).join(',')}}`;
  const text = (depth: number): string =>
    Array.from({ length: 1 + random(3) }, () => (depth < 2 && random(4) === 0 ? group(depth) : (atoms[random(atoms.length)] as string))).join('');
  return () => text(1) + group(0);
}

describe('parsing', () => {
  it("refuses a leading slash and a negation with spec-brief's own reasons, before the core reads them", () => {
    expect(error('!src/**')).toBe('negated patterns are not supported; narrow the positive pattern');
    expect(error('  !src/**')).toBe('negated patterns are not supported; narrow the positive pattern');
    expect(error('/src')).toBe('a pattern is relative to the repository root and cannot start with "/"');
    expect(error(' /src')).toBe('a pattern is relative to the repository root and cannot start with "/"');
    // A leading "./" goes with the slashes after it, as POSIX reads them:
    // ".//src" is "src", where it was "/src", refused as rooted.
    for (const pattern of ['.//src', '././/src', './//src', './/./src']) {
      expect(matches(pattern, 'src'), pattern).toBe(true);
      expect(matches(pattern, 'lib/src'), pattern).toBe(false);
    }
    // What is left is the root itself, refused as "./" is.
    expect(error('.//')).toBe('the pattern names the root itself, not a path under it');
    // A "./" that no "/" follows names nothing, and the rest is relative.
    expect(matches('./src', 'src')).toBe(true);
    expect(matches('././src/a.ts', 'src/a.ts')).toBe(true);
    expect(matches('.src', '.src')).toBe(true);
    // Not at the start, a "!" is a character like any other.
    expect(matches('a!b', 'a!b')).toBe(true);
  });

  it("refuses what the core refuses, in the core's words", () => {
    expect(error('')).toBe('the pattern is empty');
    expect(error('   ')).toBe('the pattern is empty');
    expect(error('src\\auth')).toBe('"\\" escapes glob syntax; separate directories with "/"');
    expect(error('src/+(a|b)')).toBe(
      'extended globs such as "+(a|b)" are not supported: write alternatives as "{a,b}", and a literal parenthesis as "[(]"',
    );
    // Two stars inside a name were read as one, which dropped every nested
    // file from a scope written "docs/**.md". The advice is the pattern
    // written, spelled both ways it may have meant.
    for (const [pattern, deep, flat] of [
      ['docs/**.md', 'docs/**/*.md', 'docs/*.md'],
      ['**.ts', '**/*.ts', '*.ts'],
      ['a**b', 'a*/**/*b', 'a*b'],
      ['src/a**', 'src/a*/**', 'src/a*'],
    ] as const) {
      expect(error(pattern), pattern).toBe(
        `"**" means any number of directories only as a whole segment: write "${deep}" for any depth, or "${flat}" for one level`,
      );
    }
    expect(error('../x')).toBe('a pattern cannot climb out of its root with ".."');
    expect(error('.')).toBe('the pattern names no path');
    expect(error('./')).toBe('the pattern names the root itself, not a path under it');
    // Inside braces "./" was the contents of ".", every path.
    expect(error('{./,src}')).toBe('the braces expand to "./", which names no path');
    expect(error('{,src}')).toBe('the braces expand to an empty pattern');
    expect(error('a{b')).toBe('a "{" is never closed');
    expect(error('a[b')).toBe('a "[" is never closed');
    expect(error('[z-a]')).toBe('the range "z-a" runs backwards');
    expect(error('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}')).toBe('the braces expand to more than 256 patterns');
  });

  it('refuses a brace alternative that starts with "/", as a pattern that starts with one is, naming the alternative', () => {
    // spec-core reads a leading "/" on an alternative as on the pattern, so
    // "{/docs,x}" is "/docs", rooted at the filesystem's root, or "x": "docs"
    // fell out of the scope and nothing said so. It read "docs" or "x" before.
    for (const [pattern, text] of [
      ['{/docs,x}', '/docs'],
      ['{x,/docs}', '/docs'],
      ['{x,{/docs,y}}', '/docs'],
      // Named as spec-core reads it, one "/" and no "./" after it.
      ['{//docs,x}', '/docs'],
      ['{/./docs,x}', '/docs'],
      ['{/docs/,x}', '/docs/'],
      ['{/*,x}', '/*'],
      ['{/docs}', '/docs'],
      ['{/docs,/src}', '/docs'],
      ['{a,/b}c', '/bc'],
      ['{,x}{/b,c}', '/b'],
    ] as const) {
      expect(error(pattern), pattern).toBe(`a pattern is relative to the repository root, and the braces expand to "${text}", which starts with "/"`);
    }
    // One that names no path is refused in the core's words, as it was.
    expect(error('{/,x}')).toBe('the braces expand to "/", which names no path');
  });

  it('reads a "/" after a leading "./" as rooting nothing, on an alternative as on the pattern', () => {
    // A "./" goes with the slashes after it, one the braces give included:
    // "./{/docs,x}" is ".//docs" or "./x", which is "docs" or "x". Each was
    // refused as naming "/docs".
    for (const [pattern, path] of [
      ['{.//docs,x}', 'docs'],
      ['./{/docs,x}', 'docs'],
      ['././{/docs,x}', 'docs'],
      ['{.,x}/{/b,c}', 'b'],
      ['{.,x}/{/b,c}', 'x/b'],
    ] as const) {
      expect(matches(pattern, path), `${pattern} ${path}`).toBe(true);
      expect(matches(pattern, `a/${path}`), `${pattern} a/${path}`).toBe(false);
    }
    // A "/" that no "./" of the pattern's stands before still roots its text.
    expect(error('{./x,/docs}')).toBe('a pattern is relative to the repository root, and the braces expand to "/docs", which starts with "/"');
  });

  it('reads a "/" inside braces that starts no text as it did', () => {
    // After a name the "/" is an empty segment, which names nothing:
    // "docs/{/a,b}" is "docs//a", which is "docs/a", or "docs/b".
    expect(matches('docs/{/a,b}', 'docs/a')).toBe(true);
    expect(matches('docs/{/a,b}', 'docs/b')).toBe(true);
    expect(matches('a{/b,c}', 'a/b')).toBe(true);
    expect(matches('x{a,{/b,c}}', 'x/b')).toBe(true);
    expect(matches('{docs,x}', 'docs')).toBe(true);
    expect(matches('{a/,b}', 'a/x')).toBe(true);
    // An escaped comma ends no alternative, so no text starts at the "/" after it.
    expect(matches('{\\,/b,c}', ',/b')).toBe(true);
  });

  it('finds the alternative it names by reading the braces as the core expands them', () => {
    for (const [pattern, text] of [
      // A class holds no brace syntax: a "{", "}" or "," in one opens, closes
      // or ends nothing.
      ['{[{],/b}', '/b'],
      ['{[}],/b}', '/b'],
      ['{/b,[x]}]', '/b]'],
      // Its first member is a member even when it is "]", after a "!" or "^"
      // too, and an escaped "]" closes nothing.
      ['{[]{],/b}', '/b'],
      ['{[!]{],/b}', '/b'],
      ['{[^]{],/b}', '/b'],
      ['{[\\]{],/b}', '/b'],
      ['{/b,[\\]}]}', '/b'],
      // A "[" that no "]" closes within its segment is no class: "{x,[a,/}]"
      // is "x]", "[a]" or "/]".
      ['{x,[a,/}]', '/]'],
      // A "}" with no "{" open is a literal, and braces after it still
      // expand. The text is named as spec-core gives it, such a "}" or ","
      // written as the class of that one character, which reads the same
      // inside braces as outside them.
      ['{/a,x}}{b,c}', '/a[}]b'],
      ['{/a,x},{b,c}', '/a[,]b'],
    ] as const) {
      expect(error(pattern), pattern).toBe(`a pattern is relative to the repository root, and the braces expand to "${text}", which starts with "/"`);
    }
  });

  it('refuses a pattern too large to compile, with a reason rather than an exception', () => {
    const wide = `{${Array.from({ length: 250 }, (_, i) => `${'?'.repeat(300)}${i}`).join(',')}}`;
    expect(error(wide)).toBe('the pattern compiles to more than 65536 states');
  });

  it('passes on a failure of its own reading rather than calling it a malformed pattern', () => {
    const reading = (): LiteralReading => {
      throw new Error('the tree could not be read');
    };
    expect(() => parseGlob('src/a', { literal: reading })).toThrow('the tree could not be read');
  });

  it('reads a lone closing brace as the literal it can only be', () => {
    expect(matches('a}b', 'a}b')).toBe(true);
  });

  it('reads parentheses as literal unless a group holds a "|"', () => {
    expect(matches('notes/C++(notes).md', 'notes/C++(notes).md')).toBe(true);
    expect(matches('*(2017).md', 'report(2017).md')).toBe(true);
    expect(matches('@(a)', '@(a)')).toBe(true);
    expect(matches('@(a)', 'a')).toBe(false);
  });

  it('keeps the source as written and records nothing literal about a pattern with glob syntax', () => {
    const g = glob(' src/*.ts ');
    expect(g.source).toBe(' src/*.ts ');
    expect(g.literals).toEqual([]);
  });
});

describe('a literal path', () => {
  it('is a file unless something says otherwise', () => {
    expect(glob('src/auth').literals).toEqual([{ path: 'src/auth', reading: 'file' }]);
    expect(matches('src/auth', 'src/auth')).toBe(true);
    expect(matches('src/auth', 'src/auth/login.ts')).toBe(false);
  });

  it('read as a directory is what is beneath it, not the directory', () => {
    expect(matches('src/auth', 'src/auth/login.ts', 'directory')).toBe(true);
    expect(matches('src/auth', 'src/auth', 'directory')).toBe(false);
  });

  it('read as either is itself and what is beneath it', () => {
    expect(matches('src/auth', 'src/auth', 'either')).toBe(true);
    expect(matches('src/auth', 'src/auth/login.ts', 'either')).toBe(true);
    expect(matches('src/auth', 'src/authz', 'either')).toBe(false);
  });

  it('is read once per brace alternative, and each reading is recorded', () => {
    const asked: string[] = [];
    const g = glob('./src/{auth,db.ts}', (path) => {
      asked.push(path);
      return path === 'src/auth' ? 'directory' : 'file';
    });
    expect(asked).toEqual(['src/auth', 'src/db.ts']);
    expect(g.literals).toEqual([
      { path: 'src/auth', reading: 'directory' },
      { path: 'src/db.ts', reading: 'file' },
    ]);
    expect(matchGlob(g, 'src/auth/x.ts')).toBe(true);
    expect(matchGlob(g, 'src/db.ts')).toBe(true);
    expect(matchGlob(g, 'src/db.ts/x')).toBe(false);
  });

  it('written with a trailing slash means what is beneath it, and the reading is not asked', () => {
    const asked: string[] = [];
    const g = glob('src/newmod/', (path) => {
      asked.push(path);
      return 'file';
    });
    expect(asked).toEqual([]);
    expect(g.literals).toEqual([]);
    expect(matchGlob(g, 'src/newmod/index.ts')).toBe(true);
    expect(matchGlob(g, 'src/newmod')).toBe(false);
  });

  it('written with a trailing slash inside braces means what is beneath it, as written alone', () => {
    // The slash said nothing inside braces: `src/newmod` was a literal, read
    // as a file unless the tree held the directory.
    const asked: string[] = [];
    const g = glob('{src/newmod/,lib}', (path) => {
      asked.push(path);
      return 'file';
    });
    expect(asked).toEqual(['lib']);
    expect(g.literals).toEqual([{ path: 'lib', reading: 'file' }]);
    expect(matchGlob(g, 'src/newmod/index.ts')).toBe(true);
    expect(matchGlob(g, 'src/newmod')).toBe(false);
    expect(matchGlob(g, 'lib')).toBe(true);
    expect(globBases(g)).toEqual(['src/newmod', '']);
  });
});

describe('an alternative as written', () => {
  it('is the pattern itself when it has no braces, escaped ones and a lone "}" included', () => {
    expect(writtenAlternatives('src/newmod')).toEqual([{ written: 'src/newmod', end: 10 }]);
    expect(writtenAlternatives('lib/\\{a,b\\}')).toEqual([{ written: 'lib/\\{a,b\\}', end: 11 }]);
    expect(writtenAlternatives('a}b')).toEqual([{ written: 'a}b', end: 3 }]);
  });

  it('is each alternative of braces that end the pattern, nested ones too, in the order the core expands them', () => {
    expect(writtenAlternatives('lib/{util,new}')).toEqual([
      { written: 'lib/util', end: 9 },
      { written: 'lib/new', end: 13 },
    ]);
    expect(writtenAlternatives('{a,b/{c,d}}')).toEqual([
      { written: 'a', end: 2 },
      { written: 'b/c', end: 7 },
      { written: 'b/d', end: 9 },
    ]);
    expect(writtenAlternatives('a}/{b,c\\,d}')).toEqual([
      { written: 'a}/b', end: 5 },
      { written: 'a}/c\\,d', end: 10 },
    ]);
  });

  it('is not given where more of the pattern follows braces, or where a class may hold a brace or a comma', () => {
    for (const pattern of ['{a,b}/new', '{a,b}{c,d}', 'lib/{a,b{c,d}e}', '{a,b}}', 'lib/{[,],new}', '[a]/{b,c}']) {
      expect(writtenAlternatives(pattern), pattern).toBeNull();
    }
  });

  /**
   * Checks each alternative as written against the core, over 50 patterns
   * built from `atoms` that parse: taken together they read as the pattern,
   * and a `/` where one ends changes that alternative alone.
   */
  const agreesOver = (atoms: readonly string[], start: number): void => {
    const next = patternsOver(atoms, start);
    // Whether a pattern reads as the alternatives given, taken together.
    const readsAs = (pattern: string, alternatives: readonly string[]): boolean => {
      const whole = glob(pattern);
      const each = alternatives.map((a) => glob(a));
      return globCovers(each, whole) === true && each.every((a) => globCovers([whole], a) === true);
    };
    let checked = 0;
    for (let n = 0; n < 1000 && checked < 50; n += 1) {
      const pattern = next();
      if (!parseGlob(pattern).ok) continue;
      const alternatives = writtenAlternatives(pattern);
      if (alternatives === null) continue;
      checked += 1;
      const ends = alternatives.map((a) => a.end);
      expect(ends, pattern).toEqual([...ends].sort((x, y) => x - y));
      expect(readsAs(pattern, alternatives.map((a) => a.written)), pattern).toBe(true);
      alternatives.forEach(({ end }, k) => {
        const slashed = `${pattern.slice(0, end)}/${pattern.slice(end)}`;
        expect(readsAs(slashed, alternatives.map((a, j) => (j === k ? `${a.written}/` : a.written))), slashed).toBe(true);
      });
    }
    expect(checked).toBe(50);
  };

  const atoms = ['a', 'b', 'x.ts', '?', 'a/', 'b/', '', '\\{', '\\,', '\\}', '}'];

  it('agrees with the core over a generated corpus: a "/" where one ends changes that alternative alone', () => {
    agreesOver(atoms, 20260929);
  });

  it('agrees with the core where an alternative holds "." segments, which the core refuses when they name no path', () => {
    // "{./,a}" parsed, and its "./" read as every path where "./" written
    // alone is refused, so the alternatives as written did not read as the
    // pattern: this corpus met two such, "{?,./,./}" and "{./a/,./}". Refused
    // now, they are left out as every pattern that does not parse is. "./" is
    // weighted twice so that an option made of it alone comes up at all.
    agreesOver([...atoms, '.', './', './'], 20260929);
  });

  it('agrees with the core where an option starts with "/", which spec-brief refuses where it starts a text', () => {
    // The core dropped such a "/", and it roots one now; spec-brief refuses
    // "{/a,b}", and "a{/a,b}" is "a/a" or "ab" as it was, so the corpus
    // checks what is left, "/" after a name.
    agreesOver([...atoms, '/', '/a'], 20260929);
  });
});

describe('a rooted alternative', () => {
  it('is refused where the core roots one, and only there, over a generated corpus', () => {
    // Every alternative the core roots at the filesystem's root has a base
    // that starts with "/", and no other has. Classes, escapes and lone
    // braces are among the atoms, since the text named is spec-core's
    // reading of the braces, and must read alone as it did inside them.
    const next = patternsOver(['a', 'b', '/', '/a', './', '.', '', '\\,', '}', '[,]', '[{]', '[]}]', '[!]]'], 20260929);
    let braced = 0;
    let relative = 0;
    for (let n = 0; n < 2000; n += 1) {
      const pattern = next();
      const core = coreParse(pattern, { dialect: 'path', caseSensitive: true });
      if (!core.ok) continue;
      const roots = core.glob.bases.some((base) => base.startsWith('/'));
      const parsed = parseGlob(pattern);
      expect(parsed.ok, pattern).toBe(!roots);
      if (parsed.ok) {
        relative += 1;
        continue;
      }
      const named = /^a pattern is relative to the repository root, and the braces expand to "(.*)", which starts with "\/"$/.exec(parsed.error)?.[1];
      if (named === undefined) {
        expect(parsed.error, pattern).toBe('a pattern is relative to the repository root and cannot start with "/"');
        continue;
      }
      braced += 1;
      // The text named is one the core roots written alone.
      const alone = coreParse(named, { dialect: 'path', caseSensitive: true });
      expect(alone.ok && alone.glob.bases.every((base) => base.startsWith('/')), `${pattern}: ${named}`).toBe(true);
    }
    // 226 and 1435 when written; 192 and 1487 at spec-core 5666c96, where a
    // "/" after a "./" roots nothing.
    expect(braced).toBeGreaterThanOrEqual(150);
    expect(relative).toBeGreaterThanOrEqual(1000);
  });
});

describe('the tree', () => {
  const files = ['Dockerfile', 'docs/v1.2/notes.md', 'src/auth/login.ts', 'src/a.ts'];

  it('holds files, and every directory above one', () => {
    const tree = treeOf(files);
    expect([...tree.directories].sort()).toEqual(['docs', 'docs/v1.2', 'src', 'src/auth']);
    expect(held(tree, 'Dockerfile')).toBe('file');
    expect(held(tree, 'docs/v1.2')).toBe('directory');
    expect(held(tree, 'src/newmod')).toBeNull();
    expect(held(tree, 'src/a')).toBeNull();
  });

  it('is built once for a list every brief of a run shares', () => {
    expect(treeOf(files)).toBe(treeOf(files));
    expect(treeOf([...files])).not.toBe(treeOf(files));
  });

  it('reads a literal from what it holds, not from how it is spelt', () => {
    const reading = readingIn(files);
    expect(reading('Dockerfile')).toBe('file');
    expect(reading('docs/v1.2')).toBe('directory');
    expect(reading('src/a.ts')).toBe('file');
    // Not held: a file, whatever the name looks like.
    expect(reading('src/newmod')).toBe('file');
    expect(reading('lib')).toBe('file');
  });

  it('unknown, reads every literal as a file', () => {
    const reading = readingIn(null);
    expect(reading('src')).toBe('file');
  });

  it('no longer lets a file overlap a pattern through a path beneath it, nor misses a dotted directory', () => {
    const reading = readingIn(files);
    // The extension heuristic read Dockerfile as a directory and found Dockerfile/x.ts.
    expect(intersectGlobs(glob('Dockerfile', reading), glob('**/x.ts', reading))).toBeNull();
    // It read docs/v1.2 as a file, and missed every note inside it.
    expect(intersectGlobs(glob('docs/v1.2', reading), glob('docs/**/*.md', reading))).toBe('docs/v1.2/.md');
  });
});

describe('an extension', () => {
  it('is a dot with something before it and something after it', () => {
    for (const name of ['a.ts', '.eslintrc.json', 'v1.2', 'a.b.c']) expect(hasExtension(name), name).toBe(true);
    for (const name of ['Makefile', '.github', 'a.', '.', '..', 'x.y.']) expect(hasExtension(name), name).toBe(false);
  });
});

describe('matching', () => {
  const table: [string, string, boolean][] = [
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    // A trailing globstar is at least one segment: the contents, not the directory.
    ['src/**', 'src', false],
    ['src/**', 'src/a/b/c', true],
    ['src/', 'src/deep/x.ts', true],
    ['src/', 'src', false],
    ['**/x.ts', 'x.ts', true],
    ['**/x.ts', 'a/b/x.ts', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/x/y/c', false],
    ['*', '.hidden', true],
    ['?.md', 'ab.md', false],
    ['[!abc].md', 'b.md', false],
    ['Src/*', 'src/a', false],
    ['*a*a*a*a*a*b', 'a'.repeat(60), false],
    ['src/**/*.ts', '', false],
  ];
  for (const [pattern, path, expected] of table) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} "${path}"`, () => {
      expect(matches(pattern, path)).toBe(expected);
    });
  }

  it('reads the path as a repository path, without empty or "." segments', () => {
    expect(matches('src/a.ts', './src/./a.ts')).toBe(true);
    expect(matches('src/a.ts', 'src//a.ts')).toBe(true);
    expect(matches('**', '/')).toBe(false);
    expect(matches('**', '.')).toBe(false);
  });
});

describe('matching a list of files', () => {
  // Paths that sort beside a directory's run, or are not written in canonical
  // form, and names beside `/` in code-unit order: `-`, `.`, `0`.
  const files = [
    'src/a.ts',
    'src/b/c.ts',
    './src/./d.ts',
    'src//e.ts',
    'src-x/f.ts',
    'src.ts',
    'src0/g.ts',
    'src',
    'lib/a.ts',
    'lib/deep/er/h.md',
    'docs/v1.2/i.md',
    'Src/j.ts',
    'a/src/k.ts',
    '.',
    '/',
    '',
    'src/a.ts',
  ];
  const patterns = [
    '**',
    '*.ts',
    '**/*.ts',
    'src/**',
    'src/',
    'src',
    'src/*.ts',
    'src/a.ts',
    'src/**/*.ts',
    '{src,lib}/**',
    '{src/a.ts,lib}',
    'src-x/**',
    'src?/*.ts',
    '[a-z]*/*.ts',
    'lib/**/h.md',
    'docs/v1.2',
    'docs/v1.2/',
    'nowhere/**',
    'a/{src,lib}/*.ts',
    // Bases one inside another, or one that is the root: a file below both is one file.
    '{src,src/b}/*.ts',
    '{**/a.ts,src/*.ts}',
  ];

  it('finds what matching each file finds, in the list\'s order, however the tree reads a literal', () => {
    // And every pattern of one to three segments drawn from these.
    const parts = ['src', 'lib', 'Src', 'src-x', 'src0', 'docs', 'v1.2', 'deep', '*', '**', '?rc', '{src,lib}', '[a-z]*', 'a.ts', '*.ts', '*.md'];
    const all = [...patterns];
    for (const first of parts) {
      all.push(first, `${first}/`);
      for (const second of parts) {
        all.push(`${first}/${second}`);
        for (const third of ['*.ts', 'c.ts', '**', 'er']) all.push(`${first}/${second}/${third}`);
      }
    }
    for (const reading of [readingIn(files), 'file', 'directory', 'either'] as const) {
      for (const pattern of all) {
        const parsed = parseGlob(pattern, { literal: reading });
        if (!parsed.ok) continue;
        const expected = files.filter((file) => matchGlob(parsed.glob, file));
        expect(filesMatching(parsed.glob, files), pattern).toEqual(expected);
        expect(matchesAny(parsed.glob, files), pattern).toBe(expected.length > 0);
      }
    }
  });

  it('asks nothing of an empty list', () => {
    expect(filesMatching(glob('**'), [])).toEqual([]);
    expect(matchesAny(glob('**'), [])).toBe(false);
  });

  it('asks a glob only about the files below one of its bases', () => {
    // Asking every pattern about every file is what made a lint grow with
    // patterns times files. The paths asked about are counted here, since a
    // clock cannot be read under instrumentation.
    const list = ['lib/a.ts', 'src/a.ts', 'src/b/c.ts', './src/./d.ts', 'src-x/f.ts', 'src.ts', 'src0/g.ts', 'src', 'a/src/k.ts'];
    const asked = (pattern: string, ask: (glob: Glob, files: readonly string[]) => unknown): string[] => {
      const parsed = glob(pattern);
      const paths: string[] = [];
      const match = (path: string): boolean => {
        paths.push(path);
        return parsed.compiled.match(path);
      };
      ask({ ...parsed, compiled: { ...parsed.compiled, match } }, list);
      return paths;
    };
    expect(asked('src/**/*.md', filesMatching)).toEqual(['src/a.ts', 'src/b/c.ts', 'src/d.ts']);
    expect(asked('src/**/*.md', matchesAny)).toEqual(['src/a.ts', 'src/b/c.ts', 'src/d.ts']);
    expect(asked('{lib,a/src}/*.ts', filesMatching)).toEqual(['lib/a.ts', 'a/src/k.ts']);
    expect(asked('nowhere/**', filesMatching)).toEqual([]);
    // A pattern that can match at any depth has the root for a base, and is asked about every file.
    expect(asked('**/*.md', filesMatching)).toEqual(['a/src/k.ts', 'lib/a.ts', 'src', 'src-x/f.ts', 'src.ts', 'src/a.ts', 'src/b/c.ts', 'src/d.ts', 'src0/g.ts']);
  });
});

describe('the set questions', () => {
  it('name a file as the witness: a trailing globstar is never the directory', () => {
    expect(globWitness([glob('docs/adr/**'), glob('docs/adr/**')])).toEqual({ kind: 'found', path: 'docs/adr/x' });
    expect(intersectGlobs(glob('src/auth/**'), glob('src/**/session.ts'))).toBe('src/auth/session.ts');
  });

  it('leave out what a scope protects', () => {
    const schema = glob('src/db/schema.ts');
    expect(globWitness([glob('src/db/*.ts'), glob('src/db/*.ts')], [schema])).toEqual({ kind: 'found', path: 'src/db/.ts' });
    expect(globWitness([schema, glob('src/**')], [schema])).toEqual({ kind: 'none' });
  });

  it('prove two scopes apart', () => {
    expect(intersectGlobs(glob('src/auth/**'), glob('src/db/**'))).toBeNull();
    expect(globWitness([glob('*.ts'), glob('*.md')])).toEqual({ kind: 'none' });
  });

  it('decide whether one scope lies inside others', () => {
    expect(globCovers([glob('src/**')], glob('src/db/schema.ts'))).toBe(true);
    expect(globCovers([glob('src/db/schema.ts')], glob('src/**'))).toBe(false);
    expect(globCovers([glob('src/*.ts'), glob('src/*.md')], glob('src/*.{ts,md}'))).toBe(true);
  });

  it('say undecided when the budget runs out, and the 0.1 interface refuses to guess', () => {
    expect(globWitness([glob('src/**'), glob('**/*.ts')], [], 1)).toEqual({ kind: 'undecided' });
    expect(globCovers([glob('src/*.ts')], glob('src/**'), 1)).toBe('undecided');
    expect(() => intersectGlobs(glob('src/**'), glob('**/*.ts'), 1)).toThrow(
      'whether "src/**" and "**/*.ts" meet is undecided within the search\'s budget',
    );
  });
});

describe('the base directories', () => {
  it('are the literal prefix of each alternative, or a literal file path\'s directory', () => {
    expect(globBases(glob('src/auth/*.ts'))).toEqual(['src/auth']);
    expect(globBases(glob('src/auth/login.ts'))).toEqual(['src/auth']);
    expect(globBases(glob('src/auth', 'directory'))).toEqual(['src/auth']);
    expect(globBases(glob('src/auth'))).toEqual(['src']);
    expect(globBases(glob('**/*.ts'))).toEqual(['']);
    expect(globBases(glob('{src,lib}/a.ts'))).toEqual(['src', 'lib']);
    expect(globBase(glob('{src,lib}/a.ts'))).toBe('src');
    expect(globBase(glob('x.ts'))).toBe('');
  });
});
