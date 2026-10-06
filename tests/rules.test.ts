import { describe, expect, it } from 'vitest';

import { isReady } from '../src/corpus.js';
import { integrityOf } from '../src/integrity.js';
import { checkRuleIds, failing, lint, ruleIds, severityOf, sortFindings, summarise } from '../src/lint.js';
import { type Rule, scopeContradiction } from '../src/rules.js';
import type { Finding } from '../src/types.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';
import { fastestInTurn, instrumented } from './timing.js';

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

  it('reports TOML front matter as a block it does not read, and reads the body after it', async () => {
    const toml = goodBrief().replace('---\nstatus: active\n---', '+++\nstatus = "active"\n+++');
    const found = await findings({ [A]: toml });
    expect(found.map((f) => `${f.rule}@${f.line}: ${f.message}`)).toEqual([
      'front-matter@1: TOML front matter is not read; write YAML between "---" lines',
      'status@1: declares no "status"',
    ]);
    expect(brief(toml).bodyStart).toBe(3);
    expect(brief(toml).title).toBe('A brief');
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

  it('reads a status key in Chinese where the configuration names it, and as a key nobody declared elsewhere', async () => {
    // "狀態" is a key, as a word of any script is to YAML. It was a line the
    // front matter could not read, an error; unnamed by "status.field" it is
    // now a key nobody declared, and the brief declares no status.
    const written = goodBrief().replace('status: active', '狀態: 進行中');
    expect((await findings({ [A]: written })).map((f) => [f.rule, f.severity, f.message, f.hint])).toEqual([
      ['status', 'error', 'declares no "status"', 'add "status: active" to the front matter'],
      ['unknown-field', 'warning', '"狀態" is not a key spec-brief knows', 'if the repository uses it, list it under "fields" in the configuration'],
    ]);
    expect(await findings({ [A]: written }, config({ status: { field: '狀態', active: '進行中' } }))).toEqual([]);
    // YAML separates a key with an ASCII colon only: after a full-width one
    // the line is still one the front matter cannot read.
    const fullWidth = goodBrief().replace('status: active', 'status: active\n狀態：進行中');
    expect((await findings({ [A]: fullWidth })).map((f) => [f.rule, f.message])).toEqual([['front-matter', 'not a "key: value" line']]);
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
    expect(await says('TBD.')).toEqual([`deferral-trigger@3: the trigger "TBD." is a placeholder, not an event | ${event}`]);
    for (const trigger of ['tbd?!', 'TBD;', 'TBD\u2026']) expect(await says(trigger), trigger).toHaveLength(1);
    // A placeholder word inside an event is only a word.
    expect(await says('"TBD: when the vendor answers"')).toEqual([]);
    expect(await says('"TBD. When the vendor answers."')).toEqual([]);
  });

  it('reads a trigger in English: a time or a placeholder in Chinese is read as an event', async () => {
    // English only (ADR-0003, amended 2026-09-30): a miss, which the rule accepts.
    for (const trigger of ['下個月', '2026年10月', 'Ｑ３', '待定']) {
      expect(await findings({ [A]: deferred({ trigger }) }), trigger).toEqual([]);
    }
  });

  it('leaves a trigger of the wrong shape to the field rule, and a brief that is not deferred alone', async () => {
    expect((await findings({ [A]: deferred({ trigger: '[a, b]' }) })).map((f) => f.rule)).toEqual(['field']);
    // Another field's problem is its own finding, and the missing trigger still one.
    expect((await findings({ [A]: deferred({ wave: 'two' }) })).map((f) => f.rule)).toEqual(['deferral-trigger', 'field']);
    expect((await findings({ [A]: deferred({ trigger: '"   "' }) })).map((f) => f.message)).toEqual(['is deferred and names no "trigger"']);
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
      // Any stop that ends a sentence ends a placeholder, as a period does, and a note may follow a space.
      ['TBD.', true],
      ['TBD!', true],
      ['TBD?', true],
      ['TBD;', true],
      ['TBD\u2026', true],
      ['TBD?!', true],
      ['????', true],
      ['TBD. Ask the vendor.', true],
      ['TBD! ask the vendor', true],
      ['TBD.: ask the vendor', true],
      ['TBD\u2014ask the vendor', true],
      ['TBD-', true],
      ['TBD -', true],
      ['TBD- ask the vendor', true],
      ['TBD-- ask the vendor', true],
      // A stop or a hyphen that goes on into a word is part of that word.
      ['TODO.md lists the open work.', false],
      ['XXX.yaml stays as it is.', false],
      ['TBD!important', false],
      ['TODO-driven work is out.', false],
      ['XXX-large files stay in the bucket.', false],
      // A word as long as a placeholder, ended by a stop, is still a word.
      ['None.', false],
      // The placeholders are English, and a full-width colon is not a colon (ADR-0003, amended 2026-09-30).
      ['待定', false],
      ['- [ ] 待確認', false],
      ['待定：等廠商回覆', false],
      ['TBD：later', false],
      // Indented, or after a marker and more than one space, a placeholder and an empty box are what they were.
      ['  TBD', true],
      ['-  [ ]', true],
      ['-   [x] TBD', true],
      // A box is one where the item's text starts: after a word it is that word's bracket, as the stop in TODO.md is its stop.
      ['TODO[x]', false],
    ];
    for (const [line, expected] of cases) {
      const text = goodBrief().replace('The tree is better.', line);
      const hit = (await findings({ [A]: text })).some((f) => f.rule === 'placeholder');
      expect(hit, line).toBe(expected);
    }
  });

  it('counts as a section\'s content what is under its heading, not the line above it', async () => {
    // Prose that runs up to the next heading with no empty line between is the section's it is in.
    const text = goodBrief().replace('The tree is better.\n\n## Negative Scope\n\n- Nothing else changes.\n', 'The tree is better.\n## Negative Scope\n');
    expect((await findings({ [A]: text })).map((f) => [f.rule, f.line, f.message])).toEqual([['empty-section', 10, 'the "Negative Scope" section is empty']]);
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

  it('looks for the text under the heading, line by line', async () => {
    // The heading names the section and is not what it says.
    const named = config({ sections: [{ name: 'Intent', mustContain: ['Intent'] }] });
    expect((await findings({ [A]: goodBrief() }, named)).map((f) => [f.rule, f.line, f.message])).toEqual([['must-contain', 7, 'the "Intent" section must contain "Intent"']]);
    // Two lines are not run together into a word neither holds.
    const word = config({ sections: [{ name: 'Intent', mustContain: ['signoff'] }] });
    const broken = goodBrief().replace('The tree is better.', 'Wait for the sign\noff of the owner.');
    expect((await findings({ [A]: broken }, word)).map((f) => f.message)).toEqual(['the "Intent" section must contain "signoff"']);
  });

  it('checks order only when asked, and names the order', async () => {
    const swapped = goodBrief().replace('## Intent\n\nThe tree is better.\n\n## Negative Scope\n\n- Nothing else changes.', '## Negative Scope\n\n- Nothing else changes.\n\n## Intent\n\nThe tree is better.');
    expect(await findings({ [A]: swapped })).toEqual([]);
    const found = await findings({ [A]: swapped }, config({ sectionOrder: true }));
    expect(found.map((f) => [f.rule, f.line, f.message])).toEqual([['section-order', 7, '"Negative Scope" comes before "Intent"']]);
    expect(found[0]?.hint).toBe('the order is Intent, Negative Scope, Not Empowered, Invariants');
    expect(await findings({ [A]: goodBrief() }, config({ sectionOrder: true }))).toEqual([]);
  });

  it('finds a heading that fills two rules in order with itself', async () => {
    // A type that says more about a section every brief carries: one heading, asked about twice.
    const cfg = config({ sectionOrder: true, types: { feature: { sections: [{ name: 'Invariants', checklist: true, mustContain: ['tests'] }] } } });
    expect(await findings({ [A]: goodBrief({ type: 'feature' }) }, cfg)).toEqual([]);
  });

  it('warns on a repeated section and checks the first one only', async () => {
    const text = `${goodBrief()}\n## Intent\n\n`;
    expect((await findings({ [A]: text })).map((f) => [f.rule, f.severity])).toEqual([['duplicate-section', 'warning']]);
    // Unwritten, or a checklist with no box, the second is still only a second.
    const placeholder = `${goodBrief()}\n## Intent\n\nTBD\n`;
    expect((await findings({ [A]: placeholder })).map((f) => [f.rule, f.line])).toEqual([['duplicate-section', 19]]);
    const unboxed = `${goodBrief()}\n## Invariants\n\nno boxes\n`;
    expect((await findings({ [A]: unboxed })).map((f) => [f.rule, f.line])).toEqual([['duplicate-section', 19]]);
  });

  it('adds the sections of a declared type, and reports an unknown type', async () => {
    expect((await findings({ [A]: goodBrief({ type: 'feature' }) })).map((f) => f.message)).toEqual(['has no "Acceptance Criteria" section']);
    expect((await findings({ [A]: goodBrief({ type: 'epic' }) }))[0]?.hint).toBe('use one of "feature", "defect", "refactor", "chore"');
    expect((await findings({ [A]: goodBrief({ type: 'epic' }) }, config({ types: {} })))[0]?.hint).toBe('the configuration defines no types');
    expect(await findings({ [A]: goodBrief({ type: 'chore' }) })).toEqual([]);
  });

  it('adds no type\'s sections to a brief that declares no type, whatever a type is called', async () => {
    // YAML reads "type: null" as no type, so no brief can ask for a type of that name.
    const cfg = config({ types: { null: { sections: ['Rollback'] } } });
    expect(await findings({ [A]: goodBrief() }, cfg)).toEqual([]);
    expect(await findings({ [A]: goodBrief({ type: 'null' }) }, cfg)).toEqual([]);
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

  it('grows no section from prose over a rule, and counts that prose as content', async () => {
    // A renderer reads "Intent" over "---" as a setext heading; a brief's sections are ATX headings.
    const text = goodBrief().replace('## Intent\n\nThe tree is better.\n', '## Intent\n\nThe tree is better.\n---\n\nAnd lighter.\n');
    expect(await findings({ [A]: text })).toEqual([]);
    expect(brief(text).sections.map((s) => s.heading.text)).toEqual(['Intent', 'Negative Scope', 'Invariants']);
    const underlinedOnly = goodBrief().replace('The tree is better.', 'The tree is better.\n---');
    expect(await findings({ [A]: underlinedOnly })).toEqual([]);
    // A setext title is not a title, as a setext section is not a section.
    const setextTitle = goodBrief().replace('# A brief', 'A brief\n=======');
    expect((await findings({ [A]: setextTitle })).map((f) => f.rule)).toEqual(['title']);
  });

  it('leaves a heading quoted from another document out of the sections', async () => {
    const quoted = goodBrief().replace('The tree is better.', 'The tree is better.\n\n> ## Negative Scope\n> quoted from 012');
    expect(await findings({ [A]: quoted })).toEqual([]);
  });

  it('reads a heading without the comment on its line', async () => {
    expect(await findings({ [A]: goodBrief().replace('## Intent', '## Intent <!-- required -->') })).toEqual([]);
  });

  it('reads the sections after a <!-- in the middle of a line that never closes', async () => {
    expect(await findings({ [A]: goodBrief().replace('The tree is better.', 'The tree is better; `<!--` opens a comment, as <!-- does.') })).toEqual([]);
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
    // A dependency with no wave is in none to be before or after, wave 0 as any other.
    expect(await findings({ [A]: goodBrief({ wave: '0', dependsOn: '[002]' }), [B]: goodBrief() })).toEqual([]);
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

  it('reads a "/" after a leading "./" as the core does, rooting nothing', async () => {
    // ".//docs" is "docs", as POSIX reads it: the "./" goes with the slashes
    // after it. It was refused as "/docs" is.
    expect(await findings({ [A]: goodBrief({ affectedFiles: '[src/**, ".//docs/**"]', protectedFiles: '[".//src/db/**"]' }) })).toEqual([]);
    expect(await findings({ [A]: goodBrief({ affectedFiles: '["./{/docs,src}/**"]' }) })).toEqual([]);
    // Read so, it protects what "src/db" does.
    const both = await findings({ [A]: goodBrief({ affectedFiles: '[".//src/db/**"]', protectedFiles: '[src/db/**]' }) });
    expect(both.map((f) => f.rule)).toEqual(['scope-contradiction']);
    expect(await findings({ [A]: goodBrief({ affectedFiles: '[./docs/**]', protectedFiles: '[./docs/a.md]' }) })).toEqual([]);
  });

  it('refuses a brace alternative that starts with "/", as a pattern that starts with one is, naming the alternative', async () => {
    // spec-core reads "{/docs,lib}" as "/docs", rooted at the filesystem's
    // root, or "lib": "docs" fell out of the scope and nothing said so. It
    // read "docs" or "lib" before, and a protection "{src/db,/src/db}"
    // protected "src/db" twice.
    const found = await findings({ [A]: goodBrief({ affectedFiles: '[src/**, "{/docs,lib}"]', protectedFiles: '["{src/db,/src/db}"]' }) });
    expect(found.map((f) => [f.rule, f.line, f.message, f.hint])).toEqual([
      [
        'glob',
        3,
        '"{/docs,lib}" in affectedFiles: a pattern is relative to the repository root, and the braces expand to "/docs", which starts with "/"',
        'a scope is a glob relative to the repository root: "src/auth/", "src/**/*.ts", "docs/{a,b}.md"',
      ],
      [
        'glob',
        4,
        '"{src/db,/src/db}" in protectedFiles: a pattern is relative to the repository root, and the braces expand to "/src/db", which starts with "/"',
        'a scope is a glob relative to the repository root: "src/auth/", "src/**/*.ts", "docs/{a,b}.md"',
      ],
    ]);
    // Wherever the alternative is written, in the words of the text the braces give.
    for (const [pattern, text] of [
      ['{lib,/docs}', '/docs'],
      ['{lib,{/docs,x}}', '/docs'],
      ['{//docs,lib}', '/docs'],
    ] as const) {
      const refused = await findings({ [A]: goodBrief({ affectedFiles: JSON.stringify([pattern]) }) });
      expect(refused.map((f) => [f.rule, f.message]), pattern).toEqual([
        ['glob', `"${pattern}" in affectedFiles: a pattern is relative to the repository root, and the braces expand to "${text}", which starts with "/"`],
      ]);
    }
    // A pattern that starts with "/" is refused in its own words, as it was.
    const whole = await findings({ [A]: goodBrief({ affectedFiles: '["/docs"]' }) });
    expect(whole.map((f) => f.message)).toEqual(['"/docs" in affectedFiles: a pattern is relative to the repository root and cannot start with "/"']);
    // A "/" that starts no text reads as it did: "docs/{/a,b}" is "docs//a", which is "docs/a".
    for (const pattern of ['{docs,lib}', 'docs/{/a,b}', 'docs{/a,.md}']) {
      expect(await findings({ [A]: goodBrief({ affectedFiles: JSON.stringify([pattern]) }) }), pattern).toEqual([]);
    }
  });

  it('refuses a brace alternative that names no path, as the same text written alone is, naming the alternative', async () => {
    // "{./,docs}" read "./" as the contents of ".", every path, where "./"
    // alone is refused: it protected everything, so every affected pattern
    // was entirely protected, and in affectedFiles it claimed the whole tree.
    const found = await findings({ [A]: goodBrief({ affectedFiles: '[src/**, "{./,src}"]', protectedFiles: '["{./,docs}"]' }) });
    expect(found.map((f) => [f.rule, f.line, f.message])).toEqual([
      ['glob', 3, '"{./,src}" in affectedFiles: the braces expand to "./", which names no path'],
      ['glob', 4, '"{./,docs}" in protectedFiles: the braces expand to "./", which names no path'],
    ]);
    // Refused wherever the alternative is written, in the words of the text the braces give.
    for (const [pattern, text] of [
      ['{src,./}', './'],
      ['{.//,src}', './/'],
      ['{.,src}/', './'],
      ['.{/,src}', './'],
      ['{.,src}', '.'],
    ] as const) {
      const refused = await findings({ [A]: goodBrief({ affectedFiles: JSON.stringify([pattern]) }) });
      expect(refused.map((f) => [f.rule, f.message]), pattern).toEqual([['glob', `"${pattern}" in affectedFiles: the braces expand to "${text}", which names no path`]]);
    }
    // One that names a path under the root reads as it did.
    for (const pattern of ['src/{./,a}', '{./a,b}', '{.github/,a}', 'a{,.ts}']) {
      expect(await findings({ [A]: goodBrief({ affectedFiles: JSON.stringify([pattern]) }) }), pattern).toEqual([]);
    }
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
        subject: 'undecided',
      },
    ]);
    expect(scopeContradiction(b, null)).toEqual([
      {
        line: 4,
        message: '"lib/a.ts" in affectedFiles is entirely protected, so nothing of it is writable',
        hint: 'drop it from affectedFiles, or narrow protectedFiles so that some of it is writable',
        subject: 'covered',
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
    // The advice is the pattern written, with a "/" ending each alternative
    // the note names, inside braces as alone; or each in an entry of its own.
    expect(await noted('lib/{a,b}')).toEqual([
      '"lib/{a,b}" in affectedFiles names lib/a and lib/b, which are not in the tree and are read as files | write "lib/{a/,b/}" for directories, or "lib/a/" and "lib/b/" in entries of their own',
    ]);
    // A trailing "/" inside braces says directory as it does alone, so the note names only the bare name.
    expect(await noted('{src/newmod/,lib/new}')).toEqual([
      '"{src/newmod/,lib/new}" in affectedFiles names lib/new, which is not in the tree and is read as a file | write "{src/newmod/,lib/new/}" for a directory, or "lib/new/" in an entry of its own',
    ]);
    // A glob and a directory the tree holds keep what they say, nested braces take the "/" where they end, and escapes stay as written.
    expect(await noted('lib/{*.ts,x,new}')).toEqual([
      '"lib/{*.ts,x,new}" in affectedFiles names lib/new, which is not in the tree and is read as a file | write "lib/{*.ts,x,new/}" for a directory, or "lib/new/" in an entry of its own',
    ]);
    expect(await noted('lib/{new,y/{z,a.ts}}')).toEqual([
      '"lib/{new,y/{z,a.ts}}" in affectedFiles names lib/new and lib/y/z, which are not in the tree and are read as files | write "lib/{new/,y/{z/,a.ts}}" for directories, or "lib/new/" and "lib/y/z/" in entries of their own',
    ]);
    expect(await noted('lib/\\{new\\}')).toEqual(['"lib/\\{new\\}" in affectedFiles names lib/{new}, which is not in the tree and is read as a file | write "lib/\\{new\\}/" for a directory']);
    // A "." segment is kept as written: the alternative still names a path, with the "/" as without it.
    expect(await noted('src/{./newmod,auth}')).toEqual([
      '"src/{./newmod,auth}" in affectedFiles names src/newmod, which is not in the tree and is read as a file | write "src/{./newmod/,auth}" for a directory, or "src/./newmod/" in an entry of its own',
    ]);
    // An alternative the reader refuses as an entry of its own, a negation, is left as written, and the advice is for the rest.
    expect(await noted('{!x,new}')).toEqual([
      '"{!x,new}" in affectedFiles names !x and new, which are not in the tree and are read as files | write "{!x,new/}" for a directory, or "new/" in an entry of its own',
    ]);
    // Where more of the pattern follows braces, a "/" inside them would change every alternative that takes it.
    expect(await noted('{lib,src}/x')).toEqual([
      '"{lib,src}/x" in affectedFiles names src/x, which is not in the tree and is read as a file | write "src/x/" for a directory, in an entry of its own',
    ]);
    expect(await noted('{a,b}/new')).toEqual([
      '"{a,b}/new" in affectedFiles names a/new and b/new, which are not in the tree and are read as files | write "a/new/" and "b/new/" for directories, in entries of their own',
    ]);
    // Held, spelt as a file, written as a directory, or a glob: nothing to ask.
    for (const pattern of ['src/auth', 'Makefile', 'src/new.ts', 'docs/v1.2', 'src/newmod/', 'src/new*', 'lib/{x,y.ts}', '{src/newmod/,Makefile}']) {
      expect(await noted(pattern), pattern).toEqual([]);
    }
    // Without a tree nothing is known to be missing from it.
    expect(await noted('src/newmod', null)).toEqual([]);
    // The extension is the last name's, not a dotted directory's above it.
    expect(await noted('docs/v1.2/newmod')).toHaveLength(1);
    // One note per pattern: a literal it names is not also said to match nothing.
    const all = await findings({ [A]: goodBrief({ affectedFiles: '[src/newmod, docs/v1.2]', protectedFiles: '[gone]' }) }, config(), tree);
    expect(all.map((f) => `${f.rule}: ${f.message}`)).toEqual([
      'glob-matches-nothing: "docs/v1.2" in affectedFiles matches no file in the tree',
      'literal-read-as-file: "src/newmod" in affectedFiles is not in the tree and is read as a file',
      'literal-read-as-file: "gone" in protectedFiles is not in the tree and is read as a file',
    ]);
    // With no bare name left to place, a pattern of new directories and files matches nothing yet, as "src/newmod/" alone does.
    const braced = await findings({ [A]: goodBrief({ affectedFiles: '["{src/newmod/,docs/new.md}"]' }) }, config(), tree);
    expect(braced.map((f) => `${f.rule}: ${f.message}`)).toEqual(['glob-matches-nothing: "{src/newmod/,docs/new.md}" in affectedFiles matches no file in the tree']);
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

  it('judges the patterns against the tree in time linear in the patterns and the files', async () => {
    // Each brief writes a directory of its own, and the tree has 400 files in
    // each. Every pattern was asked about every file until one matched.
    const tree = (count: number): string[] => Array.from({ length: count * 400 }, (_, n) => `src/m${Math.floor(n / 400)}/f${n % 400}.ts`);
    const run = (count: number) => {
      const corpus = corpusOf(
        Object.fromEntries(
          Array.from({ length: count }, (_, n) => [
            `briefs/${String(n + 1).padStart(3, '0')}_x.md`,
            goodBrief({ affectedFiles: `[src/m${n}/**, src/m${n}/f0.ts]`, protectedFiles: `[src/m${n}/f1.ts]` }),
          ]),
        ),
      );
      const files = tree(count);
      // A copy for each run, so that each reads its tree afresh, as a run of the command does.
      return () => lint(corpus, { repoFiles: [...files] });
    };
    const small = run(10);
    const large = run(40);
    expect(await large()).toEqual([]);
    const beyond = await findings({ [A]: goodBrief({ affectedFiles: '[src/m40/**, src/m39/f399.ts]' }) }, config(), tree(40));
    expect(beyond.map((f) => f.message)).toEqual(['"src/m40/**" in affectedFiles matches no file in the tree']);
    if (instrumented()) return;
    // Four lints of ten briefs over 4,000 files against one of forty over
    // 16,000: work that grows with patterns times files takes four times as
    // long on the larger. Twice linear is allowed, and 100 ms for noise. On
    // the machine this was written on, the larger took 990 ms against 590 ms
    // allowed before, and after, 24 ms, as long as the four smaller.
    const [fourSmall, oneLarge] = (await fastestInTurn(
      3,
      async () => {
        for (let n = 0; n < 4; n += 1) await small();
      },
      large,
    )) as [number, number];
    expect(oneLarge).toBeLessThan(2 * fourSmall + 100);
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
