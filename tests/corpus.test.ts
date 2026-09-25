import { describe, expect, it } from 'vitest';

import { dependencyCycles, findBriefs, idKey, isReady, pendingDependencies, resolveDependency } from '../src/corpus.js';
import { collisionFindings, collisions } from '../src/collisions.js';
import { config, corpusOf, goodBrief } from './helpers.js';

const archived = (front: Record<string, string> = {}): string => goodBrief({ status: 'archived', ...front });

describe('finding briefs', () => {
  const corpus = corpusOf({
    'briefs/034_a.md': goodBrief(),
    'briefs/archive/012_b.md': archived(),
    'briefs/B-7_c.md': goodBrief(),
  });

  it('by id, numerically for numbers, by file name and by path', () => {
    expect(idKey('034')).toBe('34');
    expect(idKey('B-7')).toBe('B-7');
    expect(findBriefs(corpus, '34').map((b) => b.file)).toEqual(['briefs/034_a.md']);
    expect(findBriefs(corpus, ' 012 ').map((b) => b.file)).toEqual(['briefs/archive/012_b.md']);
    expect(findBriefs(corpus, 'B-7').map((b) => b.file)).toEqual(['briefs/B-7_c.md']);
    expect(findBriefs(corpus, '034_a.md').map((b) => b.file)).toEqual(['briefs/034_a.md']);
    expect(findBriefs(corpus, './briefs\\archive\\012_b.md').map((b) => b.file)).toEqual(['briefs/archive/012_b.md']);
    expect(findBriefs(corpus, 'nothing')).toEqual([]);
  });

  it('resolves a dependency to the live brief when an id is claimed twice', () => {
    const twice = corpusOf({ 'briefs/archive/005_old.md': archived(), 'briefs/005_new.md': goodBrief() });
    expect(resolveDependency(twice, '5')?.file).toBe('briefs/005_new.md');
    expect(resolveDependency(twice, '6')).toBeUndefined();
  });
});

describe('readiness', () => {
  const corpus = corpusOf({
    'briefs/001_a.md': goodBrief({ dependsOn: '[002, 003]' }),
    'briefs/archive/002_b.md': archived(),
    'briefs/003_c.md': goodBrief(),
    'briefs/004_d.md': goodBrief({ dependsOn: '[002]' }),
    'briefs/005_e.md': goodBrief({ status: 'draft' }),
    'briefs/006_f.md': goodBrief({ dependsOn: '[999]' }),
  });
  const get = (id: string) => findBriefs(corpus, id)[0]!;

  it('waits on live dependencies and not on archived ones', () => {
    expect(pendingDependencies(corpus, get('001'))).toEqual(['003']);
    expect(pendingDependencies(corpus, get('004'))).toEqual([]);
    expect(pendingDependencies(corpus, get('006'))).toEqual([]);
  });

  it('is ready when every dependency is archived, never for a draft, an archived brief or an unknown dependency', () => {
    expect(isReady(corpus, get('001'))).toBe(false);
    expect(isReady(corpus, get('003'))).toBe(true);
    expect(isReady(corpus, get('004'))).toBe(true);
    expect(isReady(corpus, get('005'))).toBe(false);
    expect(isReady(corpus, get('002'))).toBe(false);
    expect(isReady(corpus, get('006'))).toBe(false);
  });
});

describe('cycles', () => {
  it('finds each strongly connected component once, as a shortest path from its first brief', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ dependsOn: '[002]' }),
      'briefs/002_b.md': goodBrief({ dependsOn: '[001, 003]' }),
      'briefs/003_c.md': goodBrief({ dependsOn: '[001]' }),
      'briefs/004_d.md': goodBrief({ dependsOn: '[005]' }),
      'briefs/005_e.md': goodBrief({ dependsOn: '[004]' }),
      'briefs/006_f.md': goodBrief({ dependsOn: '[006]' }),
    });
    expect(dependencyCycles(corpus).map((c) => c.map((b) => b.id))).toEqual([
      ['001', '002', '001'],
      ['004', '005', '004'],
    ]);
  });

  it('starts from the first brief by path whatever order the search visits them in', () => {
    const corpus = corpusOf({
      'briefs/009_z.md': goodBrief({ dependsOn: '[003]' }),
      'briefs/003_a.md': goodBrief({ dependsOn: '[007]' }),
      'briefs/007_m.md': goodBrief({ dependsOn: '[009]' }),
    });
    expect(dependencyCycles(corpus).map((c) => c.map((b) => b.id))).toEqual([['003', '007', '009', '003']]);
  });
});

