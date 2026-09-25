import { describe, expect, it } from 'vitest';

import { isReady } from '../src/corpus.js';
import { integrityOf } from '../src/integrity.js';
import { checkRuleIds, failing, lint, ruleIds, severityOf, sortFindings, summarise } from '../src/lint.js';
import { type Rule, scopeContradiction } from '../src/rules.js';
import type { Finding } from '../src/types.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';

async function findings(files: Record<string, string>, cfg = config(), repoFiles: string[] | null = null): Promise<Finding[]> {
  return lint(corpusOf(files, cfg), { repoFiles });
}

async function rulesHit(files: Record<string, string>, cfg = config(), repoFiles: string[] | null = null): Promise<string[]> {
  return (await findings(files, cfg, repoFiles)).map((f) => `${f.rule}@${f.line}`);
}

const A = 'briefs/001_a.md';
const B = 'briefs/002_b.md';

describe('a complete brief', () => {
  it('has no findings', async () => {
    expect(await findings({ [A]: goodBrief() })).toEqual([]);
  });
});

describe('front matter and fields', () => {
  it('reports front-matter problems at their lines', async () => {
    const text = goodBrief().replace('status: active', 'status: active\nstatus: active\nnot a line');
    expect(await rulesHit({ [A]: text })).toEqual(['front-matter@3', 'front-matter@4']);
  });

  it('reports an unclosed block, and then misses the status it could not read', async () => {
    const hit = await rulesHit({ [A]: '---\nstatus: active\n# T\n## Intent\nx\n' });
    expect(hit).toContain('front-matter@1');
    expect(hit).toContain('status@1');
  });

  it('reports fields of the wrong shape', async () => {
    const text = goodBrief({ wave: 'two', dependsOn: '{a: 1}', type: '[feature]', affectedFiles: '[a, ""]' });
    const found = await findings({ [A]: text });
    expect(found.filter((f) => f.rule === 'field').map((f) => f.message)).toEqual([
      '"wave" must be a whole number, not "two"',
      '"dependsOn" inline mappings are not supported',
      '"type" must be a single value, not a list',
      '"affectedFiles" must not contain an empty item',
    ]);
  });

  it('reads a quoted wave as the wrong shape', async () => {
    expect(await rulesHit({ [A]: goodBrief({ wave: '"2"' }) })).toEqual(['field@3']);
  });

  it('warns on unknown keys, suggesting the one that was probably meant', async () => {
    const found = await findings({ [A]: goodBrief({ owner: 'x' }) });
    expect(found.map((f) => [f.rule, f.severity, f.hint])).toEqual([
      ['unknown-field', 'warning', 'if the repository uses it, list it under "fields" in the configuration'],
    ]);
    const typo = await findings({ [A]: goodBrief({ dependOn: '[b]' }) });
    expect(typo[0]?.hint).toBe('did you mean "dependsOn"? If not, list "dependOn" under "fields" in the configuration');
    expect(await findings({ [A]: goodBrief({ owner: 'x' }) }, config({ fields: ['owner'] }))).toEqual([]);
  });
});

describe('status', () => {
  it('requires the field, knows the words, and checks it against the directory', async () => {
    const noStatus = goodBrief().replace('status: active\n', 'date: 2026-09-24\n');
    expect((await findings({ [A]: noStatus }))[0]?.message).toBe('declares no "status"');
    expect((await findings({ [A]: goodBrief({ status: 'done' }) }))[0]?.hint).toBe('use one of "draft", "active", "deferred", "archived"');
    expect((await findings({ [A]: goodBrief({ status: 'archived' }) }))[0]?.message).toBe('is marked "archived" but lives in briefs/');
    const archived = await findings({ 'briefs/archive/001_a.md': goodBrief({ status: 'active' }) });
    expect(archived.map((f) => f.message)).toEqual(['lives in briefs/archive/ but is marked "active"']);
  });

  it('accepts the words in any case, and a draft', async () => {
    expect(await findings({ [A]: goodBrief({ status: 'ACTIVE' }) })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ status: 'draft' }) })).toEqual([]);
  });

  it('reads location only when no field is configured', async () => {
    const cfg = config({ status: { field: null } });
    expect(await findings({ [A]: goodBrief({ status: 'anything' }) }, cfg)).toEqual([]);
  });

  it('suggests the archived word for an archived brief with no status', async () => {
    const text = '---\ndate: 2026-09-24\n---\n# T\n';
    expect((await findings({ 'briefs/archive/001_a.md': text }))[0]?.hint).toBe('add "status: archived" to the front matter');
  });
});

