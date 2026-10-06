import { describe, expect, it } from 'vitest';

import { planArchive, planUnarchive } from '../src/archive.js';
import { BANNER_CLOSE, BANNER_OPEN } from '../src/brief.js';
import { collisions } from '../src/collisions.js';
import { rewriteLinks } from '../src/links.js';
import { sortFindings } from '../src/lint.js';
import { scan } from '../src/markdown.js';
import { prettyMatrix, prettyPlan } from '../src/report.js';
import { renderNewBrief } from '../src/scaffold.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';

/** Edges each worth one assertion, kept apart so the main suites read as behaviour. */
describe('edges', () => {
  it('reports a front-matter value it cannot read for a field it reads, and reads an empty list as none', () => {
    const b = brief('---\nstatus: {a: 1}\ndependsOn:\naffectedFiles: {a: 1}\n---\n');
    expect(b.problems.map((p) => p.message)).toEqual(['"status" inline mappings are not supported', '"affectedFiles" inline mappings are not supported']);
    expect(b.dependsOn).toEqual([]);
    // A list it cannot read scopes nothing, as an absent one does.
    expect(b.affectedFiles).toEqual([]);
  });

  it('takes ".md" off the end of a file name, and leaves one inside it', () => {
    expect(brief(goodBrief(), 'briefs/005.mdx_notes.md').id).toBe('005.mdx');
  });

  it('ignores a banner opened and never closed', () => {
    expect(brief(`---\nstatus: active\n---\n${BANNER_OPEN}\n> half\n`).banner).toBeNull();
  });

  it('ignores a banner closed and never opened, and markers written inside the front matter', () => {
    expect(brief(`---\nstatus: active\n---\n> half\n${BANNER_CLOSE}\n`).banner).toBeNull();
    expect(brief(`---\n${BANNER_OPEN}\n${BANNER_CLOSE}\nstatus: active\n---\n# T\n`).banner).toBeNull();
    // The body starts under the closing line: a marker on the block's last line opens nothing.
    expect(brief(`---\nstatus: active\n${BANNER_OPEN}\n---\n> x\n${BANNER_CLOSE}\n`).banner).toBeNull();
  });

  it('reads a whole number as a wave, and the same digits in quotes as text that is not one', () => {
    expect(brief('---\nwave: 3\n---\n').wave).toBe(3);
    const quoted = brief('---\nwave: "3"\n---\n');
    expect(quoted.wave).toBeNull();
    expect(quoted.problems).toEqual([{ field: 'wave', line: 1, message: '"wave" must be a whole number, not "3"' }]);
  });

  it('reads a banner from its opening marker to the first closing one after it', () => {
    expect(brief(`${BANNER_CLOSE}\n${BANNER_OPEN}\n> x\n${BANNER_CLOSE}\n${BANNER_CLOSE}\n`).banner).toEqual({ start: 1, end: 4 });
  });

  it('leaves a destination that is only a query alone', () => {
    const result = rewriteLinks(scan(['[q](?x=1) [r](r.md)']), 'a', 'a/b', (p) => p);
    expect(result.lines).toEqual(['[q](?x=1) [r](../r.md)']);
  });

  it('keeps identical findings in a stable order', () => {
    const f = { rule: 'r', severity: 'error' as const, message: 'm', file: 'a', line: 1 };
    expect(sortFindings([f, { ...f }])).toHaveLength(2);
  });

  it('fills a template without a type or a wave, and with no draft word', () => {
    const text = renderNewBrief(config({ status: { draft: null, active: 'proposed' } }), { id: '1', title: 'T', date: '2026-09-24' }, '{type}|{wave}|{status}');
    expect(text).toBe('||proposed');
  });

  it('gives a new brief with no type the sections of no type, one named "undefined" included', () => {
    const cfg = config({ types: { undefined: { sections: ['Never'] } } });
    expect(renderNewBrief(cfg, { id: '1', title: 'T', date: '2026-09-24' }, null)).not.toContain('## Never');
    expect(renderNewBrief(cfg, { id: '1', title: 'T', date: '2026-09-24', type: 'undefined' }, null)).toContain('\n## Never\n');
  });

  it('labels a brief with no id by its file name in the matrix', () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    const corpus = corpusOf({ 'briefs/x.md': goodBrief({ wave: '1', affectedFiles: '[a]' }), 'briefs/y.md': goodBrief({ wave: '1', affectedFiles: '[a]' }) }, cfg);
    expect(prettyMatrix(collisions(corpus), { color: false })).toContain('X x.md "a" and y.md "a" both cover a');
  });

  it('prints warnings beside a refusal', () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief({ status: 'draft', affectedFiles: '[src/ok.ts]' }) });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', commit: { sha: 'abcdef1', author: 'A', date: '' }, changes: [{ path: 'lib/x', insertions: 1, deletions: 0 }] });
    const text = prettyPlan(plan, false, { color: false });
    expect(text).toContain('cannot archive briefs/001_a.md:');
    expect(text).toContain('archive-draft');
    expect(text).toContain('out-of-scope');
  });

  it('writes a banner for a brief with no id and no title', () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md', archiving: { banner: ['[{id}|{title}] {date}', 'kept {date}'] } });
    const corpus = corpusOf({ 'briefs/x.md': '---\nstatus: active\n---\n' }, cfg);
    expect(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' }).banner).toEqual([BANNER_OPEN, '> kept 2026-09-24', expect.any(String)]);
  });

  it('reopens without touching links when told not to rewrite them', () => {
    const cfg = config({ archiving: { rewriteLinks: false } });
    const corpus = corpusOf({ 'briefs/archive/001_a.md': '---\nstatus: archived\n---\n[x](../../y.md)\n' }, cfg);
    const plan = planUnarchive(corpus, corpus.briefs[0]!);
    const op = plan.ops[0];
    expect(op?.kind === 'write' ? op.content : '').toBe('---\nstatus: active\n---\n[x](../../y.md)\n');
    expect(plan.linksRewritten).toBe(0);
  });

});
