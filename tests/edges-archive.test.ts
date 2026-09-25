import { describe, expect, it } from 'vitest';

import { openTasks, type Plan, planArchive, planUnarchive } from '../src/archive.js';
import { BANNER_CLOSE, BANNER_OPEN } from '../src/brief.js';
import { parseInline, readFrontMatter, renderScalar } from '../src/frontmatter.js';
import { matchGlob, parseGlob } from '../src/glob.js';
import { config, corpusOf, goodBrief } from './helpers.js';

/** The archival planner's and the parsers' remaining edges, one case each. */

const A = 'briefs/001_a.md';
const TO = 'briefs/archive/001_a.md';
const COMMIT = { sha: 'abcdef1234', author: 'A', date: '' };

function written(plan: Plan, path: string): string {
  const op = plan.ops.find((o) => o.path === path);
  if (op?.kind !== 'write') throw new Error(`no write to ${path}`);
  return op.content;
}

describe('archiving', () => {
  it('says which brief each refusal is about', () => {
    const corpus = corpusOf({ [A]: goodBrief({ status: 'draft' }) });
    expect(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' }).blocking.map((f) => f.brief)).toEqual(['001']);
  });

  it('refuses a deferred brief, whose work has not run', () => {
    const corpus = corpusOf({ [A]: goodBrief({ status: 'deferred', trigger: 'when the second tenant signs' }) });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' });
    expect(plan.blocking.map((f) => [f.rule, f.severity, f.line, f.message, f.hint])).toEqual([
      ['archive-deferred', 'error', 2, 'is deferred, and deferred work has not been executed', 'set "status: active" when its trigger fires and the round runs'],
    ]);
  });

  it('matches a changed file to a literal scope path as itself or as a directory above it', () => {
    const corpus = corpusOf({ [A]: goodBrief({ affectedFiles: '[src, lib/a.ts]', protectedFiles: '[src/db]' }) });
    const changes = ['src/api/x.ts', 'src/db/schema.ts', 'src', 'lib/a.ts', 'lib/b.ts'].map((path) => ({ path, insertions: 1, deletions: 0 }));
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', commit: COMMIT, changes });
    expect(plan.blocking.map((f) => [f.rule, f.path])).toEqual([['protected-file', 'src/db/schema.ts']]);
    expect(plan.warnings.map((f) => [f.rule, f.paths])).toEqual([['out-of-scope', ['lib/b.ts']]]);
  });

  it('points a link a brief holds to itself at its new place, and plans no second write of it', () => {
    const corpus = corpusOf({ [A]: goodBrief({}, '\n[me](001_a.md#top)\n') });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' });
    expect(plan.ops.map((o) => [o.kind, o.path])).toEqual([
      ['write', TO],
      ['remove', A],
    ]);
    expect(written(plan, TO)).toContain('[me](001_a.md#top)');
    const back = planUnarchive(corpusOf({ [TO]: written(plan, TO) }), corpusOf({ [TO]: written(plan, TO) }).briefs[0]!);
    expect(written(back, A)).toContain('[me](001_a.md#top)');
  });

  it('changes only the links to the moving brief in the briefs that point at it', () => {
    const other = goodBrief({}, '\n[a](001_a.md) [c](003_c.md) [up](../README.md)\n');
    const corpus = corpusOf({ [A]: goodBrief(), 'briefs/002_b.md': other, 'briefs/003_c.md': goodBrief() });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' });
    expect(written(plan, 'briefs/002_b.md')).toContain('[a](archive/001_a.md) [c](003_c.md) [up](../README.md)');
  });

  it('refuses under --strict on a warning, and never on a note', () => {
    const corpus = corpusOf({ [A]: goodBrief() });
    const note = { rule: 'glob-matches-nothing', severity: 'note' as const, message: 'm', file: A, line: 1 };
    expect(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', findings: [note], strict: true }).blocking).toEqual([]);
  });

  it('keeps a change in scope when any one of the scope patterns covers it', () => {
    const corpus = corpusOf({ [A]: goodBrief({ affectedFiles: '[src/**, docs/**]' }) });
    const changes = [{ path: 'docs/a.md', insertions: 1, deletions: 0 }];
    expect(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', commit: COMMIT, changes }).warnings).toEqual([]);
  });

  it('writes no diffstat for changes without a commit', () => {
    const corpus = corpusOf({ [A]: goodBrief() });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', changes: [{ path: 'x', insertions: 1, deletions: 0 }] });
    expect(plan.banner.some((l) => l.includes('changed'))).toBe(false);
  });

  it('closes only the boxes of the named sections, wherever they fall in the brief', () => {
    const body = '\n## Notes\n\n- [ ] before\n\n## Deliverables\n\n- [ ] inside\n\n## After\n\n- [ ] after\n';
    const corpus = corpusOf({ [A]: goodBrief({}, body) }, config({ archiving: { tasks: ['Deliverables'] } }));
    expect(openTasks(corpus.briefs[0]!, corpus).map((t) => t.text)).toEqual(['inside']);
  });

  it('puts the banner directly under a front matter with no blank line after it', () => {
    const tight = goodBrief().replace('---\n\n# A brief', '---\n# A brief');
    const corpus = corpusOf({ [A]: tight });
    const out = written(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' }), TO);
    expect(out).toMatch(new RegExp(`---\\n${BANNER_OPEN}\\n`));
    expect(out).toContain(`${BANNER_CLOSE}\n\n# A brief`);
  });

  it('puts the banner at the very top of a file with no front matter, even one starting blank', () => {
    const cfg = config({ status: { field: null }, archiving: { freeze: false } });
    const corpus = corpusOf({ [A]: '\n# T\n' }, cfg);
    const out = written(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' }), TO);
    expect(out.startsWith(`${BANNER_OPEN}\n`)).toBe(true);
    expect(out).toContain(`${BANNER_CLOSE}\n\n\n# T`);
  });

  it('removes a banner and only the blank line after it, keeping text right after one', () => {
    const cfg = config({ status: { field: null }, archiving: { rewriteLinks: false } });
    const corpus = corpusOf({ [TO]: `---\n---\n${BANNER_OPEN}\n> x\n${BANNER_CLOSE}\n# T\n` }, cfg);
    expect(written(planUnarchive(corpus, corpus.briefs[0]!), A)).toBe('---\n---\n# T\n');
  });

  it('plans a reopening with no banner and no changes of its own', () => {
    const corpus = corpusOf({ [TO]: goodBrief({ status: 'archived' }) });
    const plan = planUnarchive(corpus, corpus.briefs[0]!);
    expect(plan.banner).toEqual([]);
    expect(plan.changes).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });
});

describe('the parsers', () => {
  it('reads a key only when nothing but spaces stands between it and the colon', () => {
    const fm = readFrontMatter(['---', 'ab%c: d', 'k \t: v', '---']);
    expect(fm?.problems.map((p) => p.line)).toEqual([1]);
    expect(fm?.entries.map((e) => e.key)).toEqual(['k']);
  });

  it('reads a block item only at the start of its line, and gives a later key its own entry', () => {
    const fm = readFrontMatter(['---', 'k:', '  a - b', 'l:', '  - a', 'next: x - y', '---']);
    expect(fm?.entries.map((e) => [e.key, e.value.kind])).toEqual([
      ['k', 'unsupported'],
      ['l', 'list'],
      ['next', 'scalar'],
    ]);
  });

  it('reads a dash inside a plain value as text, and trims before a comment', () => {
    expect(parseInline('a - b')).toEqual({ kind: 'scalar', scalar: { text: 'a - b', quoted: false } });
    expect(parseInline('a  # c')).toEqual({ kind: 'scalar', scalar: { text: 'a', quoted: false } });
    expect(parseInline('[a:]')).toEqual({ kind: 'unsupported', reason: '"a:" needs quoting inside an inline list' });
    expect(renderScalar('xtrue')).toBe('xtrue');
    expect(renderScalar('truex')).toBe('truex');
  });

  it('carries an error out of a nested brace, and out of a range cut short', () => {
    expect(parseGlob('{a,b}{')).toEqual({ ok: false, error: 'a "{" is never closed' });
    expect(parseGlob('[a-')).toEqual({ ok: false, error: 'a "[" is never closed' });
  });

  it('keeps braces literal inside a negated class that starts with a bracket', () => {
    const parsed = parseGlob('x{a,[^]}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(matchGlob(parsed.glob, 'x}')).toBe(false);
    expect(matchGlob(parsed.glob, 'xb')).toBe(true);
    expect(matchGlob(parsed.glob, 'xa')).toBe(true);
  });

  it('gives a star after a literal no directory beneath it', () => {
    const parsed = parseGlob('src/*');
    expect(parsed.ok && matchGlob(parsed.glob, 'src/a/b')).toBe(false);
  });
});
