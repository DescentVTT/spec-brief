import { describe, expect, it } from 'vitest';

import { applyWaivers, type Plan, planArchive, WAIVABLE } from '../src/archive.js';
import { findingJson } from '../src/report.js';
import type { Finding } from '../src/types.js';
import { corpusOf, goodBrief } from './helpers.js';

/**
 * A plugin may lift two refusals of an archival - a protected file changed, a
 * file changed outside the scope - by rule and path, where its own check
 * allows them. spec-brief never learns how the check works.
 */

const A = 'briefs/001_a.md';
const COMMIT = { sha: 'abcdef1234', author: 'A', date: '' };

const table = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `${f.line} ${f.severity} ${f.rule}: ${f.message}${f.hint === undefined ? '' : ` | ${f.hint}`}`);

function refused(strict = false): Plan {
  const corpus = corpusOf({ [A]: goodBrief({ affectedFiles: '[src/ok.ts]', protectedFiles: '[src/a.ts, src/b.ts]' }) });
  const changes = ['src/a.ts', 'src/b.ts', 'lib/x.ts', 'lib/y.ts'].map((path) => ({ path, insertions: 1, deletions: 0 }));
  return planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-26', commit: COMMIT, changes, strict });
}

describe('the refusals a plugin can see', () => {
  it('name each protected file on a finding of its own, and every file outside the scope on one', () => {
    const plan = refused(true);
    expect(plan.blocking.map((f) => [f.rule, f.path, f.paths])).toEqual([
      ['protected-file', 'src/a.ts', undefined],
      ['protected-file', 'src/b.ts', undefined],
      ['out-of-scope', undefined, ['lib/x.ts', 'lib/y.ts']],
    ]);
    expect(findingJson(plan.blocking[0]!)).toMatchObject({ rule: 'protected-file', path: 'src/a.ts' });
    expect(findingJson(plan.blocking[2]!)).toMatchObject({ rule: 'out-of-scope', paths: ['lib/x.ts', 'lib/y.ts'] });
    expect('paths' in findingJson(plan.blocking[0]!)).toBe(false);
    expect(WAIVABLE).toEqual(['protected-file', 'out-of-scope']);
  });
});

describe('a waiver', () => {
  it('turns the refusal it matches into a note naming the plugin, the rule, the path and the reason', () => {
    const plan = applyWaivers(refused(), [{ plugin: 'harness', waiver: { rule: 'protected-file', path: 'src/a.ts', reason: 'ruling R1, signed by alice, allows it' } }]);
    expect(table(plan.blocking)).toEqual([
      '4 error protected-file: the round changed src/b.ts, which this brief protects | revert the change, or record the departure in the brief before archiving it',
    ]);
    expect(table(plan.warnings)).toEqual([
      '3 warning out-of-scope: the round changed 2 file(s) outside affectedFiles: lib/x.ts, lib/y.ts | widen affectedFiles if the scope was wrong, or say why in the summary',
      '4 note waived: harness waives protected-file for src/a.ts: ruling R1, signed by alice, allows it | review the waiver with the round; it stands where the refusal was',
    ]);
    expect(plan.warnings[1]).toMatchObject({ file: A, brief: '001', path: 'src/a.ts' });
  });

  it('matches by path, not by rule alone', () => {
    const plan = applyWaivers(refused(), [{ plugin: 'p', waiver: { rule: 'protected-file', path: 'src/b.ts', reason: 'r' } }]);
    expect(plan.blocking.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(plan.warnings.map((f) => f.path)).toEqual([undefined, 'src/b.ts']);
  });

  it('takes one path at a time out of a refusal that names several, and the refusal with the last', () => {
    const waive = (path: string) => ({ plugin: 'p', waiver: { rule: 'out-of-scope', path, reason: 'r' } });
    const one = applyWaivers(refused(true), [waive('lib/y.ts')], true);
    expect(one.blocking.map((f) => [f.rule, f.severity, f.message, f.paths])).toEqual([
      ['protected-file', 'error', 'the round changed src/a.ts, which this brief protects', undefined],
      ['protected-file', 'error', 'the round changed src/b.ts, which this brief protects', undefined],
      ['out-of-scope', 'error', 'the round changed 1 file(s) outside affectedFiles: lib/x.ts', ['lib/x.ts']],
    ]);
    const both = applyWaivers(refused(true), [waive('lib/y.ts'), waive('lib/x.ts')], true);
    expect(both.blocking.map((f) => f.rule)).toEqual(['protected-file', 'protected-file']);
    expect(both.warnings.map((f) => [f.rule, f.line, f.path])).toEqual([
      ['waived', 3, 'lib/y.ts'],
      ['waived', 3, 'lib/x.ts'],
    ]);
  });

  it('that matches nothing changes nothing, and a plan with every refusal waived may proceed', () => {
    const plan = refused();
    expect(applyWaivers(plan, [{ plugin: 'p', waiver: { rule: 'protected-file', path: 'src/c.ts', reason: 'r' } }])).toEqual(plan);
    // A warning is not a refusal: out-of-scope without --strict is left alone.
    expect(applyWaivers(plan, [{ plugin: 'p', waiver: { rule: 'out-of-scope', path: 'lib/x.ts', reason: 'r' } }])).toEqual(plan);
    const all = applyWaivers(plan, ['src/a.ts', 'src/b.ts'].map((path) => ({ plugin: 'p', waiver: { rule: 'protected-file', path, reason: 'r' } })));
    expect(all.blocking).toEqual([]);
  });

  it('for any other rule is ignored with a warning, which refuses under --strict', () => {
    const corpus = corpusOf({ [A]: goodBrief({ status: 'draft' }) });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-26' });
    const asked = [{ plugin: 'p', waiver: { rule: 'archive-draft', path: A, reason: 'r' } }];
    const lenient = applyWaivers(plan, asked);
    expect(lenient.blocking.map((f) => f.rule)).toEqual(['archive-draft']);
    expect(table(lenient.warnings)).toEqual([
      '1 warning waiver-ignored: p asked to waive archive-draft for briefs/001_a.md; a plugin may waive only protected-file and out-of-scope | report it to the plugin\'s authors: archive-draft is spec-brief\'s to decide',
    ]);
    const strict = applyWaivers(plan, asked, true);
    expect(strict.blocking.map((f) => [f.rule, f.severity])).toEqual([
      ['archive-draft', 'error'],
      ['waiver-ignored', 'error'],
    ]);
    expect(strict.warnings).toEqual([]);
  });
});