describe('deferral', () => {
  const deferred = (front: Record<string, string>): string => goodBrief({ status: 'deferred', ...front });

  it('keeps a deferred brief live and never ready, with its trigger read', () => {
    const corpus = corpusOf({ [A]: deferred({ trigger: 'when the second tenant signs' }) });
    expect(corpus.live[0]?.status).toBe('deferred');
    expect(corpus.live[0]?.trigger).toBe('when the second tenant signs');
    expect(isReady(corpus, corpus.live[0]!)).toBe(false);
  });

  it('passes a trigger that names an event', async () => {
    expect(await findings({ [A]: deferred({ trigger: 'when the second tenant signs' }) })).toEqual([]);
    expect(await findings({ [A]: deferred({ trigger: '"when p95 > 200 ms"' }) })).toEqual([]);
  });

  it('requires a trigger, at the status line when there is none and at its own when it is empty', async () => {
    const hint = 'add "trigger: <the event that brings it back>", such as "when the second tenant signs" or "when p95 exceeds 200 ms"';
    expect((await findings({ [A]: deferred({}) })).map((f) => [f.rule, f.line, f.message, f.hint])).toEqual([
      ['deferral-trigger', 2, 'is deferred and names no "trigger"', hint],
    ]);
    expect((await findings({ [A]: deferred({ wave: '1', trigger: '""' }) })).map((f) => [f.rule, f.line])).toEqual([['deferral-trigger', 4]]);
    expect((await findings({ [A]: deferred({ trigger: '' }) })).map((f) => [f.rule, f.line])).toEqual([['deferral-trigger', 3]]);
  });

  it('refuses a date, a time or a placeholder for an event', async () => {
    const says = async (trigger: string): Promise<string[]> =>
      (await findings({ [A]: deferred({ trigger }) })).map((f) => `${f.rule}@${f.line}: ${f.message} | ${f.hint}`);
    const event = 'name what must happen before the work resumes, such as "when the second tenant signs" or "when p95 exceeds 200 ms"';
    expect(await says('2026-10')).toEqual([
      `deferral-trigger@3: the trigger "2026-10" is a date or a time, not an event | ${event}; a date arrives whether or not the reason for the work has`,
    ]);
    expect(await says('next month')).toHaveLength(1);
    expect(await says('Q3')).toHaveLength(1);
    expect(await says('tbd')).toEqual([`deferral-trigger@3: the trigger "tbd" is a placeholder, not an event | ${event}`]);
    // A placeholder word inside an event is only a word.
    expect(await says('"TBD: when the vendor answers"')).toEqual([]);
  });

  it('leaves a trigger of the wrong shape to the field rule, and a brief that is not deferred alone', async () => {
    expect((await findings({ [A]: deferred({ trigger: '[a, b]' }) })).map((f) => f.rule)).toEqual(['field']);
    expect(await findings({ [A]: goodBrief({ trigger: '2026-10' }) })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ status: 'draft', trigger: 'Q3' }) })).toEqual([]);
  });

  it('holds a deferred brief to the live directory, and has no word for it when configured off', async () => {
    const archived = await findings({ 'briefs/archive/001_a.md': goodBrief({ status: 'deferred' }) });
    expect(archived.map((f) => f.message)).toEqual(['lives in briefs/archive/ but is marked "deferred"']);
    const off = await findings({ [A]: deferred({ trigger: 'when x' }) }, config({ status: { deferred: null } }));
    expect(off.map((f) => [f.rule, f.message, f.hint])).toEqual([['status', '"deferred" is not a status here', 'use one of "draft", "active", "archived"']]);
    const own = config({ status: { deferred: 'parked' } });
    expect(corpusOf({ [A]: goodBrief({ status: 'Parked' }) }, own).live[0]?.status).toBe('deferred');
  });
});

