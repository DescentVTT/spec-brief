import { describe, expect, it } from 'vitest';

import { planArchive, planUnarchive } from '../src/archive.js';
import { collisionFindings, collisions } from '../src/collisions.js';
import { lint } from '../src/lint.js';
import { prettyFindings, prettyList, prettyMatrix, prettyPlan } from '../src/report.js';
import { ARCHIVE_RULES, COLLISION_RULES, RULES } from '../src/rules.js';
import type { Finding } from '../src/types.js';
import { config, corpusOf, goodBrief } from './helpers.js';

/**
 * Everything the tool says, written out. A finding's rule, line, message and
 * hint are what a person or an agent acts on, so they are asserted whole: a
 * test that checks only the rule would pass a hint that tells the reader to do
 * the wrong thing. Each table below was read line by line when it was written.
 */

const table = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `${f.file}:${f.line} ${f.severity} ${f.rule}: ${f.message}${f.hint === undefined ? '' : ` | ${f.hint}`}`);

describe('the rule catalogue', () => {
  it('names every rule once, in kebab case, with a sentence describing it', () => {
    const all = [...RULES, ...COLLISION_RULES, ...ARCHIVE_RULES];
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    for (const rule of all) {
      expect(rule.id, rule.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(rule.description, rule.id).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('gives each rule the default severity the README documents', () => {
    expect(Object.fromEntries([...RULES, ...COLLISION_RULES, ...ARCHIVE_RULES].map((r) => [r.id, r.severity]))).toEqual({
      'front-matter': 'error',
      field: 'error',
      'unknown-field': 'warning',
      status: 'error',
      id: 'error',
      'duplicate-id': 'error',
      title: 'warning',
      'unknown-type': 'error',
      'missing-section': 'error',
      'duplicate-section': 'warning',
      'empty-section': 'error',
      placeholder: 'error',
      'missing-checklist': 'error',
      'must-contain': 'error',
      'section-order': 'error',
      dependency: 'error',
      'dependency-cycle': 'error',
      'wave-order': 'error',
      glob: 'error',
      'scope-contradiction': 'error',
      'glob-matches-nothing': 'note',
      'archive-freeze': 'error',
      collision: 'error',
      unscoped: 'note',
      'shared-directory': 'off',
      'scope-unmeasured': 'warning',
    });
  });
});

describe('what lint says', () => {
  it('about front matter, fields, status and identity', async () => {
    const corpus = corpusOf({
      'briefs/001_a.md': '---\n  stray\nstatus: active\nstatus: active\nwave: "2"\nowner: x\ndependon: [2]\n---\n\n# A\n\n## Intent\n\nx\n\n## Negative Scope\n\nx\n\n## Invariants\n\n- [x] y\n',
      'briefs/001_b.md': goodBrief({ status: 'done' }),
      'briefs/002_c.md': goodBrief({ status: 'archived' }),
      'briefs/003_d.md': goodBrief().replace('status: active\n', 'date: 2026-09-24\n'),
      'briefs/archive/004_e.md': goodBrief({ status: 'active' }),
    });
    expect(table(await lint(corpus))).toEqual([
      'briefs/001_a.md:2 error front-matter: an indented line belongs to no key | front matter is flat "key: value" lines, with lists as [a, b] or "- item" lines',
      'briefs/001_a.md:4 error front-matter: "status" is declared twice (first on line 3) | front matter is flat "key: value" lines, with lists as [a, b] or "- item" lines',
      'briefs/001_a.md:5 error field: "wave" must be a whole number, not "2"',
      'briefs/001_a.md:6 warning unknown-field: "owner" is not a key spec-brief knows | if the repository uses it, list it under "fields" in the configuration',
      'briefs/001_a.md:7 warning unknown-field: "dependon" is not a key spec-brief knows | did you mean "dependsOn"? If not, list "dependon" under "fields" in the configuration',
      'briefs/001_b.md:1 error duplicate-id: the id "001" is also briefs/001_a.md\'s | ids are allocated once and never reused; give this brief the next free one',
      'briefs/001_b.md:2 error status: "done" is not a status here | use one of "draft", "active", "archived"',
      'briefs/002_c.md:2 error status: is marked "archived" but lives in briefs/ | run "spec-brief archive 002", which moves it and writes its banner',
      'briefs/003_d.md:1 error status: declares no "status" | add "status: active" to the front matter',
      'briefs/archive/004_e.md:2 error status: lives in briefs/archive/ but is marked "active" | run "spec-brief unarchive 004" to reopen it, or set "status: archived"',
    ]);
  });

  it('about ids read from front matter', async () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    const corpus = corpusOf({ 'briefs/a.md': goodBrief(), 'briefs/b.md': goodBrief({ id: '"x/y"' }) }, cfg);
    expect(table(await lint(corpus))).toEqual([
      'briefs/a.md:1 error id: declares no "id" | add "id: <id>" to the front matter',
      'briefs/b.md:1 error id: the id "x/y" contains whitespace or a slash',
    ]);
    const byName = corpusOf({ 'briefs/_x.md': goodBrief() }, config({ id: { separator: 'x' }, files: '*.md' }));
    expect(table(await lint(byName))).toEqual([]);
  });

  it('about sections', async () => {
    const cfg = config({
      sections: [
        { name: 'Mission', mustContain: ['Latest is not newest'] },
        { name: 'Scope', aliases: ['Out of Scope'] },
        { name: 'Checks', checklist: true },
        'Report',
      ],
      sectionOrder: true,
      types: { defect: { sections: ['Measured'] } },
    });
    const body = [
      '---',
      'status: active',
      'type: defect',
      '---',
      '',
      '# T',
      '',
      '## Checks',
      '',
      'no boxes here',
      '',
      '## Mission',
      '',
      '<!-- only a hint -->',
      '',
      '## Scope',
      '',
      'TBD',
      '',
      '## Scope',
      '',
      'again',
      '',
    ].join('\n');
    expect(table(await lint(corpusOf({ 'briefs/001_a.md': body }, cfg)))).toEqual([
      'briefs/001_a.md:5 error missing-section: has no "Measured" section | add a "## Measured" heading',
      'briefs/001_a.md:5 error missing-section: has no "Report" section | add a "## Report" heading',
      'briefs/001_a.md:8 error missing-checklist: the "Checks" section has no "- [ ]" items | write each check as a task item, so it has a state that can be closed',
      'briefs/001_a.md:8 error section-order: "Checks" comes before "Scope" | the order is Mission, Scope, Checks, Report, Measured',
      'briefs/001_a.md:12 error empty-section: the "Mission" section is empty',
      'briefs/001_a.md:12 error must-contain: the "Mission" section must contain "Latest is not newest"',
      'briefs/001_a.md:16 error placeholder: the "Scope" section holds only a placeholder',
      'briefs/001_a.md:20 warning duplicate-section: a second "Scope" section | merge the two',
    ]);
  });

  it('about types and titles', async () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief({ type: 'epic' }).replace('# A brief\n', '') });
    expect(table(await lint(corpus))).toEqual([
      'briefs/001_a.md:3 error unknown-type: "epic" is not a brief type here | use one of "feature", "defect", "refactor", "chore"',
      'briefs/001_a.md:5 warning title: has no title | start the body with "# <title>"',
    ]);
  });

  it('about dependencies, cycles and waves', async () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', dependsOn: '[002, 001, 404]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', dependsOn: '[001]' }),
    });
    expect(table(await lint(corpus))).toEqual([
      'briefs/001_a.md:4 error dependency: depends on "404", which is not a brief here',
      'briefs/001_a.md:4 error dependency: depends on itself',
      'briefs/001_a.md:4 error dependency-cycle: dependencies form a cycle: 001 -> 002 -> 001 | a cycle can never become ready; remove the dependency that is not real',
      'briefs/001_a.md:4 error wave-order: depends on 002, which is in wave 1, not before wave 1 | move this brief to a wave after 1, or 002 to one before 1',
      'briefs/002_b.md:4 error wave-order: depends on 001, which is in wave 1, not before wave 1 | move this brief to a wave after 1, or 001 to one before 1',
    ]);
  });

  it('about scopes', async () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**, "/x"]', protectedFiles: '[src/db.ts, new/**]' }) });
    expect(table(await lint(corpus, { repoFiles: ['src/db.ts', 'README.md'] }))).toEqual([
      'briefs/001_a.md:3 error glob: "/x" in affectedFiles: a pattern is relative to the repository root and cannot start with "/"',
      'briefs/001_a.md:4 note glob-matches-nothing: "new/**" in protectedFiles matches no file in the tree | expected when the round creates it; otherwise check the spelling',
      'briefs/001_a.md:4 error scope-contradiction: "src/**" is in scope and "src/db.ts" is protected, and both cover src/db.ts | narrow the scope, or the protection, so that no file is both',
    ]);
  });

  it('about the freeze', async () => {
    const corpus = corpusOf({ 'briefs/archive/001_a.md': '---\nstatus: archived\nintegrity: sha256-0\n---\n' });
    expect(table(await lint(corpus))).toEqual([
      'briefs/archive/001_a.md:3 error archive-freeze: has changed since it was archived | an archived brief is frozen: restore it from git, or unarchive it to reopen the round',
    ]);
  });

  it('about collisions', () => {
    const corpus = corpusOf(
      {
        'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/a/**]' }),
        'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[src/a/x.ts]' }),
        'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[src/b.ts]' }),
        'briefs/004_d.md': goodBrief({ wave: '1', affectedFiles: '[src/c.ts]' }),
        'briefs/005_e.md': goodBrief({ wave: '1' }),
      },
      config({ rules: { 'shared-directory': 'note' } }),
    );
    expect(table(collisionFindings(corpus, collisions(corpus)))).toEqual([
      'briefs/002_b.md:4 error collision: "src/a/x.ts" overlaps 001\'s "src/a/**" in wave 1; both cover src/a/x.ts | run them in different waves, make one depend on the other, or narrow a scope',
      'briefs/004_d.md:4 note shared-directory: writes into src/, as 003 does in wave 1',
      'briefs/005_e.md:1 note unscoped: declares no affectedFiles, so it cannot be checked against the 4 other brief(s) in wave 1 | list the files or globs this round writes under "affectedFiles"',
    ]);
  });
});

describe('what archive says when it refuses', () => {
  it('names every reason, with its line and what to do', () => {
    const body = '\n## Deliverables\n\n- [ ] open\n';
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ status: 'draft', dependsOn: '[002]', affectedFiles: '[src/ok.ts]', protectedFiles: '[src/locked.ts]' }, body),
      'briefs/002_b.md': goodBrief(),
      'briefs/archive/001_a.md': goodBrief({ status: 'archived' }),
    });
    const plan = planArchive(corpus, corpus.live[0]!, {
      date: '2026-09-24',
      dirty: ['src/wip.ts'],
      commit: { sha: 'abcdef1234', author: 'A', date: '' },
      changes: [
        { path: 'src/locked.ts', insertions: 1, deletions: 0 },
        { path: 'src/other.ts', insertions: 1, deletions: 0 },
      ],
    });
    expect(table(plan.blocking)).toEqual([
      'briefs/001_a.md:2 error archive-draft: is a draft, and a draft has not been executed | set "status: active" once the round runs',
      'briefs/001_a.md:24 error open-task: "open" is neither ticked nor dispositioned | tick it, or say why under it with a note starting "**Delegated", "**Accepted debt", "**Rejected"',
      'briefs/001_a.md:3 error dependency-open: depends on 002, which is not archived yet | archive 002 first, or drop the dependency if it was never real',
      'briefs/001_a.md:1 error dirty-tree: the working tree has uncommitted changes outside the briefs: src/wip.ts | commit them so the recorded commit holds the round, or pass --allow-dirty',
      'briefs/001_a.md:5 error protected-file: the round changed src/locked.ts, which this brief protects | revert the change, or record the departure in the brief before archiving it',
      'briefs/001_a.md:1 error archive-exists: briefs/archive/001_a.md already exists | an archived brief is never overwritten',
    ]);
    expect(table(plan.warnings)).toEqual([
      'briefs/001_a.md:4 warning out-of-scope: the round changed 1 file(s) outside affectedFiles: src/other.ts | widen affectedFiles if the scope was wrong, or say why in the summary',
    ]);
    const unarchive = planUnarchive(corpus, corpus.archived[0]!);
    expect(table(unarchive.blocking)).toEqual(['briefs/archive/001_a.md:1 error unarchive-exists: briefs/001_a.md already exists | rename one of them first']);
    expect(unarchive.action).toBe('unarchive');
    expect(unarchive.done).toBe(false);
  });

  it('shows five paths and counts the rest', () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief({ affectedFiles: '[x]' }) });
    const paths = ['a', 'b', 'c', 'd', 'e', 'f'];
    const five = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', dirty: paths.slice(0, 5) });
    expect(five.blocking[0]?.message).toBe('the working tree has uncommitted changes outside the briefs: a, b, c, d, e');
    const changes = paths.slice(0, 5).map((path) => ({ path, insertions: 0, deletions: 0 }));
    const scope = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24', commit: { sha: 'a', author: '', date: '' }, changes });
    expect(scope.warnings[0]?.message).toBe('the round changed 5 file(s) outside affectedFiles: a, b, c, d, e');
  });

  it('describes a plan that has nothing to do, whole', () => {
    const corpus = corpusOf({ 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }) });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' });
    expect({ ...plan, brief: plan.brief.file }).toEqual({
      action: 'archive',
      brief: 'briefs/archive/001_a.md',
      from: 'briefs/archive/001_a.md',
      to: 'briefs/archive/001_a.md',
      done: true,
      ops: [],
      blocking: [],
      warnings: [],
      linksRewritten: 0,
      inboundRewritten: [],
      inboundFrozen: [],
      banner: [],
      changes: [],
    });
    const live = planUnarchive(corpusOf({ 'briefs/001_a.md': goodBrief() }), corpusOf({ 'briefs/001_a.md': goodBrief() }).briefs[0]!);
    expect(live.action).toBe('unarchive');
    expect(live.done).toBe(true);
    const request = planArchive(corpusOf({ 'briefs/001_a.md': goodBrief() }), corpusOf({ 'briefs/001_a.md': goodBrief() }).briefs[0]!, { date: '2026-09-24' });
    expect(request.changes).toEqual([]);
    expect(request.warnings).toEqual([]);
    expect(request.inboundFrozen).toEqual([]);
    expect(request.inboundRewritten).toEqual([]);
  });
});

describe('what the terminal shows', () => {
  it('lists briefs with their readiness', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '2' }, '\n- [ ] one more\n'),
      'briefs/002_b.md': goodBrief({ dependsOn: '[001]' }),
      'briefs/003_c.md': goodBrief({ status: 'draft' }),
      'briefs/archive/004_d.md': goodBrief({ status: 'archived' }),
    });
    const rows = corpus.briefs.map((brief) => ({
      brief,
      ready: brief.id === '001',
      waitingOn: brief.id === '002' ? ['001'] : [],
    }));
    expect(prettyList(rows, { color: false }).split('\n')).toEqual([
      'ID   STATUS    WAVE  TASKS  READY      TITLE',
      '001  active    2     1/2    yes        A brief',
      '002  active    -     1/1    after 001  A brief',
      '003  draft     -     1/1    no         A brief',
      '004  archived  -     1/1    -          A brief',
    ]);
    expect(prettyList([], { color: false })).toBe('no briefs');
  });

  it('paints the list header and the matrix marks', () => {
    const esc = String.fromCharCode(27);
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[a]' }), 'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[a]' }) });
    expect(prettyList([{ brief: corpus.briefs[0]!, ready: true, waitingOn: [] }], { color: true }).startsWith(`${esc}[2mID`)).toBe(true);
    expect(prettyMatrix(collisions(corpus), { color: true })).toContain(`${esc}[31mX${esc}[39m`);
  });

  it('shows findings in colour by severity', () => {
    const esc = String.fromCharCode(27);
    const text = prettyFindings(
      [
        { rule: 'r', severity: 'error', message: 'm', file: 'a', line: 1 },
        { rule: 'r', severity: 'warning', message: 'm', file: 'a', line: 2 },
        { rule: 'r', severity: 'note', message: 'm', file: 'a', line: 3, hint: 'h' },
      ],
      { color: true },
    );
    expect(text).toContain(`${esc}[31merror  ${esc}[39m`);
    expect(text).toContain(`${esc}[33mwarning${esc}[39m`);
    expect(text).toContain(`${esc}[36mnote   ${esc}[39m`);
    expect(text).toContain(`${esc}[2mh${esc}[22m`);
    expect(text.startsWith(`${esc}[1ma${esc}[22m`)).toBe(true);
  });

  it('draws a matrix over every live brief, and a wave with names wider than three', () => {
    const corpus = corpusOf({ 'briefs/1000_a.md': goodBrief({ affectedFiles: '[a]' }), 'briefs/1001_b.md': goodBrief({ affectedFiles: '[b]' }) });
    expect(prettyMatrix(collisions(corpus, { all: true }), { color: false }).split('\n')).toEqual([
      'all live briefs \u00b7 2 briefs',
      '        1000  1001',
      '  1000     \u00b7     \u00b7',
      '  1001     \u00b7     \u00b7',
    ]);
    const one = corpusOf({ 'briefs/001_a.md': goodBrief({ wave: '1' }) });
    expect(prettyMatrix(collisions(one), { color: false }).split('\n')[0]).toBe('wave 1 \u00b7 1 brief');
    expect(prettyMatrix(collisions(corpusOf({ 'briefs/001_a.md': goodBrief() })), { color: false })).toBe('no wave: 001');
  });

  it('prints a refused plan with its reasons, and the rewritten and frozen links of an accepted one', () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief({ status: 'draft' }) });
    const refused = prettyPlan(planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' }), false, { color: false });
    expect(refused.split('\n')).toEqual([
      'cannot archive briefs/001_a.md:',
      'briefs/001_a.md',
      '  2  error    is a draft, and a draft has not been executed  archive-draft',
      `${' '.repeat(14)}set "status: active" once the round runs`,
    ]);
    const unarchive = corpusOf({ 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }), 'briefs/001_a.md': goodBrief() });
    expect(prettyPlan(planUnarchive(unarchive, unarchive.archived[0]!), true, { color: false }).split('\n')[0]).toBe('cannot unarchive briefs/archive/001_a.md:');
    const done = corpusOf({ 'briefs/001_a.md': goodBrief() });
    expect(prettyPlan(planUnarchive(done, done.briefs[0]!), false, { color: false })).toBe('briefs/001_a.md is already live; nothing to do');
    const accepted = prettyPlan(planArchive(done, done.briefs[0]!, { date: '2026-09-24' }), true, { color: false }).split('\n');
    expect(accepted).toEqual([
      'would move briefs/001_a.md -> briefs/archive/001_a.md',
      '',
      'banner:',
      '  <!-- spec-brief:banner -->',
      '  > **Archived 2026-09-24.**',
      '  > The body below describes the tree before execution and is not maintained.',
      '  <!-- /spec-brief:banner -->',
    ]);
    const two = corpusOf({ 'briefs/001_a.md': goodBrief({}, '\n[x](x.md) [y](y.md)\n') });
    expect(prettyPlan(planArchive(two, two.briefs[0]!, { date: '2026-09-24' }), false, { color: false }).split('\n')[1]).toBe('  2 relative links rewritten');
  });
});
