import { describe, expect, it } from 'vitest';

import { planArchive, planUnarchive } from '../src/archive.js';
import { brief as parse } from './helpers.js';
import { collisions } from '../src/collisions.js';
import { lint } from '../src/lint.js';
import { scan } from '../src/markdown.js';
import { briefJson, findingJson, FORMATS, planJson, prettyList, prettyMatrix, prettyPlan, sarif } from '../src/report.js';
import type { Finding } from '../src/types.js';
import { config, corpusOf, goodBrief } from './helpers.js';

/** Output asserted whole, and the last edges of the rules and the scanner. */

const esc = String.fromCharCode(27);
const on = { color: true };
const off = { color: false };
const table = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `${f.line} ${f.rule}: ${f.message}${f.hint === undefined ? '' : ` | ${f.hint}`}`);

describe('reports', () => {
  it('offers the four formats', () => {
    expect(FORMATS).toEqual(['pretty', 'json', 'sarif', 'github']);
  });

  it('writes a finding as JSON with only the fields it has', () => {
    expect(Object.keys(findingJson({ rule: 'r', severity: 'note', message: 'm', file: 'f', line: 2 }))).toEqual(['rule', 'severity', 'file', 'line', 'message']);
    expect(findingJson({ rule: 'r', severity: 'note', message: 'm', file: 'f', line: 2, brief: 'b', hint: 'h' })).toEqual({
      rule: 'r',
      severity: 'note',
      file: 'f',
      line: 2,
      message: 'm',
      brief: 'b',
      hint: 'h',
    });
  });

  it('writes SARIF with its header, a level per severity, and hints only where there are some', () => {
    const doc = JSON.parse(
      sarif(
        [
          { rule: 'title', severity: 'warning', message: 'm', file: 'a', line: 1 },
          { rule: 'id', severity: 'error', message: 'n', file: 'a', line: 2, hint: 'h' },
          { rule: 'shared-directory', severity: 'note', message: 'o', file: 'a', line: 3 },
        ],
        '9.9.9',
      ),
    ) as { $schema: string; runs: { tool: { driver: Record<string, unknown> }; results: { level: string; message: { text: string } }[] }[] };
    expect(doc.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(doc.runs[0]?.tool.driver).toEqual({
      name: 'spec-brief',
      version: '9.9.9',
      informationUri: 'https://github.com/DescentVTT/spec-brief',
      rules: [
        { id: 'id', shortDescription: { text: 'Every brief has an id with no whitespace or slashes in it.' }, defaultConfiguration: { level: 'error' } },
        { id: 'shared-directory', shortDescription: { text: 'Briefs in one wave do not write into the same directory.' } },
        { id: 'title', shortDescription: { text: 'A brief has a title: a "title" field or a level-one heading.' }, defaultConfiguration: { level: 'warning' } },
      ],
    });
    expect(doc.runs[0]?.results.map((r) => [r.level, r.message.text])).toEqual([
      ['warning', 'm'],
      ['error', 'n. h'],
      ['note', 'o'],
    ]);
  });

  it('describes a brief as JSON, counting only the ticked boxes as checked', () => {
    const b = parse('---\nstatus: active\n---\n# T\n- [x] a\n- [ ] b\n- [X] c\n');
    expect(briefJson(b).tasks).toEqual({ total: 3, checked: 2 });
  });

  it('lists by status word where the status is unknown, and pads every column but the last', () => {
    const odd = parse('---\nstatus: weird\n---\n# A title\n');
    const plain = parse('---\nstatus: active\n---\n# B\n', 'briefs/002_b.md');
    expect(
      prettyList(
        [
          { brief: odd, ready: false, waitingOn: [] },
          { brief: plain, ready: false, waitingOn: ['9', '8'] },
        ],
        off,
      ).split('\n'),
    ).toEqual(['ID   STATUS  WAVE  TASKS  READY       TITLE', '001  weird   -     0/0    no          A title', '002  active  -     0/0    after 9, 8  B']);
    const unknown = corpusOf({ 'briefs/x.md': '# T\n' }, config({ id: { source: 'frontmatter' }, files: '*.md' })).briefs[0]!;
    expect(prettyList([{ brief: unknown, ready: false, waitingOn: [] }], off).split('\n')[1]).toBe('?   ?       -     0/0    no     T');
  });

  it('paints the matrix title, marks and lines in their colours', () => {
    const corpus = corpusOf(
      {
        'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[x/a.ts]' }),
        'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[x/a.ts]' }),
        'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[x/b.ts]' }),
        'briefs/004_d.md': goodBrief({ wave: '1' }),
        'briefs/005_e.md': goodBrief(),
      },
      config({ rules: { 'shared-directory': 'note' } }),
    );
    const text = prettyMatrix(collisions(corpus), on);
    const paint = (code: number, reset: number, t: string): string => `${esc}[${code}m${t}${esc}[${reset}m`;
    expect(text).toContain(paint(1, 22, 'wave 1 \u00b7 4 briefs'));
    expect(text).toContain(`  ${paint(31, 39, 'X')} 001 "x/a.ts" and 002 "x/a.ts" both cover x/a.ts`);
    expect(text).toContain(`  ${paint(33, 39, '~')} 001 and 003 both write into x/`);
    expect(text).toContain(`  ${paint(36, 39, '?')} 004 declares no affectedFiles and cannot be checked`);
    expect(text).toContain(paint(2, 22, 'no wave: 005'));
    expect(text.split('\n')[2]).toBe(`  001    \u00b7    ${paint(31, 39, 'X')}    ${paint(33, 39, '~')}    \u00b7`);
  });

  it('writes every line of a plan, in colour, dry and real', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**]' }, '\n[x](x.md)\n'),
      'briefs/002_b.md': goodBrief({}, '\n[a](001_a.md)\n'),
      'briefs/archive/000_z.md': goodBrief({ status: 'archived' }, '\n[a](../001_a.md)\n'),
    });
    const plan = planArchive(corpus, corpus.live[0]!, {
      date: '2026-09-24',
      commit: { sha: 'abcdef1234', author: 'A', date: '' },
      changes: [
        { path: 'src/a.ts', insertions: 1, deletions: 0 },
        { path: 'lib/b.ts', insertions: 1, deletions: 0 },
      ],
    });
    const dim = (t: string): string => `${esc}[2m${t}${esc}[22m`;
    const real = prettyPlan(plan, false, on).split('\n');
    expect(real.slice(0, 5)).toEqual([
      'moved briefs/001_a.md -> briefs/archive/001_a.md',
      '  1 relative link rewritten',
      '  briefs/002_b.md: links to it rewritten',
      '  briefs/archive/000_z.md:19: links to the old path, and is frozen, so it was left as it is',
      '  the round changed 2 files',
    ]);
    expect(real[5]).toBe('');
    expect(real.at(-2)).toBe('');
    expect(real.at(-1)).toBe(dim('nothing was committed; review the change and commit it with the round'));
    expect(real.join('\n')).toContain('out-of-scope');
    expect(real.join('\n')).not.toContain('banner:');
    const dry = prettyPlan(plan, true, on).split('\n');
    expect(dry[0]).toBe('would move briefs/001_a.md -> briefs/archive/001_a.md');
    expect(dry).toContain(dim('banner:'));
    expect(dry.at(-1)).toBe('  <!-- /spec-brief:banner -->');
    const refused = planArchive(corpusOf({ 'briefs/001_a.md': goodBrief({ status: 'draft', affectedFiles: '[x]' }) }), corpusOf({ 'briefs/001_a.md': goodBrief({ status: 'draft', affectedFiles: '[x]' }) }).briefs[0]!, {
      date: '2026-09-24',
      commit: { sha: 'a', author: '', date: '' },
      changes: [{ path: 'y', insertions: 0, deletions: 0 }],
    });
    const text = prettyPlan(refused, false, on).split('\n');
    expect(text[0]).toBe(`${esc}[31mcannot archive briefs/001_a.md:${esc}[39m`);
    expect(text).toContain('');
    expect(text.join('\n')).toContain('out-of-scope');
    expect(text.join('\n')).not.toContain('nothing was committed');
    const archived = corpusOf({ 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }) });
    expect(prettyPlan(planArchive(archived, archived.briefs[0]!, { date: '2026-09-24' }), false, off)).toBe('briefs/archive/001_a.md is already archived; nothing to do');
  });

  it('prints a plan with nothing to add as its move alone, and writes no banner for an empty template', () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief() }, config({ archiving: { banner: [] } }));
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' });
    expect(prettyPlan(plan, true, off)).toBe('would move briefs/001_a.md -> briefs/archive/001_a.md');
    const op = plan.ops[0];
    expect(op?.kind === 'write' ? op.content : '').not.toContain('spec-brief:banner');
  });

  it('writes a plan as JSON, refused or not', () => {
    const corpus = corpusOf({ 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }), 'briefs/001_a.md': goodBrief() });
    const refused = planJson(planUnarchive(corpus, corpus.archived[0]!));
    expect(refused).toEqual(
      expect.objectContaining({ action: 'unarchive', brief: '001', from: 'briefs/archive/001_a.md', to: 'briefs/001_a.md', done: false, refused: true }),
    );
    expect(planJson(planUnarchive(corpus, corpus.live[0]!))).toEqual(expect.objectContaining({ refused: false, done: true, operations: [] }));
  });
});