describe('ids', () => {
  it('reads the id from the front matter when configured to', async () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    expect((await findings({ 'briefs/x.md': goodBrief() }, cfg)).map((f) => f.message)).toEqual(['declares no "id"']);
    expect(await findings({ 'briefs/x.md': goodBrief({ id: 'B-12' }) }, cfg)).toEqual([]);
    expect((await findings({ 'briefs/x.md': goodBrief({ id: '"a b"' }) }, cfg))[0]?.message).toBe('the id "a b" contains whitespace or a slash');
  });

  it('reports a file name with no id', async () => {
    const found = await findings({ 'briefs/_x.md': goodBrief() }, config({ id: { separator: '_' } }));
    expect(found).toEqual([]);
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    expect((await findings({ 'briefs/x.md': goodBrief({ id: '' }) }, cfg))[0]?.hint).toBe('add "id: <id>" to the front matter');
  });

  it('reports a duplicate once, on every file after the first', async () => {
    const found = await findings({ [A]: goodBrief(), 'briefs/001_c.md': goodBrief(), 'briefs/archive/1_d.md': goodBrief({ status: 'archived' }) });
    expect(found.map((f) => [f.rule, f.file])).toEqual([
      ['duplicate-id', 'briefs/001_c.md'],
      ['duplicate-id', 'briefs/archive/1_d.md'],
    ]);
    expect(found[0]?.message).toBe('the id "001" is also briefs/001_a.md\'s');
  });
});

