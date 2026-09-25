import { describe, expect, it } from 'vitest';

import { type Glob, globBase, intersectGlobs, intersectTokens, MAX_ALTERNATIVES, matchGlob, parseGlob } from '../src/glob.js';

function glob(source: string): Glob {
  const parsed = parseGlob(source);
  if (!parsed.ok) throw new Error(`${source}: ${parsed.error}`);
  return parsed.glob;
}

function error(source: string): string {
  const parsed = parseGlob(source);
  return parsed.ok ? 'parsed' : parsed.error;
}

const matches = (pattern: string, path: string): boolean => matchGlob(glob(pattern), path);

describe('parsing', () => {
  it('refuses what it does not support, with a reason', () => {
    expect(error('')).toBe('the pattern is empty');
    expect(error('   ')).toBe('the pattern is empty');
    expect(error('!src/**')).toBe('negated patterns are not supported; narrow the positive pattern');
    expect(error('/src')).toBe('a pattern is relative to the repository root and cannot start with "/"');
    expect(error('src\\auth')).toBe('"\\" escapes glob syntax; separate directories with "/"');
    expect(error('src/+(a|b)')).toBe('extended globs such as "+(a|b)" are not supported');
    expect(error('@(a)')).toBe('extended globs such as "+(a|b)" are not supported');
    expect(error('../x')).toBe('a pattern cannot leave the repository with ".."');
    expect(error('.')).toBe('the pattern names no path');
    expect(error('./.')).toBe('the pattern names no path');
    expect(error('a{b')).toBe('a "{" is never closed');
    expect(error('a}b')).toBe('a "}" closes no "{"');
    expect(error('a[b')).toBe('a "[" is never closed');
    expect(error('a[]')).toBe('a "[" is never closed');
    expect(error('[z-a]')).toBe('the range "z-a" runs backwards');
    expect(error('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}')).toBe(`the braces expand to more than ${MAX_ALTERNATIVES} patterns`);
  });

  it('accepts escapes of glob syntax, and an escaped paren is not an extglob', () => {
    expect(error('a\\*b')).toBe('parsed');
    expect(error('a\\+(b)')).toBe('parsed');
    expect(matches('a\\*b', 'a*b')).toBe(true);
    expect(matches('a\\*b', 'axb')).toBe(false);
    expect(matches('\\{x\\}', '{x}')).toBe(true);
  });

  it('strips a leading ./, reads a trailing / as everything beneath', () => {
    expect(matches('./src/a.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/', 'src/deep/x.ts')).toBe(true);
    expect(matches('./', 'anything/at/all')).toBe(true);
    expect(matches('src/*/', 'src/a/b.ts')).toBe(true);
  });

  it('reads a literal path as a directory, unless it names a file', () => {
    expect(matches('src/auth', 'src/auth/login.ts')).toBe(true);
    expect(matches('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/a.ts', 'src/a.ts/x')).toBe(false);
    expect(matches('.eslintrc.json', '.eslintrc.json/x')).toBe(false);
    expect(matches('.github', '.github/workflows/ci.yml')).toBe(true);
    expect(matches('v1.2/', 'v1.2/notes.md')).toBe(true);
    const makefile = parseGlob('Makefile', { isFile: (p) => p === 'Makefile' });
    expect(makefile.ok && matchGlob(makefile.glob, 'Makefile/x')).toBe(false);
    expect(makefile.ok && matchGlob(makefile.glob, 'Makefile')).toBe(true);
    expect(matches('Makefile', 'Makefile/x')).toBe(true);
    expect(matches('a\\*b', 'a*b/c')).toBe(true);
    const escaped = parseGlob('a\\*b', { isFile: (p) => p === 'a*b' });
    expect(escaped.ok && matchGlob(escaped.glob, 'a*b/c')).toBe(false);
  });

  it('does not let a file path overlap a pattern through a path beneath it', () => {
    expect(intersectGlobs(glob('src/api/orders.ts'), glob('src/**/session.ts'))).toBeNull();
    expect(intersectGlobs(glob('src/api'), glob('src/**/session.ts'))).toBe('src/api/session.ts');
  });

  it('collapses repeated globstars and stars', () => {
    const g = glob('a/**/**/b');
    expect(g.alternatives[0]?.map((s) => s.kind)).toEqual(['pattern', 'globstar', 'pattern']);
    const star = glob('a**b.ts');
    const first = star.alternatives[0]?.[0];
    expect(first?.kind === 'pattern' ? first.tokens.filter((t) => t.kind === 'star').length : 0).toBe(1);
  });

  it('expands braces, nested and next to classes', () => {
    expect(glob('src/{a,b/{c,d}}.ts').alternatives.length).toBe(3);
    expect(matches('src/{a,b/{c,d}}.ts', 'src/b/d.ts')).toBe(true);
    expect(matches('[{]x', '{x')).toBe(true);
    expect(matches('{a\\,b,c}', 'a,b')).toBe(true);
    expect(matches('x{,y}', 'x')).toBe(true);
    expect(matches('x{,y}', 'xy')).toBe(true);
  });

  it('splits a brace group on its own commas, not on one inside a class', () => {
    expect(glob('{[,]x,y}').alternatives).toHaveLength(2);
    expect(matches('{[,]x,y}', ',x')).toBe(true);
    expect(matches('{[,]x,y}', 'y')).toBe(true);
    expect(matches('{[,]x,y}', '[')).toBe(false);
    // A brace inside a class opens or closes nothing either.
    expect(glob('x{[}],a}').alternatives).toHaveLength(2);
    expect(matches('x{[}],a}', 'x}')).toBe(true);
    expect(matches('x{[}],a}', 'xa')).toBe(true);
    expect(matches('{[{],b}', '{')).toBe(true);
    expect(matches('{[{],b}', 'b')).toBe(true);
    // A bracket that closes no class is a literal, and the comma after it splits.
    expect(error('{[,b}')).toBe('a "[" is never closed');
  });
});

