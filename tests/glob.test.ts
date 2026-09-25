import { describe, expect, it } from 'vitest';

import {
  type Glob,
  globBase,
  globBases,
  globCovers,
  globWitness,
  hasExtension,
  held,
  intersectGlobs,
  type LiteralReading,
  matchGlob,
  parseGlob,
  readingIn,
  treeOf,
} from '../src/glob.js';

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

describe('parsing', () => {
  it("refuses a leading slash and a negation with spec-brief's own reasons, before the core reads them", () => {
    expect(error('!src/**')).toBe('negated patterns are not supported; narrow the positive pattern');
    expect(error('  !src/**')).toBe('negated patterns are not supported; narrow the positive pattern');
    expect(error('/src')).toBe('a pattern is relative to the repository root and cannot start with "/"');
    expect(error(' /src')).toBe('a pattern is relative to the repository root and cannot start with "/"');
    // Not at the start, a "!" is a character like any other.
    expect(matches('a!b', 'a!b')).toBe(true);
  });

  it("refuses what the core refuses, in the core's words", () => {
    expect(error('')).toBe('the pattern is empty');
    expect(error('   ')).toBe('the pattern is empty');
    expect(error('src\\auth')).toBe('"\\" escapes glob syntax; separate directories with "/"');
    expect(error('src/+(a|b)')).toBe('extended globs such as "+(a|b)" are not supported');
    expect(error('../x')).toBe('a pattern cannot climb out of its root with ".."');
    expect(error('.')).toBe('the pattern names no path');
    expect(error('./')).toBe('the pattern names the root itself, not a path under it');
    expect(error('a{b')).toBe('a "{" is never closed');
    expect(error('a[b')).toBe('a "[" is never closed');
    expect(error('[z-a]')).toBe('the range "z-a" runs backwards');
    expect(error('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}')).toBe('the braces expand to more than 256 patterns');
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

  it('keeps the source as written and records nothing literal about a pattern with glob syntax', () => {
    const g = glob(' src/*.ts ');
    expect(g.source).toBe(' src/*.ts ');
    expect(g.literals).toEqual([]);
  });
});

describe('a literal path', () => {
  it('is a file unless something says otherwise', () => {
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