describe('sections', () => {
  it('reports a missing section with its aliases', async () => {
    const text = goodBrief().replace('## Negative Scope\n\n- Nothing else changes.\n\n', '');
    const found = await findings({ [A]: text });
    expect(found.map((f) => [f.rule, f.line])).toEqual([['missing-section', 4]]);
    expect(found[0]?.hint).toContain('also accepted: "Out of Scope"');
  });

  it('accepts aliases, and a section without aliases gets a plain hint', async () => {
    const text = goodBrief().replace('## Intent', "## Commander's Intent").replace('## Negative Scope', '## Non-Goals');
    expect(await findings({ [A]: text })).toEqual([]);
    const cfg = config({ sections: ['Mission'] });
    expect((await findings({ [A]: goodBrief() }, cfg))[0]?.hint).toBe('add a "## Mission" heading');
  });

  it('reports empty and placeholder sections, and only as warnings in a draft', async () => {
    const empty = goodBrief().replace('The tree is better.', '<!-- hint -->').replace('- Nothing else changes.', 'TBD: later');
    expect((await findings({ [A]: empty })).map((f) => [f.rule, f.severity])).toEqual([
      ['empty-section', 'error'],
      ['placeholder', 'error'],
    ]);
    const draft = empty.replace('status: active', 'status: draft');
    expect((await findings({ [A]: draft })).map((f) => f.severity)).toEqual(['warning', 'warning']);
  });

  it('counts a sub-heading as structure and its text as content', async () => {
    const onlyHeading = goodBrief().replace('The tree is better.', '### Part');
    expect((await findings({ [A]: onlyHeading })).map((f) => f.rule)).toEqual(['empty-section']);
    const withText = goodBrief().replace('The tree is better.', '### Part\n\ntext');
    expect(await findings({ [A]: withText })).toEqual([]);
  });

  it('recognises placeholders after list markers, boxes and emphasis, and not inside words', async () => {
    const cases: [string, boolean][] = [
      ['- [ ] TODO', true],
      ['1. **TBD**', true],
      ['- ...', true],
      ['TBD - soon', true],
      ['TODOS remain', false],
      ['todo: this is written', true],
      ['Nothing TBD here', false],
    ];
    for (const [line, expected] of cases) {
      const text = goodBrief().replace('The tree is better.', line);
      const hit = (await findings({ [A]: text })).some((f) => f.rule === 'placeholder');
      expect(hit, line).toBe(expected);
    }
  });

  it('requires a task item in a checklist section, leniently in a draft', async () => {
    const text = goodBrief().replace('- [x] the tests pass', 'the tests pass');
    expect((await findings({ [A]: text })).map((f) => [f.rule, f.severity])).toEqual([['missing-checklist', 'error']]);
    const draft = text.replace('status: active', 'status: draft');
    expect((await findings({ [A]: draft })).map((f) => f.severity)).toEqual(['warning']);
  });

  it('does not count a task item in a later section', async () => {
    const text = goodBrief().replace('- [x] the tests pass', 'the tests pass\n\n## Later\n\n- [ ] elsewhere');
    expect((await findings({ [A]: text })).map((f) => f.rule)).toEqual(['missing-checklist']);
  });

  it('requires configured text, compared exactly', async () => {
    const cfg = config({ sections: [{ name: 'Intent', mustContain: ['Latest is not newest'] }] });
    expect((await findings({ [A]: goodBrief() }, cfg)).map((f) => f.message)).toEqual([
      'the "Intent" section must contain "Latest is not newest"',
    ]);
    const ok = goodBrief().replace('The tree is better.', 'Latest is not newest.');
    expect(await findings({ [A]: ok }, cfg)).toEqual([]);
    const missingSection = config({ sections: [{ name: 'Absent', optional: true, mustContain: ['x'] }] });
    expect(await findings({ [A]: goodBrief() }, missingSection)).toEqual([]);
  });

  it('checks order only when asked, and names the order', async () => {
    const swapped = goodBrief().replace('## Intent\n\nThe tree is better.\n\n## Negative Scope\n\n- Nothing else changes.', '## Negative Scope\n\n- Nothing else changes.\n\n## Intent\n\nThe tree is better.');
    expect(await findings({ [A]: swapped })).toEqual([]);
    const found = await findings({ [A]: swapped }, config({ sectionOrder: true }));
    expect(found.map((f) => [f.rule, f.line, f.message])).toEqual([['section-order', 7, '"Negative Scope" comes before "Intent"']]);
    expect(found[0]?.hint).toBe('the order is Intent, Negative Scope, Not Empowered, Invariants');
    expect(await findings({ [A]: goodBrief() }, config({ sectionOrder: true }))).toEqual([]);
  });

  it('warns on a repeated section and checks the first one only', async () => {
    const text = `${goodBrief()}\n## Intent\n\n`;
    expect((await findings({ [A]: text })).map((f) => [f.rule, f.severity])).toEqual([['duplicate-section', 'warning']]);
  });

  it('adds the sections of a declared type, and reports an unknown type', async () => {
    expect((await findings({ [A]: goodBrief({ type: 'feature' }) })).map((f) => f.message)).toEqual(['has no "Acceptance Criteria" section']);
    expect((await findings({ [A]: goodBrief({ type: 'epic' }) }))[0]?.hint).toBe('use one of "feature", "defect", "refactor", "chore"');
    expect((await findings({ [A]: goodBrief({ type: 'epic' }) }, config({ types: {} })))[0]?.hint).toBe('the configuration defines no types');
    expect(await findings({ [A]: goodBrief({ type: 'chore' }) })).toEqual([]);
  });

  it('holds archived briefs to identity and freeze, not to structure', async () => {
    expect(await findings({ 'briefs/archive/001_a.md': '---\nstatus: archived\n---\n' })).toEqual([]);
  });

  it('warns on a live brief with no title', async () => {
    const text = goodBrief().replace('# A brief\n', '');
    expect((await findings({ [A]: text })).map((f) => [f.rule, f.line])).toEqual([['title', 4]]);
    expect(await findings({ [A]: goodBrief({ title: 'From the field' }).replace('# A brief\n', '') })).toEqual([]);
    expect((await findings({ [A]: goodBrief().replace('# A brief', '#') })).map((f) => f.rule)).toEqual(['title']);
  });
});

