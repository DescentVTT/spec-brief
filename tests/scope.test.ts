import { describe, expect, it } from 'vitest';

import { type Glob, matchGlob, parseGlob, readingIn } from '../src/glob.js';
import { contradictions, meet, patternsOf, type Scope, scopeOf } from '../src/scope.js';
import { brief, goodBrief } from './helpers.js';

/**
 * A brief writes its affectedFiles less its protectedFiles, and two briefs
 * collide where those meet. Checked here against brute force: every path of a
 * small alphabet, matched pattern by pattern, decides what the witness search
 * must find.
 */

const file = readingIn(null);

function scope(affected: readonly string[], protectedFiles: readonly string[] = []): Scope {
  const text = goodBrief({ affectedFiles: JSON.stringify(affected), protectedFiles: JSON.stringify(protectedFiles) });
  return scopeOf(brief(text), file);
}

describe('a scope', () => {
  it('keeps the patterns that parse, in order, and leaves the rest to the glob rule', () => {
    expect(patternsOf(['src/**', '/abs', 'a{', 'docs/*.md'], file).map((p) => p.pattern)).toEqual(['src/**', 'docs/*.md']);
    const s = scope(['src/**'], ['src/db.ts', '!x']);
    expect(s.affected.map((p) => p.pattern)).toEqual(['src/**']);
    expect(s.protected.map((p) => p.pattern)).toEqual(['src/db.ts']);
  });

  it('reads its literals the way it is told', () => {
    const tree = readingIn(['build/out.js']);
    const s = scopeOf(brief(goodBrief({ affectedFiles: '[build]' })), tree);
    expect(s.affected[0]?.glob.literals).toEqual([{ path: 'build', reading: 'directory' }]);
  });
});

describe('two scopes meeting', () => {
  it('meet where both may write, every pair of patterns listed', () => {
    const meeting = meet(scope(['src/**', 'docs/*.md']), scope(['src/a/*.ts', 'docs/x.md', 'lib/**']));
    expect(meeting).toEqual({
      overlaps: [
        { patterns: ['src/**', 'src/a/*.ts'], witness: 'src/a/.ts' },
        { patterns: ['docs/*.md', 'docs/x.md'], witness: 'docs/x.md' },
      ],
      undecided: [],
    });
  });

  it('do not meet on a file either one protects', () => {
    const schema = ['src/db/schema.ts'];
    expect(meet(scope(['src/db/schema.ts']), scope(['src/db/*.ts'], schema)).overlaps).toEqual([]);
    expect(meet(scope(['src/db/schema.ts'], schema), scope(['src/db/*.ts'])).overlaps).toEqual([]);
    // What the protection leaves is still shared.
    expect(meet(scope(['src/db/**'], schema), scope(['src/db/*.ts'])).overlaps.map((o) => o.witness)).toEqual(['src/db/.ts']);
  });

  it('say which pairs the search could not decide', () => {
    expect(meet(scope(['src/**']), scope(['**/*.ts']), 1)).toEqual({ overlaps: [], undecided: [['src/**', '**/*.ts']] });
  });

  it('agree with brute force over a generated corpus of scopes', () => {
    let seed = 20260926;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const atoms = ['a', 'b', '*', '?', '[ab]'];
    const segment = (): string => (random(5) === 0 ? '**' : Array.from({ length: 1 + random(2) }, () => atoms[random(atoms.length)] as string).join(''));
    const pattern = (): string => Array.from({ length: 1 + random(3) }, segment).join('/');
    const patterns = (most: number): string[] => Array.from({ length: random(most + 1) }, pattern);
    const names = ['a', 'b', 'aa', 'ab', 'ba', 'bb'];
    const paths: string[] = [];
    const build = (prefix: string[], depth: number): void => {
      if (prefix.length > 0) paths.push(prefix.join('/'));
      if (depth > 0) for (const name of names) build([...prefix, name], depth - 1);
    };
    build([], 3);
    const any = (globs: readonly Glob[], path: string): boolean => globs.some((g) => matchGlob(g, path));
    const globs = (list: readonly string[]): Glob[] =>
      list.map((p) => {
        const parsed = parseGlob(p);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.glob;
      });

    const seen = { met: 0, apart: 0, covered: 0 };
    for (let i = 0; i < 120; i += 1) {
      const a = { affected: [pattern()], protected: patterns(2) };
      const b = { affected: [pattern()], protected: patterns(1) };
      const meeting = meet(scope(a.affected, a.protected), scope(b.affected, b.protected));
      const avoid = globs([...a.protected, ...b.protected]);
      const [x, y] = [globs(a.affected)[0] as Glob, globs(b.affected)[0] as Glob];
      const label = `${a.affected[0]} less ${a.protected.join(',')} / ${b.affected[0]} less ${b.protected.join(',')}`;
      expect(meeting.undecided, label).toEqual([]);
      for (const { witness } of meeting.overlaps) {
        expect(matchGlob(x, witness) && matchGlob(y, witness) && !any(avoid, witness), `${label}: ${witness}`).toBe(true);
      }
      // Brute force sees only short paths: it can miss a meeting, never invent one.
      if (paths.some((p) => matchGlob(x, p) && matchGlob(y, p) && !any(avoid, p))) expect(meeting.overlaps, label).toHaveLength(1);

      const own = scope(a.affected, a.protected);
      const covered = contradictions(own).covered.length > 0;
      const writable = paths.some((p) => matchGlob(x, p) && !any(globs(a.protected), p));
      if (writable) expect(covered, `${label}: writable, so not covered`).toBe(false);
      seen.met += meeting.overlaps.length;
      seen.apart += 1 - meeting.overlaps.length;
      seen.covered += covered ? 1 : 0;
    }
    // The corpus reaches every answer, not only the easy one.
    expect(seen).toEqual({ met: 59, apart: 61, covered: 29 });
  });
});

describe('a scope against its own protections', () => {
  it('names every affected pattern the protections cover, alone or together', () => {
    const s = scope(['src/db/**', 'src/**', 'docs/{a,b}.md', 'lib/x.ts'], ['src/db/**', 'docs/a.md', 'docs/b.md']);
    expect(contradictions(s)).toEqual({ covered: ['src/db/**', 'docs/{a,b}.md'], undecided: [] });
  });

  it('has nothing to say about a scope that protects nothing', () => {
    expect(contradictions(scope(['src/**']))).toEqual({ covered: [], undecided: [] });
    expect(contradictions(scope(['src/**'], ['**']), 1)).toEqual({ covered: [], undecided: ['src/**'] });
  });
});
