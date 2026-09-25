import { describe, expect, it } from 'vitest';

import { planArchive } from '../src/archive.js';
import { collisions } from '../src/collisions.js';
import { definePlugin } from '../src/index.js';
import { lint } from '../src/lint.js';
import {
  briefJson,
  findingJson,
  githubCommands,
  jsonDocument,
  paint,
  planJson,
  prettyFindings,
  prettyList,
  prettyMatrix,
  prettyPlan,
  sarif,
  sectionsJson,
  summaryLine,
} from '../src/report.js';
import { fileNameFor, nextId, renderNewBrief } from '../src/scaffold.js';
import type { Finding } from '../src/types.js';
import { config, corpusOf, goodBrief } from './helpers.js';

const plainStyle = { color: false };
const finding = (over: Partial<Finding> = {}): Finding => ({ rule: 'r', severity: 'error', message: 'm', file: 'a.md', line: 1, ...over });

describe('pretty findings', () => {
  it('groups by file, aligns lines, and puts hints under their finding', () => {
    const text = prettyFindings(
      [finding({ line: 3, hint: 'do this' }), finding({ line: 12, severity: 'note', rule: 'n' }), finding({ file: 'b.md', severity: 'warning' })],
      plainStyle,
    );
    expect(text).toBe(
      ['a.md', '   3  error    m  r', `${' '.repeat(15)}do this`, '  12  note     m  n', '', 'b.md', '   1  warning  m  r'].join('\n'),
    );
  });

  it('paints only when asked', () => {
    const esc = String.fromCharCode(27);
    expect(paint({ color: true }, 'red', 'x')).toBe(`${esc}[31mx${esc}[39m`);
    expect(paint({ color: true }, 'bold', 'x')).toBe(`${esc}[1mx${esc}[22m`);
    expect(paint(plainStyle, 'red', 'x')).toBe('x');
  });

  it('counts in the singular and the plural', () => {
    expect(summaryLine([finding(), finding({ severity: 'warning' })])).toBe('1 error, 1 warning, 0 notes');
    expect(summaryLine([finding(), finding()])).toBe('2 errors, 0 warnings, 0 notes');
  });
});

describe('machine formats', () => {
  it('writes a versioned JSON document and leaves out absent fields', () => {
    expect(JSON.parse(jsonDocument('lint', '1.2.3', { ok: true }))).toEqual({ tool: 'spec-brief', version: '1.2.3', schemaVersion: 2, command: 'lint', ok: true });
    expect(findingJson(finding())).toEqual({ rule: 'r', severity: 'error', file: 'a.md', line: 1, message: 'm' });
    expect(findingJson(finding({ brief: '1', hint: 'h' }))).toEqual(expect.objectContaining({ brief: '1', hint: 'h' }));
  });

  it('writes SARIF 2.1.0 with rule metadata, relative locations and hints in the message', () => {
    const doc = JSON.parse(sarif([finding({ rule: 'missing-section', line: 4, hint: 'add it' }), finding({ rule: 'acme/x', severity: 'note' }), finding({ rule: 'shared-directory', severity: 'warning' })], '0.1.0')) as {
      version: string;
      runs: { tool: { driver: { rules: { id: string; defaultConfiguration?: { level: string }; shortDescription: { text: string } }[] } }; results: { level: string; message: { text: string }; locations: { physicalLocation: { artifactLocation: { uri: string; uriBaseId: string }; region: { startLine: number } } }[] }[] }[];
    };
    expect(doc.version).toBe('2.1.0');
    const run = doc.runs[0]!;
    expect(run.tool.driver.rules.map((r) => [r.id, r.defaultConfiguration?.level])).toEqual([
      ['acme/x', undefined],
      ['missing-section', 'error'],
      ['shared-directory', undefined],
    ]);
    expect(run.tool.driver.rules[0]?.shortDescription.text).toBe('acme/x');
    expect(run.results[0]).toEqual({
      ruleId: 'missing-section',
      level: 'error',
      message: { text: 'm. add it' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'a.md', uriBaseId: '%SRCROOT%' }, region: { startLine: 4 } } }],
    });
    expect(run.results[1]?.level).toBe('note');
  });

  it('writes GitHub workflow commands with their escapes', () => {
    const text = githubCommands([
      finding({ file: 'a,b:c.md', message: '50% done\nnext\rline', hint: 'h' }),
      finding({ severity: 'warning' }),
      finding({ severity: 'note' }),
    ]);
    expect(text.split('\n')).toEqual([
      '::error file=a%2Cb%3Ac.md,line=1,title=spec-brief r::50%25 done%0Anext%0Dline. h',
      '::warning file=a.md,line=1,title=spec-brief r::m',
      '::notice file=a.md,line=1,title=spec-brief r::m',
      '',
    ]);
  });
});