describe('dependencies and waves', () => {
  it('reports a dependency on itself and on nothing', async () => {
    const found = await findings({ [A]: goodBrief({ dependsOn: '[1, 999]' }) });
    expect(found.map((f) => f.message)).toEqual(['depends on "999", which is not a brief here', 'depends on itself']);
  });

  it('reports a cycle once, on its first brief, as a path', async () => {
    const found = await findings({
      [A]: goodBrief({ dependsOn: '[002]' }),
      [B]: goodBrief({ dependsOn: '[003]' }),
      'briefs/003_c.md': goodBrief({ dependsOn: '[001]' }),
    });
    expect(found.map((f) => [f.rule, f.file, f.message])).toEqual([
      ['dependency-cycle', A, 'dependencies form a cycle: 001 -> 002 -> 003 -> 001'],
    ]);
  });

  it('ignores cycles through archived briefs', async () => {
    const found = await findings({ [A]: goodBrief({ dependsOn: '[002]' }), 'briefs/archive/002_b.md': goodBrief({ status: 'archived', dependsOn: '[001]' }) });
    expect(found).toEqual([]);
  });

  it('requires a live dependency to run in an earlier wave', async () => {
    const found = await findings({ [A]: goodBrief({ wave: '2', dependsOn: '[002]' }), [B]: goodBrief({ wave: '2' }) });
    expect(found.map((f) => f.message)).toEqual(['depends on 002, which is in wave 2, not before wave 2']);
    expect(await findings({ [A]: goodBrief({ wave: '2', dependsOn: '[002]' }), [B]: goodBrief({ wave: '1' }) })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ wave: '1', dependsOn: '[002]' }), 'briefs/archive/002_b.md': goodBrief({ status: 'archived', wave: '3' }) })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ dependsOn: '[002]' }), [B]: goodBrief({ wave: '3' }) })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ wave: '1', dependsOn: '[002]' }), [B]: goodBrief() })).toEqual([]);
  });
});