describe('the collision matrix', () => {
  const corpus = corpusOf({
    'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/auth/**]' }),
    'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["src/**/session.ts", src/api/users.ts]' }),
    'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[src/api/orders.ts]' }),
    'briefs/004_d.md': goodBrief({ wave: '1' }),
    'briefs/005_e.md': goodBrief({ wave: '2', affectedFiles: '[src/auth/**]' }),
    'briefs/006_f.md': goodBrief({ affectedFiles: '[src/auth/**]' }),
    'briefs/archive/007_g.md': archived({ wave: '1', affectedFiles: '[src/auth/**]' }),
  });

  it('compares live briefs wave by wave and names a file both scopes cover', () => {
    const report = collisions(corpus);
    expect(report.waves.map((w) => [w.wave, w.briefs.map((b) => b.id)])).toEqual([
      [1, ['001', '002', '003', '004']],
      [2, ['005']],
    ]);
    const wave1 = report.waves[0]!;
    expect(wave1.collisions.map((c) => [c.a.id, c.b.id, c.overlaps])).toEqual([
      ['001', '002', [{ patterns: ['src/auth/**', 'src/**/session.ts'], witness: 'src/auth/session.ts' }]],
    ]);
    expect(wave1.shared.map((s) => [s.a.id, s.b.id, s.directories])).toEqual([['002', '003', ['src/api']]]);
    expect(wave1.unscoped.map((b) => b.id)).toEqual(['004']);
    expect(report.waves[1]?.unscoped).toEqual([]);
    expect(report.unscheduled.map((b) => b.id)).toEqual(['006']);
  });

  it('skips patterns that do not parse', () => {
    const bad = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '["/abs", src/**]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[src/x]' }),
    });
    expect(collisions(bad).waves[0]?.collisions.flatMap((c) => c.overlaps.map((o) => o.patterns))).toEqual([['src/**', 'src/x']]);
  });

  it('compares across waves when asked', () => {
    const report = collisions(corpus, { all: true });
    expect(report.waves).toHaveLength(1);
    expect(report.waves[0]?.wave).toBeNull();
    expect(report.unscheduled).toEqual([]);
    const pairs = report.waves[0]!.collisions.map((c) => `${c.a.id}-${c.b.id}`);
    expect(pairs).toEqual(['001-002', '001-005', '001-006', '002-005', '002-006', '005-006']);
  });

  it('reports collisions as errors, unscoped briefs as notes, and shared directories only when switched on', () => {
    const found = collisionFindings(corpus, collisions(corpus));
    expect(found.map((f) => [f.rule, f.severity, f.file, f.line])).toEqual([
      ['collision', 'error', 'briefs/002_b.md', 4],
      ['unscoped', 'note', 'briefs/004_d.md', 1],
    ]);
    expect(found[0]?.message).toBe('"src/**/session.ts" overlaps 001\'s "src/auth/**" in wave 1; both cover src/auth/session.ts');
    expect(found[1]?.message).toBe('declares no affectedFiles, so it cannot be checked against the 3 other brief(s) in wave 1');

    const loud = corpusOf(
      Object.fromEntries(corpus.briefs.map((b) => [b.file, b.source])),
      config({ rules: { 'shared-directory': 'warning', unscoped: 'off', collision: 'warning' } }),
    );
    const again = collisionFindings(loud, collisions(loud));
    expect(again.map((f) => [f.rule, f.severity])).toEqual([
      ['collision', 'warning'],
      ['shared-directory', 'warning'],
    ]);
    expect(again[1]?.message).toBe('writes into src/api/, as 002 does in wave 1');
    const everything = collisionFindings(loud, collisions(loud, { all: true }));
    expect(everything[0]?.message).toContain('among the live briefs');
  });
});