describe('lists, matrices and plans', () => {
  const corpus = corpusOf({
    'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/api/a.ts]' }),
    'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[src/api/b.ts, src/x/**]' }),
    'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[src/x/y.ts]' }),
    'briefs/004_d.md': goodBrief({ wave: '1' }),
    'briefs/005_e.md': goodBrief(),
  });

  it('describes a brief as JSON', () => {
    expect(briefJson(corpus.briefs[0]!, { ready: true })).toEqual({
      id: '001',
      file: 'briefs/001_a.md',
      title: 'A brief',
      phase: 'live',
      status: 'active',
      type: null,
      wave: 1,
      dependsOn: [],
      affectedFiles: ['src/api/a.ts'],
      protectedFiles: [],
      trigger: null,
      tasks: { total: 1, checked: 1 },
      ready: true,
    });
  });

  it('lists a brief with no id, status or title by what it has', () => {
    const odd = corpusOf({ 'briefs/1.md': '---\nstatus: weird\n---\n' }, config({ id: { source: 'frontmatter' }, files: '*.md' }));
    const text = prettyList([{ brief: odd.briefs[0]!, ready: false, waitingOn: [] }], plainStyle);
    expect(text.split('\n')[1]).toBe('?   weird   -     0/0    no     1.md');
    const none = corpusOf({ 'briefs/1.md': '# T\n' }, config({ id: { source: 'frontmatter' }, files: '*.md' }));
    expect(prettyList([{ brief: none.briefs[0]!, ready: false, waitingOn: [] }], plainStyle).split('\n')[1]).toContain('?     ');
  });

  it('draws a matrix with collisions, shared directories and unscoped briefs', () => {
    const loud = corpusOf(Object.fromEntries(corpus.briefs.map((b) => [b.file, b.source])), config({ rules: { 'shared-directory': 'warning' } }));
    const text = prettyMatrix(collisions(loud), plainStyle);
    expect(text).toBe(
      [
        'wave 1 \u00b7 4 briefs',
        '       001  002  003  004',
        '  001    \u00b7    ~    \u00b7    \u00b7',
        '  002    ~    \u00b7    X    \u00b7',
        '  003    \u00b7    X    \u00b7    \u00b7',
        '  004    \u00b7    \u00b7    \u00b7    \u00b7',
        '  X 002 "src/x/**" and 003 "src/x/y.ts" both cover src/x/y.ts',
        '  ~ 001 and 002 both write into src/api/',
        '  ? 004 declares no affectedFiles and cannot be checked',
        '',
        'no wave: 005',
      ].join('\n'),
    );
    expect(prettyMatrix(collisions(corpusOf({})), plainStyle)).toBe('no live briefs');
  });

  it('tells a dry run from a real one, and prints the banner only on a dry run', () => {
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', changes: [{ path: 'x', insertions: 1, deletions: 0 }] });
    const dry = prettyPlan(plan, true, plainStyle);
    expect(dry).toContain('would move briefs/001_a.md -> briefs/archive/001_a.md');
    expect(dry).toContain('banner:');
    expect(dry).not.toContain('nothing was committed');
    const real = prettyPlan(plan, false, plainStyle);
    expect(real).toContain('moved briefs/001_a.md');
    expect(real).toContain('the round changed 1 file');
    expect(real).toContain('nothing was committed; review the change and commit it with the round');
    expect(planJson(plan)).toEqual(expect.objectContaining({ action: 'archive', refused: false, operations: [{ kind: 'write', path: 'briefs/archive/001_a.md' }, { kind: 'remove', path: 'briefs/001_a.md' }] }));
  });

  it('lists what it rewrote and what it left frozen', () => {
    const linked = corpusOf({
      'briefs/001_a.md': goodBrief({}, '\n[x](x.md)\n'),
      'briefs/002_b.md': goodBrief({}, '\n[a](001_a.md)\n'),
      'briefs/archive/000_z.md': goodBrief({ status: 'archived' }, '\n[a](../001_a.md)\n'),
    });
    const text = prettyPlan(planArchive(linked, linked.briefs[0]!, { date: '2026-09-24' }), true, plainStyle);
    expect(text).toContain('  1 relative link rewritten');
    expect(text).toContain('  briefs/002_b.md: links to it rewritten');
    expect(text).toContain('  briefs/archive/000_z.md:19: links to the old path, and is frozen, so it was left as it is');
  });
});