describe('rules at their edges', () => {
  const A = 'briefs/001_a.md';

  it('reads a placeholder after a numbered or boxed marker, and not after a word', async () => {
    const cases: [string, boolean][] = [
      ['10. TBD', true],
      ['- [ ]TBD', true],
      ['- [ ]', true],
      ['foo- TBD', false],
      ['TBD\nsomething real', false],
    ];
    for (const [text, expected] of cases) {
      const found = await lint(corpusOf({ [A]: goodBrief().replace('The tree is better.', text) }));
      expect(found.some((f) => f.rule === 'placeholder'), text).toBe(expected);
    }
  });

  it('asks the tree whether a scope literal names a directory', async () => {
    const files = { [A]: goodBrief({ affectedFiles: '[build]', protectedFiles: '["build/**"]' }) };
    // Unknown, or a file: the literal is that file, which the protection does not cover.
    expect((await lint(corpusOf(files), { repoFiles: null })).map((f) => f.rule)).toEqual([]);
    expect((await lint(corpusOf(files), { repoFiles: ['build'] })).map((f) => f.rule)).toEqual(['glob-matches-nothing']);
    // A directory: everything beneath it, all of which is protected.
    expect((await lint(corpusOf(files), { repoFiles: ['build/a'] })).map((f) => f.rule)).toEqual(['scope-contradiction']);
  });

  it('reads a brief with no front matter at all', async () => {
    const cfg = config({ status: { field: null } });
    expect(await lint(corpusOf({ [A]: '# T\n\n## Intent\n\nx\n\n## Negative Scope\n\nx\n\n## Invariants\n\n- [x] y\n' }, cfg))).toEqual([]);
  });

  it('names only the status words the repository uses', async () => {
    const cfg = config({ status: { draft: null, active: 'proposed' } });
    expect(table(await lint(corpusOf({ [A]: goodBrief({ status: 'done' }) }, cfg)))).toEqual(['2 status: "done" is not a status here | use one of "proposed", "archived"']);
  });

  it('gives no hint for a file name with no id', async () => {
    const found = await lint(corpusOf({ 'briefs/.md': goodBrief() }, config({ files: '*.md' })));
    expect(found.map((f) => [f.rule, f.message, f.hint])).toEqual([['id', 'has no id in its file name', undefined]]);
  });

  it('lists every alias in a missing section hint', async () => {
    const text = goodBrief().replace('## Negative Scope\n\n- Nothing else changes.\n\n', '');
    expect((await lint(corpusOf({ [A]: text })))[0]?.hint).toBe(
      'add a "## Negative Scope" heading (also accepted: "Out of Scope", "Non-Goals", "Not in Scope", "What this round is NOT", "What this brief does NOT do").' +
        ' What this round must not do, even where it would look helpful.',
    );
  });

  it('reports an empty section once even when it appears twice', async () => {
    const text = goodBrief().replace('The tree is better.', '').replace('## Negative Scope', '## Intent\n\n## Negative Scope');
    expect((await lint(corpusOf({ [A]: text }))).map((f) => f.rule)).toEqual(['empty-section', 'duplicate-section']);
  });

  it('counts only the boxes inside a checklist section, and the text inside a section', async () => {
    const early = goodBrief().replace('The tree is better.', '- [ ] early').replace('- [x] the tests pass', 'no boxes');
    expect((await lint(corpusOf({ [A]: early }))).map((f) => f.rule)).toEqual(['missing-checklist']);
    const cfg = config({ sections: [{ name: 'Intent', mustContain: ['Latest'] }, 'Negative Scope'] });
    const above = goodBrief().replace('# A brief', '# Latest').replace('- Nothing else changes.', 'Latest');
    expect((await lint(corpusOf({ [A]: above }, cfg))).map((f) => f.rule)).toEqual(['must-contain']);
  });

  it('reports a bad protected pattern without tripping the contradiction check', async () => {
    const found = await lint(corpusOf({ [A]: goodBrief({ affectedFiles: '[src/**]', protectedFiles: '["/abs"]' }) }));
    expect(found.map((f) => f.rule)).toEqual(['glob']);
  });
});

describe('the scanner at its edges', () => {
  const lines = (text: string): string[] => text.split('\n');

  it('ends an item at a bare list marker, and closes a fence with trailing spaces', () => {
    expect(scan(lines('- [ ] a\n-\n')).tasks[0]?.end).toBe(1);
    expect(scan(lines('```\n# in\n```  \n# out')).headings.map((h) => h.text)).toEqual(['out']);
  });

  it('opens a tilde fence whatever its info string says', () => {
    expect(scan(lines('~~~ `x`\n# in\n~~~\n# out')).headings.map((h) => h.text)).toEqual(['out']);
  });

  it('trims a box text, and ends an item at a quote only where the line starts with one', () => {
    expect(scan(lines('- [ ] a   ')).tasks[0]?.text).toBe('a');
    expect(scan(lines('- [ ] a\nsee a > b\n')).tasks[0]?.end).toBe(2);
    expect(scan(lines('  - [ ] a\n > q\n')).tasks[0]?.end).toBe(1);
  });
});