describe('matching', () => {
  const table: [string, string, boolean][] = [
    ['src/auth', 'src/auth', true],
    ['src/auth', 'src/auth/login.ts', true],
    ['src/auth', 'src/authz/x', false],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/**', 'src', true],
    ['src/**', 'src/a/b/c', true],
    ['**/x.ts', 'x.ts', true],
    ['**/x.ts', 'a/b/x.ts', true],
    ['**/x.ts', 'a/b/y.ts', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a/**/b', 'a/x/y/c', false],
    ['*', '.hidden', true],
    ['?.md', 'a.md', true],
    ['?.md', 'ab.md', false],
    ['[abc].md', 'b.md', true],
    ['[!abc].md', 'b.md', false],
    ['[^abc].md', 'd.md', true],
    ['[a-c]x', 'bx', true],
    ['[a-c]x', 'dx', false],
    ['[]]x', ']x', true],
    ['[!]]x', ']x', false],
    ['[a-]x', '-x', true],
    ['[\\]]x', ']x', true],
    ['Src/*', 'src/a', false],
    ['*a*a*a*a*a*b', 'a'.repeat(60), false],
    ['src/**/*.ts', '', false],
  ];
  for (const [pattern, path, expected] of table) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} "${path}"`, () => {
      expect(matches(pattern, path)).toBe(expected);
    });
  }

  it('matches characters beyond the basic plane as one character', () => {
    const face = String.fromCodePoint(0x1f600);
    expect(matches('?.md', `${face}.md`)).toBe(true);
    expect(matches(`[${face}]`, face)).toBe(true);
  });

  it('never lets ? or a class match a slash', () => {
    expect(matches('a?b', 'a/b')).toBe(false);
    expect(matches('a[!x]b', 'a/b')).toBe(false);
  });
});

describe('intersection', () => {
  const both = (a: string, b: string): string | null => intersectGlobs(glob(a), glob(b));

  it('finds a witness both scopes cover, and checks it against both', () => {
    const cases: [string, string][] = [
      ['src/auth/**', 'src/**/session.ts'],
      ['src/*.ts', 'src/a*'],
      ['**', '**'],
      ['*', '*'],
      ['**/*.md', 'docs/**'],
      ['a/[b-d]x', 'a/?x'],
      ['a/[!b]', 'a/[a-c]'],
      ['src/auth', 'src/auth/login.ts'],
      ['x/{a,b}.ts', 'x/b.*'],
      ['**/a/**', 'b/**/c'],
    ];
    for (const [a, b] of cases) {
      const witness = both(a, b);
      expect(witness, `${a} and ${b}`).not.toBeNull();
      expect(matches(a, witness as string), `${witness} in ${a}`).toBe(true);
      expect(matches(b, witness as string), `${witness} in ${b}`).toBe(true);
    }
  });

  it('proves scopes apart when no file can be in both', () => {
    const cases: [string, string][] = [
      ['src/auth/**', 'src/db/**'],
      ['*.ts', '*.md'],
      ['a/*', 'a/*/b'],
      ['a/[abc]', 'a/[!abc]'],
      ['a/[a-c]', 'a/[x-z]'],
      ['a/b?', 'a/b'],
      ['src/auth', 'src/authz'],
      ['x/*a', 'x/*b'],
    ];
    for (const [a, b] of cases) expect(both(a, b), `${a} and ${b}`).toBeNull();
  });

  it('finds a character two negated classes both leave out', () => {
    expect(intersectTokens([{ kind: 'class', negated: true, ranges: [[0x61, 0x7a]] }], [{ kind: 'class', negated: true, ranges: [[0x30, 0x39]] }])).toBe('_');
  });

  it('searches past the usual candidates when a class excludes all of them', () => {
    const everything: [number, number][] = [[0x0, 0x10fff]];
    expect(intersectTokens([{ kind: 'class', negated: true, ranges: everything }], [{ kind: 'any' }])).toBe(String.fromCodePoint(0x11000));
  });

  it('returns nothing when a class admits no character at all', () => {
    expect(intersectTokens([{ kind: 'class', negated: true, ranges: [[0x0, 0x10ffff]] }], [{ kind: 'any' }])).toBeNull();
  });

  /**
   * Checked against brute force. Over a two-letter alphabet, every path of up
   * to three segments of up to three letters is enumerated and matched against
   * both globs; the intersection must be non-null exactly when some path
   * matches both, and its witness must match both. Seeded, so a failure
   * reproduces.
   */
  it('agrees with brute force over a generated corpus of pattern pairs', () => {
    let seed = 20260924;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const atoms = ['a', 'b', '*', '?', '[ab]', '[!a]'];
    const segment = (): string => {
      if (random(6) === 0) return '**';
      return Array.from({ length: 1 + random(3) }, () => atoms[random(atoms.length)] as string).join('');
    };
    const pattern = (): string => Array.from({ length: 1 + random(3) }, segment).join('/');
    const names: string[] = [];
    for (const length of [1, 2, 3]) {
      const grow = (prefix: string): void => {
        if (prefix.length === length) names.push(prefix);
        else for (const c of ['a', 'b']) grow(prefix + c);
      };
      grow('');
    }
    const paths: string[] = [];
    const build = (prefix: string[], depth: number): void => {
      if (prefix.length > 0) paths.push(prefix.join('/'));
      if (depth === 0) return;
      for (const name of names) build([...prefix, name], depth - 1);
    };
    build([], 3);

    for (let i = 0; i < 150; i += 1) {
      const a = pattern();
      const b = pattern();
      const ga = glob(a);
      const gb = glob(b);
      const common = paths.some((p) => matchGlob(ga, p) && matchGlob(gb, p));
      const witness = intersectGlobs(ga, gb);
      if (witness !== null) {
        expect(matchGlob(ga, witness), `${witness} in ${a}`).toBe(true);
        expect(matchGlob(gb, witness), `${witness} in ${b}`).toBe(true);
      }
      // Brute force only sees short paths, so it can miss an intersection but never invent one.
      if (common) expect(witness, `${a} and ${b}`).not.toBeNull();
    }
  });
});

describe('the base directory', () => {
  it('is the literal prefix, or a literal file path\'s directory', () => {
    expect(globBase(glob('src/auth/*.ts'))).toBe('src/auth');
    expect(globBase(glob('src/auth/login.ts'))).toBe('src/auth');
    expect(globBase(glob('src/auth'))).toBe('src/auth');
    expect(globBase(glob('**/*.ts'))).toBe('');
    expect(globBase(glob('src/**'))).toBe('src');
    expect(globBase(glob('x.ts'))).toBe('');
  });
});