describe('scaffolding', () => {
  it('allocates the next number at the configured width, and none for word ids', () => {
    expect(nextId(corpusOf({}))).toBe('001');
    expect(nextId(corpusOf({ 'briefs/009_a.md': '', 'briefs/archive/041_b.md': '' }))).toBe('042');
    expect(nextId(corpusOf({ 'briefs/1000_a.md': '' }))).toBe('1001');
    expect(nextId(corpusOf({ 'briefs/B-1_a.md': '' }))).toBeNull();
    expect(nextId(corpusOf({ 'briefs/B-1_a.md': '', 'briefs/3_b.md': '' }))).toBe('004');
    expect(nextId(corpusOf({ 'briefs/1.md': '---\n---\n' }, config({ id: { source: 'frontmatter' }, files: '*.md' })))).toBe('001');
  });

  it('names the file from the id and the title', () => {
    expect(fileNameFor(config(), '007', 'Split it')).toBe('007_split-it.md');
    expect(fileNameFor(config(), '007', '!!')).toBe('007.md');
    const fm = config({ id: { source: 'frontmatter' } });
    expect(fileNameFor(fm, 'B-1', 'Split it')).toBe('split-it.md');
    expect(fileNameFor(fm, 'B-1', '!!')).toBe('B-1.md');
  });

  it('writes every section with a hint, the required text, and a box in checklist sections', () => {
    const cfg = config({
      sections: ['Mission', { name: 'Directives', mustContain: ['Latest is not newest'] }, { name: 'Deliverables', checklist: true }],
      status: { draft: null, active: 'proposed' },
      id: { source: 'frontmatter' },
      types: { defect: { sections: ['The Defect, Measured'] } },
    });
    const text = renderNewBrief(cfg, { id: '035', title: 'T', date: '2026-09-24', type: 'defect' }, null);
    expect(text).toBe(
      [
        '---',
        'id: "035"',
        'status: proposed',
        'date: 2026-09-24',
        'type: defect',
        'affectedFiles: []',
        'protectedFiles: []',
        '---',
        '',
        '# 035 \u2014 T',
        '',
        '## Mission',
        '',
        '<!-- Write the Mission. -->',
        '',
        '## Directives',
        '',
        '<!-- Write the Directives. -->',
        '',
        '- Latest is not newest',
        '',
        '## Deliverables',
        '',
        '<!-- Write the Deliverables. -->',
        '',
        '- [ ] <!-- one check -->',
        '',
        '## The Defect, Measured',
        '',
        '<!-- How to reproduce the defect, and the measurement that shows it. -->',
        '',
      ].join('\n'),
    );
    const noStatus = renderNewBrief(config({ status: { field: null } }), { id: '1', title: 'T', date: '2026-09-24', type: 'unknown', dependsOn: [] }, null);
    expect(noStatus.startsWith('---\ndate: 2026-09-24\ntype: unknown\naffectedFiles: []')).toBe(true);
  });
});