describe('scopes', () => {
  it('reports patterns it cannot read', async () => {
    const found = await findings({ [A]: goodBrief({ affectedFiles: '["/abs"]', protectedFiles: '["a{"]' }) });
    expect(found.map((f) => [f.rule, f.line])).toEqual([
      ['glob', 3],
      ['glob', 4],
    ]);
  });

  it('lets protection carve a file out of a scope: what is writable is affected less protected', async () => {
    const found = await findings({ [A]: goodBrief({ affectedFiles: '[src/**]', protectedFiles: '[src/db/schema.ts, docs/**]' }) });
    expect(found).toEqual([]);
  });

  it('reports, once, every affected pattern the protections cover entirely', async () => {
    const found = await findings({
      [A]: goodBrief({ affectedFiles: '[src/db/**, src/**, src/db/schema.ts, "docs/*.md"]', protectedFiles: '[src/db/**, docs/a.md, docs/b.md]' }),
    });
    expect(found.map((f) => [f.rule, f.line, f.message])).toEqual([
      ['scope-contradiction', 4, '"src/db/**" and "src/db/schema.ts" in affectedFiles are entirely protected, so nothing of them is writable'],
    ]);
    // Covered by the protections together, not by any one of them.
    const together = await findings({ [A]: goodBrief({ affectedFiles: '["docs/{a,b}.md"]', protectedFiles: '[docs/a.md, docs/b.md]' }) });
    expect(together.map((f) => f.message)).toEqual(['"docs/{a,b}.md" in affectedFiles is entirely protected, so nothing of it is writable']);
  });

  it('says so when it cannot decide whether a pattern is entirely protected, and never guesses', () => {
    const b = brief(goodBrief({ affectedFiles: '[src/**, lib/a.ts]', protectedFiles: '["**/*.ts", lib/a.ts]' }));
    expect(scopeContradiction(b, null, 1)).toEqual([
      {
        line: 4,
        message: 'whether "src/**" and "lib/a.ts" in affectedFiles are entirely protected is undecided: the search met its budget',
        hint: 'simplify the patterns until the question can be answered',
        severity: 'warning',
      },
    ]);
    expect(scopeContradiction(b, null)).toEqual([
      {
        line: 4,
        message: '"lib/a.ts" in affectedFiles is entirely protected, so nothing of it is writable',
        hint: 'drop it from affectedFiles, or narrow protectedFiles so that some of it is writable',
      },
    ]);
    const single = brief(goodBrief({ affectedFiles: '[src/**]', protectedFiles: '["**/*.ts"]' }));
    expect(scopeContradiction(single, null, 1)[0]?.message).toBe('whether "src/**" in affectedFiles is entirely protected is undecided: the search met its budget');
  });

  it('notes a literal the tree does not hold and that could be a directory, and nothing else', async () => {
    const tree = ['src/auth/login.ts', 'Makefile', 'lib/x/a.ts'];
    const noted = async (pattern: string, repoFiles: string[] | null = tree): Promise<string[]> =>
      (await findings({ [A]: goodBrief({ affectedFiles: JSON.stringify([pattern]) }) }, config(), repoFiles))
        .filter((f) => f.rule === 'literal-read-as-file')
        .map((f) => `${f.message} | ${f.hint}`);
    expect(await noted('src/newmod')).toEqual(['"src/newmod" in affectedFiles is not in the tree and is read as a file | write "src/newmod/" for a directory']);
    expect(await noted('Dockerfile')).toEqual(['"Dockerfile" in affectedFiles is not in the tree and is read as a file | write "Dockerfile/" for a directory']);
    expect(await noted('.github')).toHaveLength(1);
    expect(await noted('lib/{a,b}')).toEqual([
      '"lib/{a,b}" in affectedFiles names lib/a and lib/b, which are not in the tree and are read as files | write a directory with a trailing "/", in an entry of its own',
    ]);
    // Held, spelt as a file, written as a directory, or a glob: nothing to ask.
    for (const pattern of ['src/auth', 'Makefile', 'src/new.ts', 'docs/v1.2', 'src/newmod/', 'src/new*', 'lib/{x,y.ts}']) {
      expect(await noted(pattern), pattern).toEqual([]);
    }
    // Without a tree nothing is known to be missing from it.
    expect(await noted('src/newmod', null)).toEqual([]);
    // One note per pattern: a literal it names is not also said to match nothing.
    const all = await findings({ [A]: goodBrief({ affectedFiles: '[src/newmod, docs/v1.2]', protectedFiles: '[gone]' }) }, config(), tree);
    expect(all.map((f) => `${f.rule}: ${f.message}`)).toEqual([
      'glob-matches-nothing: "docs/v1.2" in affectedFiles matches no file in the tree',
      'literal-read-as-file: "src/newmod" in affectedFiles is not in the tree and is read as a file',
      'literal-read-as-file: "gone" in protectedFiles is not in the tree and is read as a file',
    ]);
  });

  it('notes a pattern that matches no file in the tree, only when files are known', async () => {
    const files = { [A]: goodBrief({ affectedFiles: '[src/new/**, src/a.ts]', protectedFiles: '[gone.ts]' }) };
    expect(await findings(files)).toEqual([]);
    const found = await findings(files, config(), ['src/a.ts']);
    expect(found.map((f) => [f.rule, f.severity, f.message])).toEqual([
      ['glob-matches-nothing', 'note', '"src/new/**" in affectedFiles matches no file in the tree'],
      ['glob-matches-nothing', 'note', '"gone.ts" in protectedFiles matches no file in the tree'],
    ]);
  });
});

describe('the freeze', () => {
  it('passes an unchanged archived brief and fails an edited one', async () => {
    const body = '---\nstatus: archived\nintegrity: HASH\n---\n\n# T\n';
    const hash = integrityOf(body);
    const sealed = body.replace('HASH', hash);
    expect(await findings({ 'briefs/archive/001_a.md': sealed })).toEqual([]);
    const edited = sealed.replace('# T', '# T, edited');
    expect((await findings({ 'briefs/archive/001_a.md': edited })).map((f) => [f.rule, f.line])).toEqual([['archive-freeze', 3]]);
  });

  it('survives CRLF and a byte-order mark, which a checkout may add', async () => {
    const body = '---\nstatus: archived\nintegrity: HASH\n---\n\n# T\n';
    const sealed = body.replace('HASH', integrityOf(body));
    const checkedOut = `${String.fromCharCode(0xfeff)}${sealed.replace(/\n/g, '\r\n')}`;
    expect(await findings({ 'briefs/archive/001_a.md': checkedOut })).toEqual([]);
  });

  it('leaves an archived brief with no hash, and a live one, alone', async () => {
    expect(await findings({ 'briefs/archive/001_a.md': '---\nstatus: archived\n---\n' })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ integrity: 'sha256-x' }) })).toEqual([]);
  });
});

