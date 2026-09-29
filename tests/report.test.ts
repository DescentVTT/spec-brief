import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { planArchive } from '../src/archive.js';
import { collisionFindings, collisions } from '../src/collisions.js';
import { definePlugin } from '../src/index.js';
import { lint } from '../src/lint.js';
import {
  briefJson,
  findingJson,
  githubCommands,
  gitlabCodeQuality,
  jsonDocument,
  paint,
  planJson,
  prettyFindings,
  prettyList,
  prettyMatrix,
  prettyPlan,
  prettySchedule,
  sarif,
  sectionsJson,
  summaryLine,
  titleWithoutId,
} from '../src/report.js';
import { fileNameFor, nextId, renderNewBrief } from '../src/scaffold.js';
import { schedule, scheduleFindings } from '../src/schedule.js';
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

  it('writes GitLab Code Quality issues, fingerprinted by what each finding is about', () => {
    const sha = (identity: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const issues = JSON.parse(
      gitlabCodeQuality([
        finding({ rule: 'missing-section', line: 4, message: 'has no "Intent" section', hint: 'add it', brief: '001', subject: 'Intent' }),
        finding({ rule: 'acme/x', severity: 'warning', file: 'b.md', line: 2 }),
        finding({ severity: 'note', line: 9 }),
        finding({ severity: 'note', line: 12 }),
        finding({ rule: 'protected-file', line: 5, path: 'src/db/schema.ts' }),
      ]),
    ) as unknown[];
    expect(issues).toEqual([
      {
        description: 'has no "Intent" section. add it',
        check_name: 'missing-section',
        fingerprint: sha(['missing-section', 'a.md', '001', 'Intent']),
        severity: 'major',
        location: { path: 'a.md', lines: { begin: 4 } },
      },
      { description: 'm', check_name: 'acme/x', fingerprint: sha(['acme/x', 'b.md', '', '']), severity: 'minor', location: { path: 'b.md', lines: { begin: 2 } } },
      // Two findings alike but for their line are two issues, told apart by their order.
      { description: 'm', check_name: 'r', fingerprint: sha(['r', 'a.md', '', '']), severity: 'info', location: { path: 'a.md', lines: { begin: 9 } } },
      { description: 'm', check_name: 'r', fingerprint: sha(['r', 'a.md', '', '', 2]), severity: 'info', location: { path: 'a.md', lines: { begin: 12 } } },
      // A finding about one path, and no other subject, is about that path.
      { description: 'm', check_name: 'protected-file', fingerprint: sha(['protected-file', 'a.md', '', 'src/db/schema.ts']), severity: 'major', location: { path: 'a.md', lines: { begin: 5 } } },
    ]);
    const print = (over: Partial<Finding>): string => (JSON.parse(gitlabCodeQuality([finding(over)])) as { fingerprint: string }[])[0]!.fingerprint;
    // Moved, or worded another way, a finding is the same issue.
    expect(print({ line: 40, message: 'said another way', hint: 'and another hint' })).toBe(print({}));
    // About another thing, or in another brief, it is another.
    expect(print({ subject: 'Intent' })).not.toBe(print({ subject: 'Invariants' }));
    expect(print({ brief: '001' })).not.toBe(print({ brief: '002' }));
    expect(gitlabCodeQuality([])).toBe('[]\n');
  });

  it('names what each finding is about, which its fingerprint is built from', async () => {
    const about = (found: readonly Finding[]): string[] => found.map((f) => `${f.rule} ${f.subject ?? '-'}`).sort();
    const cfg = config({ sections: ['Intent', { name: 'Negative Scope', mustContain: ['one', 'two'] }, { name: 'Invariants', checklist: true }, 'Report'] });
    const text = [
      '---',
      'status: active',
      'wave: two',
      'owner: me',
      'dependsOn: [001, 404]',
      'affectedFiles: ["/abs", src/newmod, "docs/*.md"]',
      '---',
      '',
      '# A',
      '',
      '## Intent',
      '',
      'TBD',
      '',
      '## Intent',
      '',
      'again',
      '',
      '## Negative Scope',
      '',
      '<!-- unwritten -->',
      '',
      '## Invariants',
      '',
      'no boxes',
      '',
    ].join('\n');
    expect(about(await lint(corpusOf({ 'briefs/001_a.md': text }, cfg), { repoFiles: ['src/a.ts'] }))).toEqual([
      'dependency 001',
      'dependency 404',
      'duplicate-section Intent',
      'empty-section Negative Scope',
      'field wave',
      'glob affectedFiles: /abs',
      'glob-matches-nothing affectedFiles: docs/*.md',
      'literal-read-as-file affectedFiles: src/newmod',
      'missing-checklist Invariants',
      'missing-section Report',
      'must-contain Negative Scope: "one"',
      'must-contain Negative Scope: "two"',
      'placeholder Intent',
      'unknown-field owner',
    ]);
    const ordered = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', dependsOn: '[002]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', dependsOn: '[001]' }),
      'briefs/003_c.md': goodBrief({ wave: '1', dependsOn: '[004]' }),
      'briefs/004_d.md': goodBrief({ wave: '2' }),
      // A cycle walked 005, 007, 006 is named by its briefs in order.
      'briefs/005_e.md': goodBrief({ dependsOn: '[007]' }),
      'briefs/006_f.md': goodBrief({ dependsOn: '[005]' }),
      'briefs/007_g.md': goodBrief({ dependsOn: '[006]' }),
    });
    const linted = await lint(ordered);
    expect(about(linted)).toEqual(['dependency-cycle 001, 002', 'dependency-cycle 005, 006, 007', 'wave-order 002', 'wave-order 001', 'wave-order 004'].sort());
    // lint and schedule word a cycle differently, and GitLab sees one problem.
    const scheduled = scheduleFindings(ordered, schedule(ordered)).filter((f) => f.rule === 'dependency-cycle');
    const cycle = linted.filter((f) => f.rule === 'dependency-cycle');
    expect(scheduled[0]?.message).not.toBe(cycle[0]?.message);
    const prints = (found: readonly Finding[]): string[] => (JSON.parse(gitlabCodeQuality(found)) as { fingerprint: string }[]).map((i) => i.fingerprint);
    expect(prints(scheduled)).toHaveLength(2);
    expect(prints(scheduled)).toEqual(prints(cycle));
    // A pair of briefs is about the other brief of the pair.
    const pairs = corpusOf(
      {
        'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/**]' }),
        'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["src/**/x.ts"]' }),
        'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[lib/a.ts]' }),
        'briefs/004_d.md': goodBrief({ wave: '1', affectedFiles: '[lib/b.ts]' }),
        'briefs/005_e.md': goodBrief({ wave: '1' }),
      },
      config({ rules: { 'shared-directory': 'note' } }),
    );
    expect(about(collisionFindings(pairs, collisions(pairs)))).toEqual(['collision 001', 'shared-directory 003', 'unscoped -']);
    const unsure = corpusOf({ 'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/**]' }), 'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["**/*.ts"]' }) });
    expect(about(collisionFindings(unsure, collisions(unsure, { budget: 1 })))).toEqual(['collision-undecided 001']);
  });

  it('gives each finding of a rule in one brief its own fingerprint, which fixing another leaves alone', async () => {
    const two = goodBrief({ affectedFiles: '["/a", "/b"]', dependsOn: '[x, y]' }).replace('## Intent\n\nThe tree is better.\n\n', '');
    const prints = async (text: string): Promise<string[]> =>
      (JSON.parse(gitlabCodeQuality(await lint(corpusOf({ 'briefs/001_a.md': text })))) as { check_name: string; fingerprint: string }[]).map((i) => `${i.check_name} ${i.fingerprint}`);
    const before = await prints(two);
    expect(before.map((p) => p.split(' ')[0])).toEqual(['glob', 'glob', 'dependency', 'dependency', 'missing-section']);
    expect(new Set(before).size).toBe(5);
    // Each of the pair fixed in turn: the one left keeps the fingerprint it had, not the first's.
    const after = await prints(two.replace('[x, y]', '[y]').replace('["/a", "/b"]', '["/b"]'));
    expect(after).toEqual([before[1], before[3], before[4]]);
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

  it('shows the status word the brief writes, where the configuration spells it in Chinese', () => {
    const cfg = config({ status: { draft: '草稿', active: '進行中', deferred: '延後', archived: '封存' } });
    const listed = corpusOf(
      {
        'briefs/001_a.md': '---\nstatus: 進行中\n---\n\n# A\n',
        'briefs/002_b.md': '---\nstatus: 延後\n---\n\n# B\n',
        'briefs/archive/000_z.md': '---\nstatus: 封存\n---\n\n# Z\n',
      },
      cfg,
    );
    const rows = listed.briefs.map((brief) => ({ brief, ready: false, waitingOn: [] }));
    expect(prettyList(rows, plainStyle).split('\n').map((line) => line.split(/\s+/)[1])).toEqual(['STATUS', '進行中', '延後', '封存']);
    // The words are still read as the lifecycle they name.
    expect(listed.briefs.map((b) => b.status)).toEqual(['active', 'deferred', 'archived']);
    // With no status field, the status is where the brief lives.
    const located = corpusOf({ 'briefs/001_a.md': '# A\n' }, config({ status: { field: null } }));
    expect(prettyList([{ brief: located.briefs[0]!, ready: true, waitingOn: [] }], plainStyle).split('\n')[1]).toBe('001  active  -     0/0    yes    A');
  });

  it('shows a title without the id it repeats, in the list and the schedule', () => {
    const titled = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[a/**]' }).replace('# A brief', '# 001 \u2014 Rotate tokens'),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[b/**]' }).replace('# A brief', '# 002 - Fix - the login bug'),
    });
    const rows = titled.briefs.map((brief) => ({ brief, ready: true, waitingOn: [] }));
    expect(prettyList(rows, plainStyle).split('\n').slice(1)).toEqual(['001  active  1     1/1    yes    Rotate tokens', '002  active  1     1/1    yes    Fix - the login bug']);
    expect(prettySchedule(schedule(titled), null, plainStyle).split('\n').slice(1, 3)).toEqual(['  001  Rotate tokens', '  002  Fix - the login bug']);
    // The title itself is as written, for the JSON and the tools that read it.
    expect(briefJson(titled.briefs[0]!)['title']).toBe('001 \u2014 Rotate tokens');
  });

  it('takes off only the brief\'s own id, and only before a separator', () => {
    const cases: [string, string | null, string][] = [
      ['001 \u2014 Rotate tokens', '001', 'Rotate tokens'],
      ['001\u2014Rotate tokens', '001', 'Rotate tokens'],
      ['001 \u2013 Rotate tokens', '001', 'Rotate tokens'],
      ['001: Rotate tokens', '001', 'Rotate tokens'],
      ['001\uff1a登入', '001', '登入'],
      ['001 - Rotate tokens', '001', 'Rotate tokens'],
      // An id of digits is compared by value, as ids are.
      ['12 - Rotate tokens', '012', 'Rotate tokens'],
      ['B-12: Rotate tokens', 'B-12', 'Rotate tokens'],
      ['12a \u2014 Rotate tokens', '12a', 'Rotate tokens'],
      // None of these is an id and a title.
      ['Fix - the login bug', '001', 'Fix - the login bug'],
      ['Fix the login bug - now', 'B-1', 'Fix the login bug - now'],
      ['0010 \u2014 x', '001', '0010 \u2014 x'],
      ['2026\uff1aroadmap', '001', '2026\uff1aroadmap'],
      ['001-2 migration', '001', '001-2 migration'],
      ['B-123 \u2014 x', 'B-12', 'B-123 \u2014 x'],
      ['001 --- x', '001', '001 --- x'],
      ['001- x', '001', '001- x'],
      ['001 -2', '001', '001 -2'],
      ['001x \u2014 y', '001', '001x \u2014 y'],
      ['Fix - the login bug', 'B-1', 'Fix - the login bug'],
      ['null \u2014 x', null, 'null \u2014 x'],
      // A title written with spaces before it, as a quoted front-matter value can be.
      ['  001 \u2014 Rotate tokens', '001', 'Rotate tokens'],
      // Nothing after the separator leaves the title as it is.
      ['001 \u2014', '001', '001 \u2014'],
      ['001 \u2014 x', null, '001 \u2014 x'],
    ];
    for (const [title, id, shown] of cases) expect(titleWithoutId(title, id), `${title} in ${String(id)}`).toBe(shown);
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