describe('the library', () => {
  it('types a plugin without changing it', () => {
    const plugin = { name: 'p', rules: [] };
    expect(definePlugin(plugin)).toBe(plugin);
  });
});

describe('section hints', () => {
  const cfg = config({
    sections: [
      { name: 'Mission', hint: 'Why the round exists --> and for whom.' },
      { name: 'Deliverables', checklist: true },
      'Intent',
    ],
    types: { spike: { sections: [{ name: 'Findings', aliases: ['Results'], optional: true, mustContain: ['Measured'], hint: 'What the spike measured.' }] } },
  });

  it('are read from the configuration, and must say something', () => {
    expect(cfg.sections.map((s) => s.hint)).toEqual(['Why the round exists --> and for whom.', undefined, undefined]);
    expect(() => config({ sections: [{ name: 'x', hint: '' }] })).toThrow('"sections[0].hint" must not be empty');
    expect(() => config({ sections: [{ name: 'x', hint: 3 }] })).toThrow('"sections[0].hint" must be a string');
  });

  it('are written under each heading of a new brief, where a comment is not content', async () => {
    const text = renderNewBrief(cfg, { id: '001', title: 'T', date: '2026-09-24', type: 'spike' }, null);
    expect(text.split('\n').filter((line) => line.startsWith('<!--'))).toEqual([
      // A "-->" in the hint would end the comment early.
      '<!-- Why the round exists -- > and for whom. -->',
      '<!-- Write the Deliverables. -->',
      // A section named as a default one is, without a hint of its own, gets the default's.
      '<!-- The state of the tree when this round is done, and why it matters. One paragraph. -->',
      '<!-- What the spike measured. -->',
    ]);
    const corpus = corpusOf({ 'briefs/001_t.md': text.replace('status: draft', 'status: active') }, cfg);
    const found = await lint(corpus);
    // An empty box is a placeholder, so a checklist section reads as unwritten too.
    expect(found.filter((f) => f.rule === 'empty-section' || f.rule === 'placeholder').map((f) => [f.message, f.hint])).toEqual([
      ['the "Mission" section is empty', 'Why the round exists --> and for whom.'],
      ['the "Deliverables" section holds only a placeholder', 'replace the placeholder with what the section must say'],
      ['the "Intent" section is empty', 'write it; a comment alone is not content'],
    ]);
  });

  it('carry into the finding that a section is missing', async () => {
    const corpus = corpusOf({ 'briefs/001_t.md': '---\nstatus: active\n---\n\n# T\n\n## Deliverables\n\n- [ ] x\n\n## Intent\n\nx\n' }, cfg);
    expect((await lint(corpus)).map((f) => [f.rule, f.hint])).toEqual([['missing-section', 'add a "## Mission" heading. Why the round exists --> and for whom.']]);
  });

  it('are described with every section the configuration asks for', () => {
    expect(sectionsJson(cfg)).toEqual([
      { name: 'Mission', type: null, aliases: [], optional: false, checklist: false, mustContain: [], hint: 'Why the round exists --> and for whom.' },
      { name: 'Deliverables', type: null, aliases: [], optional: false, checklist: true, mustContain: [], hint: null },
      { name: 'Intent', type: null, aliases: [], optional: false, checklist: false, mustContain: [], hint: null },
      { name: 'Findings', type: 'spike', aliases: ['Results'], optional: true, checklist: false, mustContain: ['Measured'], hint: 'What the spike measured.' },
    ]);
    expect(sectionsJson(config()).map((s) => [s['name'], s['type'], s['hint'] === null])).toEqual([
      ['Intent', null, false],
      ['Negative Scope', null, false],
      ['Not Empowered', null, false],
      ['Invariants', null, false],
      ['Acceptance Criteria', 'feature', false],
      ['The Defect, Measured', 'defect', false],
    ]);
  });
});