describe('running rules', () => {
  it('applies configured severities, and "off" silences a rule', async () => {
    const text = goodBrief().replace('# A brief\n', '');
    expect((await findings({ [A]: text }, config({ rules: { title: 'error' } })))[0]?.severity).toBe('error');
    expect(await findings({ [A]: text }, config({ rules: { title: 'off' } }))).toEqual([]);
  });

  it('never raises a finding a rule lowered, and lowers it further when configured', async () => {
    const draft = goodBrief({ status: 'draft' }).replace('The tree is better.', '');
    expect((await findings({ [A]: draft }, config({ rules: { 'empty-section': 'note' } })))[0]?.severity).toBe('note');
    expect((await findings({ [A]: draft }, config({ rules: { 'empty-section': 'error' } })))[0]?.severity).toBe('warning');
  });

  it('refuses a rule id nobody defines', () => {
    const corpus = corpusOf({}, config({ rules: { 'no-such-rule': 'off' } }));
    expect(() => checkRuleIds(corpus)).toThrow('"rules.no-such-rule" names no rule');
    expect(() => checkRuleIds(corpusOf({}, config({ rules: { collision: 'warning' } })))).not.toThrow();
    expect(severityOf(corpus, 'x', 'note')).toBe('note');
  });

  it('runs plugin rules under their namespace, with their options, and limits to chosen briefs', async () => {
    const seen: unknown[] = [];
    const rule: Rule = {
      id: 'always',
      severity: 'warning',
      description: 'always fires',
      check: async ({ brief, options }) => {
        seen.push(options);
        return [{ line: 0.7, message: `saw ${brief.id ?? ''}`, hint: 'h' }];
      },
    };
    const corpus = corpusOf({ [A]: goodBrief(), [B]: goodBrief() });
    const only = corpus.briefs.filter((b) => b.file === B);
    const found = await lint(corpus, { plugins: [{ name: 'acme', rules: [rule], options: { level: 1 } }], only });
    expect(found).toEqual([{ rule: 'acme/always', severity: 'warning', message: 'saw 002', file: B, line: 1, brief: '002', hint: 'h' }]);
    expect(seen).toEqual([{ level: 1 }]);
    expect(ruleIds([{ name: 'acme', rules: [rule] }])).toContain('acme/always');
    const off = corpusOf({ [A]: goodBrief() }, config({ rules: { 'acme/always': 'off' } }));
    expect(await lint(off, { plugins: [{ name: 'acme', rules: [rule] }] })).toEqual([]);
  });

  it('sorts by file, line, rule and message, and counts by severity', () => {
    const f = (file: string, line: number, rule: string, message: string, severity: Finding['severity'] = 'error'): Finding => ({ file, line, rule, message, severity });
    const sorted = sortFindings([f('b', 1, 'r', 'm'), f('a', 2, 'r', 'm'), f('a', 1, 's', 'm'), f('a', 1, 'r', 'n'), f('a', 1, 'r', 'm', 'note')]);
    expect(sorted.map((x) => `${x.file}${x.line}${x.rule}${x.message}`)).toEqual(['a1rm', 'a1rn', 'a1sm', 'a2rm', 'b1rm']);
    expect(summarise([f('a', 1, 'r', 'm'), f('a', 1, 'r', 'm', 'warning'), f('a', 1, 'r', 'm', 'note'), f('a', 1, 'r', 'm', 'note')])).toEqual({ errors: 1, warnings: 1, notes: 2 });
    expect(failing([f('a', 1, 'r', 'm', 'warning')], false)).toBe(false);
    expect(failing([f('a', 1, 'r', 'm', 'warning')], true)).toBe(true);
    expect(failing([f('a', 1, 'r', 'm', 'note')], true)).toBe(false);
    expect(failing([f('a', 1, 'r', 'm')], false)).toBe(true);
  });
});
