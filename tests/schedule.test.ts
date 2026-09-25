import { describe, expect, it } from 'vitest';

import { collisions } from '../src/collisions.js';
import { buildCorpus, type Corpus } from '../src/corpus.js';
import { lint } from '../src/lint.js';
import { prettySchedule, scheduleJson } from '../src/report.js';
import { byId, moves, planWaves, reasons, schedule, scheduleFindings } from '../src/schedule.js';
import type { Finding } from '../src/types.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';

/**
 * Waves by precedence-constrained greedy colouring. The placements are
 * asserted whole, and a generated corpus holds every schedule to what the
 * matrix and lint say about it once it is written.
 */

const B = (n: number, name = 'x'): string => `briefs/${String(n).padStart(3, '0')}_${name}.md`;

const placed = (corpus: Corpus, options = {}): [string, number | null, number][] =>
  schedule(corpus, options).placements.map((p) => [p.brief.id as string, p.declared, p.proposed]);

const table = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `${f.file}:${f.line} ${f.severity} ${f.rule}: ${f.message}${f.hint === undefined ? '' : ` | ${f.hint}`}`);

describe('placing briefs', () => {
  it('puts each into the lowest wave after its dependencies, taking them in dependency order and then by id', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[a/**]', dependsOn: '[3]' }),
      [B(2)]: goodBrief({ affectedFiles: '[b/**]' }),
      [B(3)]: goodBrief({ affectedFiles: '[c/**]' }),
      [B(4)]: goodBrief({ affectedFiles: '[d/**]', dependsOn: '[1, 2]' }),
    });
    expect(placed(corpus)).toEqual([
      ['002', null, 1],
      ['003', null, 1],
      ['001', null, 2],
      ['004', null, 3],
    ]);
    const after = schedule(corpus).placements.find((p) => p.brief.id === '004')?.after;
    expect([after?.brief.id, after?.wave]).toEqual(['001', 2]);
  });

  it('keeps two briefs that can write one file apart, and says which file', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[src/auth/**]' }),
      [B(2)]: goodBrief({ affectedFiles: '["src/**/session.ts"]' }),
      [B(3)]: goodBrief({ affectedFiles: '[docs/**]' }),
    });
    const s = schedule(corpus);
    expect(placed(corpus)).toEqual([
      ['001', null, 1],
      ['002', null, 2],
      ['003', null, 1],
    ]);
    expect(s.placements[1]?.passed).toEqual([
      { wave: 1, reason: 'collision', brief: s.placements[0]?.brief, overlaps: [{ patterns: ['src/**/session.ts', 'src/auth/**'], witness: 'src/auth/session.ts' }] },
    ]);
  });

  it('lets two briefs share a wave when one protects the only file both cover', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[src/**]', protectedFiles: '[src/db/schema.ts]' }),
      [B(2)]: goodBrief({ affectedFiles: '[src/db/schema.ts]' }),
    });
    expect(placed(corpus)).toEqual([
      ['001', null, 1],
      ['002', null, 1],
    ]);
  });

  it('gives a brief with no scope a wave of its own, and no other brief its wave', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[a/**]' }),
      [B(2)]: goodBrief(),
      [B(3)]: goodBrief({ affectedFiles: '[b/**]' }),
    });
    const s = schedule(corpus);
    expect(placed(corpus)).toEqual([
      ['001', null, 1],
      ['002', null, 2],
      ['003', null, 1],
    ]);
    expect(s.placements[1]?.unscoped).toBe(true);
    expect(s.placements[1]?.passed.map((p) => [p.wave, p.reason, p.brief.id])).toEqual([[1, 'unscoped', '001']]);
    const later = corpusOf({ [B(1)]: goodBrief(), [B(2)]: goodBrief({ affectedFiles: '[a/**]' }) });
    expect(schedule(later).placements[1]?.passed.map((p) => [p.wave, p.reason, p.brief.id])).toEqual([[1, 'unscoped', '001']]);
  });

  it('starts at the lowest declared wave, or at 1', () => {
    const corpus = corpusOf({ [B(1)]: goodBrief({ wave: '4', affectedFiles: '[a]' }), [B(2)]: goodBrief({ wave: '7', affectedFiles: '[b]' }) });
    expect(schedule(corpus).first).toBe(4);
    expect(placed(corpus)).toEqual([
      ['001', 4, 4],
      ['002', 7, 4],
    ]);
    expect(schedule(corpusOf({ [B(1)]: goodBrief({ wave: '0' }) })).first).toBe(0);
    expect(schedule(corpusOf({ [B(1)]: goodBrief() })).first).toBe(1);
  });

  it('counts an archived dependency as done, and leaves an unknown one or itself to lint', () => {
    const corpus = corpusOf({
      'briefs/archive/001_a.md': goodBrief({ status: 'archived' }),
      [B(2)]: goodBrief({ affectedFiles: '[a]', dependsOn: '[1, 404, 2]' }),
    });
    expect(placed(corpus)).toEqual([['002', null, 1]]);
    expect(schedule(corpus).placements[0]?.after).toBeNull();
  });

  it('schedules drafts, and leaves deferred briefs out with the briefs that wait on them', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ status: 'draft', affectedFiles: '[a]' }),
      [B(2)]: goodBrief({ status: 'deferred', trigger: 'when x', affectedFiles: '[a]' }),
      [B(3)]: goodBrief({ affectedFiles: '[c]', dependsOn: '[2]' }),
      [B(4)]: goodBrief({ affectedFiles: '[d]', dependsOn: '[3]' }),
    });
    const s = schedule(corpus);
    expect(placed(corpus)).toEqual([['001', null, 1]]);
    expect(s.deferred.map((b) => b.id)).toEqual(['002']);
    expect(s.unplaced.map((u) => [u.brief.id, u.waitsOn.id, u.because])).toEqual([
      ['003', '002', 'deferred'],
      ['004', '003', 'unplaced'],
    ]);
    expect(s.cycles).toEqual([]);
  });

  it('places nothing in a dependency cycle or after one, and names the cycle', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[a]', dependsOn: '[2]' }),
      [B(2)]: goodBrief({ affectedFiles: '[b]', dependsOn: '[1]' }),
      [B(3)]: goodBrief({ affectedFiles: '[c]', dependsOn: '[2]' }),
      [B(4)]: goodBrief({ affectedFiles: '[d]' }),
      [B(5)]: goodBrief({ status: 'deferred', trigger: 'when y', dependsOn: '[6]' }),
      [B(6)]: goodBrief({ affectedFiles: '[f]', dependsOn: '[5]' }),
    });
    const s = schedule(corpus);
    expect(placed(corpus)).toEqual([['004', null, 1]]);
    // A cycle through a deferred brief is the deferral's to break, not the schedule's.
    expect(s.cycles.map((c) => c.map((b) => b.id))).toEqual([['001', '002', '001']]);
    expect(s.unplaced.map((u) => [u.brief.id, u.waitsOn.id, u.because])).toEqual([
      ['001', '002', 'cycle'],
      ['002', '001', 'cycle'],
      ['003', '002', 'cycle'],
      ['006', '005', 'deferred'],
    ]);
  });

  it('keeps apart a pair the search could not decide, and says so', () => {
    const corpus = corpusOf({ [B(1)]: goodBrief({ affectedFiles: '[src/**]' }), [B(2)]: goodBrief({ affectedFiles: '["**/*.ts"]' }) });
    const s = schedule(corpus, { budget: 1 });
    expect(placed(corpus, { budget: 1 })).toEqual([
      ['001', null, 1],
      ['002', null, 2],
    ]);
    expect(s.placements[1]?.passed).toEqual([{ wave: 1, reason: 'undecided', brief: s.placements[0]?.brief, patterns: [['**/*.ts', 'src/**']] }]);
  });

  it('reads literal paths from the tree', () => {
    const corpus = corpusOf({ [B(1)]: goodBrief({ affectedFiles: '[build]' }), [B(2)]: goodBrief({ affectedFiles: '["**/*.js"]' }) });
    expect(placed(corpus).map(([, , wave]) => wave)).toEqual([1, 1]);
    expect(placed(corpus, { repoFiles: ['build/out.js'] }).map(([, , wave]) => wave)).toEqual([1, 2]);
  });
});

describe('the order of briefs', () => {
  it('is by id, numbers by value, then by path', () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    const briefs = ['10', '9', 'b', 'a', '9'].map((id, i) => brief(goodBrief({ id }), `briefs/${i}.md`, 'live', cfg));
    expect([...briefs].sort(byId).map((b) => `${b.id}@${b.file}`)).toEqual(['9@briefs/1.md', '9@briefs/4.md', '10@briefs/0.md', 'a@briefs/3.md', 'b@briefs/2.md']);
    expect(byId(briefs[1]!, briefs[1]!)).toBe(0);
    expect(byId(briefs[4]!, briefs[1]!)).toBeGreaterThan(0);
    expect(byId(briefs[1]!, briefs[4]!)).toBeLessThan(0);
    const unnamed = brief(goodBrief(), 'briefs/zz.md', 'live', cfg);
    expect(byId(unnamed, briefs[0]!)).toBeGreaterThan(0);
  });
});

describe('why a brief goes where it goes', () => {
  it('says so in a clause per constraint', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[src/**]' }),
      [B(2)]: goodBrief(),
      [B(3)]: goodBrief({ affectedFiles: '[src/a.ts]', dependsOn: '[5]' }),
      [B(4)]: goodBrief({ affectedFiles: '[lib/**]' }),
      [B(5)]: goodBrief({ affectedFiles: '[lib/x.ts]', wave: '1' }),
    });
    const s = schedule(corpus);
    expect(s.placements.map((p) => [p.brief.id, p.proposed, reasons(p)])).toEqual([
      ['001', 1, ['nothing holds it later']],
      ['002', 2, ['it declares no affectedFiles, so it runs in a wave of its own']],
      ['004', 1, ['nothing holds it later']],
      ['005', 3, ['not wave 1, where 004 also writes lib/x.ts ("lib/x.ts" and "lib/**")', 'not wave 2, where 002 declares no affectedFiles and runs alone']],
      ['003', 4, ['after 005, in wave 3']],
    ]);
    const undecided = schedule(corpusOf({ [B(1)]: goodBrief({ affectedFiles: '[src/**]' }), [B(2)]: goodBrief({ affectedFiles: '["**/*.ts"]' }) }), { budget: 1 });
    expect(reasons(undecided.placements[1]!)).toEqual(['not wave 1, where 001 may write the same files: the search could not decide within its budget']);
  });
});

describe('what schedule says', () => {
  const corpus = corpusOf({
    [B(1)]: goodBrief({ wave: '1', affectedFiles: '[src/**]' }),
    [B(2)]: goodBrief({ wave: '1', affectedFiles: '[src/a.ts]' }),
    [B(3)]: goodBrief({ wave: '1' }),
    [B(4)]: goodBrief({ wave: '1', affectedFiles: '[a]', dependsOn: '[5]' }),
    [B(5)]: goodBrief({ affectedFiles: '[b]', dependsOn: '[4]' }),
    [B(6)]: goodBrief({ status: 'deferred', trigger: 'when x' }),
    [B(7)]: goodBrief({ affectedFiles: '[c]', dependsOn: '[6]' }),
  });
  const s = schedule(corpus);

  it('as findings: a cycle, each move with its reasons, and a brief that runs alone', () => {
    expect(table(scheduleFindings(corpus, s))).toEqual([
      'briefs/004_x.md:5 error dependency-cycle: dependencies form a cycle, so no wave can hold them: 004 -> 005 -> 004 | a cycle can never become ready; remove the dependency that is not real',
      'briefs/002_x.md:3 error wave-schedule: declares wave 1; the schedule puts it in wave 2: not wave 1, where 001 also writes src/a.ts ("src/a.ts" and "src/**") | run "spec-brief schedule --write", or set "wave: 2"',
      'briefs/003_x.md:3 error wave-schedule: declares wave 1; the schedule puts it in wave 3: it declares no affectedFiles, so it runs in a wave of its own | run "spec-brief schedule --write", or set "wave: 3"',
      'briefs/003_x.md:1 note unscoped: declares no affectedFiles, so it cannot be checked against the 2 other brief(s) the schedule places; it runs alone in wave 3 | list the files or globs this round writes under "affectedFiles"',
    ]);
  });

  it('as findings, only the rules configuration leaves on', () => {
    const quiet = corpusOf(
      Object.fromEntries(corpus.briefs.map((b) => [b.file, b.text])),
      config({ rules: { 'dependency-cycle': 'off', 'wave-schedule': 'warning', unscoped: 'off' } }),
    );
    expect(scheduleFindings(quiet, schedule(quiet)).map((f) => [f.rule, f.severity])).toEqual([
      ['wave-schedule', 'warning'],
      ['wave-schedule', 'warning'],
    ]);
    const alone = corpusOf({ [B(1)]: goodBrief() });
    expect(scheduleFindings(alone, schedule(alone)).map((f) => f.rule)).toEqual(['wave-schedule']);
  });

  it('as undecided findings, the occupant first as the matrix names it', () => {
    const pair = corpusOf({ [B(1)]: goodBrief({ wave: '1', affectedFiles: '[src/**]' }), [B(2)]: goodBrief({ wave: '2', affectedFiles: '["**/*.ts"]' }) });
    expect(table(scheduleFindings(pair, schedule(pair, { budget: 1 })))).toEqual([
      'briefs/002_x.md:4 warning collision-undecided: whether it can write a file 001 writes in wave 1 is undecided: the search met its budget for "**/*.ts" and 001\'s "src/**" | narrow one of the patterns, or run the two in different waves',
    ]);
    const off = corpusOf(Object.fromEntries(pair.briefs.map((b) => [b.file, b.text])), config({ rules: { 'collision-undecided': 'off' } }));
    expect(scheduleFindings(off, schedule(off, { budget: 1 }))).toEqual([]);
  });

  it('to a person', () => {
    expect(prettySchedule(s, null, { color: false }).split('\n')).toEqual([
      'wave 1 · 1 brief',
      '  001  A brief',
      'wave 2 · 1 brief',
      '  002  A brief  moves from wave 1',
      '         not wave 1, where 001 also writes src/a.ts ("src/a.ts" and "src/**")',
      'wave 3 · 1 brief',
      '  003  A brief  moves from wave 1',
      '         it declares no affectedFiles, so it runs in a wave of its own',
      '',
      'cycle: 004 -> 005 -> 004',
      'waits: 004 on 005, which is in a cycle',
      'waits: 005 on 004, which is in a cycle',
      'waits: 007 on 006, which is deferred',
      'deferred: 006',
      '2 briefs would move; "spec-brief schedule --write" writes the waves',
    ]);
    expect(prettySchedule(s, [], { color: false }).split('\n').at(-1)).toBe('nothing was written: the dependencies form a cycle');
    expect(prettySchedule(s, ['briefs/002_x.md'], { color: false }).split('\n').at(-1)).toBe('wrote the wave of 1 brief: briefs/002_x.md');
    const settled = corpusOf({ [B(1)]: goodBrief({ wave: '1', affectedFiles: '[a]' }) });
    expect(prettySchedule(schedule(settled), null, { color: false }).split('\n').at(-1)).toBe('the declared waves hold');
    const unclosed = corpusOf({ [B(1)]: '---\nstatus: active\n' });
    expect(prettySchedule(schedule(unclosed), [], { color: false }).split('\n').at(-1)).toBe('nothing was written: a front matter cannot be edited');
    expect(prettySchedule(schedule(corpusOf({})), null, { color: false })).toBe('no live briefs');
    const chain = corpusOf({
      [B(1)]: goodBrief({ status: 'deferred', trigger: 'when x' }),
      [B(2)]: goodBrief({ dependsOn: '[1]' }),
      [B(3)]: goodBrief({ dependsOn: '[2]' }),
    });
    expect(prettySchedule(schedule(chain), null, { color: false }).split('\n')).toEqual([
      'waits: 002 on 001, which is deferred',
      'waits: 003 on 002, which is not placed',
      'deferred: 001',
    ]);
    expect(prettySchedule(schedule(corpusOf({ [B(6)]: goodBrief({ status: 'deferred', trigger: 'when x' }) })), null, { color: false })).toBe('deferred: 006');
    const esc = String.fromCharCode(27);
    expect(prettySchedule(s, null, { color: true })).toContain(`${esc}[33mmoves from wave 1${esc}[39m`);
  });

  it('to a machine', () => {
    expect(scheduleJson(s)).toEqual({
      first: 1,
      waves: [
        { wave: 1, briefs: ['001'] },
        { wave: 2, briefs: ['002'] },
        { wave: 3, briefs: ['003'] },
      ],
      briefs: [
        { id: '001', file: 'briefs/001_x.md', declared: 1, proposed: 1, moves: false, after: null, passed: [], unscoped: false, reasons: ['nothing holds it later'] },
        {
          id: '002',
          file: 'briefs/002_x.md',
          declared: 1,
          proposed: 2,
          moves: true,
          after: null,
          passed: [{ wave: 1, reason: 'collision', brief: '001', overlaps: [{ patterns: ['src/a.ts', 'src/**'], witness: 'src/a.ts' }] }],
          unscoped: false,
          reasons: ['not wave 1, where 001 also writes src/a.ts ("src/a.ts" and "src/**")'],
        },
        {
          id: '003',
          file: 'briefs/003_x.md',
          declared: 1,
          proposed: 3,
          moves: true,
          after: null,
          passed: [
            { wave: 1, reason: 'unscoped', brief: '001' },
            { wave: 2, reason: 'unscoped', brief: '002' },
          ],
          unscoped: true,
          reasons: ['it declares no affectedFiles, so it runs in a wave of its own'],
        },
      ],
      unplaced: [
        { id: '004', file: 'briefs/004_x.md', waitsOn: '005', because: 'cycle' },
        { id: '005', file: 'briefs/005_x.md', waitsOn: '004', because: 'cycle' },
        { id: '007', file: 'briefs/007_x.md', waitsOn: '006', because: 'deferred' },
      ],
      cycles: [['004', '005', '004']],
      deferred: ['006'],
    });
    const pair = schedule(corpusOf({ [B(1)]: goodBrief({ affectedFiles: '[src/**]' }), [B(2)]: goodBrief({ affectedFiles: '["**/*.ts"]', dependsOn: '[1]' }) }), { budget: 1 });
    expect((scheduleJson(pair)['briefs'] as unknown[])[1]).toMatchObject({ after: { brief: '001', wave: 1 }, passed: [] });
    const undecided = schedule(corpusOf({ [B(1)]: goodBrief({ affectedFiles: '[src/**]' }), [B(2)]: goodBrief({ affectedFiles: '["**/*.ts"]' }) }), { budget: 1 });
    expect((scheduleJson(undecided)['briefs'] as unknown[])[1]).toMatchObject({ passed: [{ wave: 1, reason: 'undecided', brief: '001', patterns: [['**/*.ts', 'src/**']] }] });
  });
});

describe('the edges of the schedule', () => {
  it('names the earliest of two dependencies in one wave as the one it runs after', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[a]' }),
      [B(2)]: goodBrief({ affectedFiles: '[b]' }),
      [B(3)]: goodBrief({ affectedFiles: '[c]', dependsOn: '[2, 1]' }),
    });
    const after = schedule(corpus).placements[2]?.after;
    expect([after?.brief.id, after?.wave]).toEqual(['001', 1]);
  });

  it('says nothing holds a brief with no scope that found its wave empty', () => {
    const corpus = corpusOf({ [B(1)]: goodBrief(), [B(2)]: goodBrief({ affectedFiles: '[a]' }) });
    expect(schedule(corpus).placements.map((p) => [p.brief.id, p.proposed, reasons(p)])).toEqual([
      ['001', 1, ['nothing holds it later']],
      ['002', 2, ['not wave 1, where 001 declares no affectedFiles and runs alone']],
    ]);
  });

  it('writes each finding for its brief, a move from no wave, and every reason', () => {
    const corpus = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[src/**]', dependsOn: '[2]' }),
      [B(2)]: goodBrief({ affectedFiles: '[b]', wave: '1', dependsOn: '[1]' }),
      [B(3)]: goodBrief({ affectedFiles: '[lib/**]', wave: '1' }),
      [B(4)]: goodBrief({ affectedFiles: '[lib/a.ts, src/x.ts]' }),
      [B(5)]: goodBrief({ affectedFiles: '[docs/**]', dependsOn: '[3]' }),
    });
    const findings = scheduleFindings(corpus, schedule(corpus));
    expect(findings.map((f) => [f.rule, f.brief, f.message])).toEqual([
      ['dependency-cycle', '001', 'dependencies form a cycle, so no wave can hold them: 001 -> 002 -> 001'],
      ['wave-schedule', '004', 'declares no wave; the schedule puts it in wave 2: not wave 1, where 003 also writes lib/a.ts ("lib/a.ts" and "lib/**")'],
      ['wave-schedule', '005', 'declares no wave; the schedule puts it in wave 2: after 003, in wave 1'],
    ]);
    const crowded = corpusOf({
      [B(1)]: goodBrief({ affectedFiles: '[a/**]', wave: '1' }),
      [B(2)]: goodBrief({ affectedFiles: '[b/**]', wave: '2', dependsOn: '[1]' }),
      [B(3)]: goodBrief({ affectedFiles: '[b/x, a/y]', wave: '1', dependsOn: '[1]' }),
    });
    expect(scheduleFindings(crowded, schedule(crowded)).map((f) => f.message)).toEqual([
      'declares wave 1; the schedule puts it in wave 3: after 001, in wave 1; not wave 2, where 002 also writes b/x ("b/x" and "b/**")',
    ]);
    const off = corpusOf(Object.fromEntries(corpus.briefs.map((b) => [b.file, b.text])), config({ rules: { 'wave-schedule': 'off' } }));
    expect(scheduleFindings(off, schedule(off)).map((f) => f.rule)).toEqual(['dependency-cycle']);
  });

  it('writes a wave into an empty brief, keeping the empty line it had', () => {
    const corpus = corpusOf({ [B(1)]: '' }, config({ status: { field: null } }));
    expect(planWaves(schedule(corpus)).ops.map((op) => (op.kind === 'write' ? op.content : ''))).toEqual(['---\nwave: 1\n---\n\n']);
  });

  it('draws ids and titles of every width in their columns, in colour on a terminal', () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    const corpus = corpusOf(
      {
        'briefs/a.md': goodBrief({ id: '7', title: 'Short', affectedFiles: '[a]', wave: '1' }),
        'briefs/b.md': goodBrief({ id: '1000', title: 'A longer title', affectedFiles: '[a]' }),
        'briefs/c.md': goodBrief({ id: '8', title: 'Mid title', affectedFiles: '[a]', wave: '3' }),
      },
      cfg,
    );
    expect(prettySchedule(schedule(corpus), null, { color: false }).split('\n')).toEqual([
      'wave 1 · 1 brief',
      '  7     Short',
      'wave 2 · 1 brief',
      '  8     Mid title       moves from wave 3',
      '          not wave 1, where 7 also writes a ("a" and "a")',
      'wave 3 · 1 brief',
      '  1000  A longer title  moves from no wave',
      '          not wave 1, where 7 also writes a ("a" and "a")',
      '          not wave 2, where 8 also writes a ("a" and "a")',
      '',
      '2 briefs would move; "spec-brief schedule --write" writes the waves',
    ]);
    const esc = String.fromCharCode(27);
    const painted = prettySchedule(schedule(corpus), null, { color: true });
    expect(painted).toContain(`${esc}[1mwave 1 · 1 brief${esc}[22m`);
    expect(painted).toContain(`${esc}[2mnot wave 1, where 7 also writes a ("a" and "a")${esc}[22m`);
    const cycle = corpusOf({ [B(1)]: goodBrief({ dependsOn: '[2]' }), [B(2)]: goodBrief({ dependsOn: '[1]' }), [B(3)]: goodBrief({ status: 'deferred', trigger: 'when x' }), [B(4)]: goodBrief({ dependsOn: '[3]' }) });
    expect(prettySchedule(schedule(cycle), [], { color: true }).split('\n')).toEqual([
      `${esc}[31mcycle:${esc}[39m 001 -> 002 -> 001`,
      `${esc}[2mwaits:${esc}[22m 001 on 002, which is in a cycle`,
      `${esc}[2mwaits:${esc}[22m 002 on 001, which is in a cycle`,
      `${esc}[2mwaits:${esc}[22m 004 on 003, which is deferred`,
      `${esc}[2mdeferred: 003${esc}[22m`,
    ]);
    const onlyCycle = corpusOf({ [B(1)]: goodBrief({ dependsOn: '[2]' }), [B(2)]: goodBrief({ dependsOn: '[1]' }) });
    expect(prettySchedule(schedule(onlyCycle), null, { color: false }).split('\n')).toEqual([
      'cycle: 001 -> 002 -> 001',
      'waits: 001 on 002, which is in a cycle',
      'waits: 002 on 001, which is in a cycle',
    ]);
  });

  it('says what it wrote, what it could not, and that waves already written hold', () => {
    const corpus = corpusOf({ [B(1)]: goodBrief({ affectedFiles: '[a]' }), [B(2)]: goodBrief({ affectedFiles: '[a]' }) });
    const s = schedule(corpus);
    const esc = String.fromCharCode(27);
    expect(prettySchedule(s, [B(1), B(2)], { color: false }).split('\n').at(-1)).toBe(`wrote the wave of 2 briefs: ${B(1)}, ${B(2)}`);
    const unclosed = corpusOf({ [B(1)]: '---\nstatus: active\n' });
    expect(prettySchedule(schedule(unclosed), [], { color: true }).split('\n').at(-1)).toBe(`${esc}[31mnothing was written: a front matter cannot be edited${esc}[39m`);
    const settled = corpusOf({ [B(1)]: goodBrief({ wave: '1', affectedFiles: '[a]' }) });
    expect(prettySchedule(schedule(settled), [], { color: false }).split('\n').at(-1)).toBe('the declared waves hold');
    const waiting = corpusOf({ [B(1)]: goodBrief({ status: 'deferred', trigger: 'when x' }), [B(2)]: goodBrief({ status: 'deferred', trigger: 'when y' }) });
    expect(prettySchedule(schedule(waiting), null, { color: false })).toBe('deferred: 001, 002');
  });

  it('gives a wave passed over for an unscoped brief no patterns or overlaps in JSON', () => {
    const corpus = corpusOf({ [B(1)]: goodBrief(), [B(2)]: goodBrief({ affectedFiles: '[a]' }) });
    const briefs = scheduleJson(schedule(corpus))['briefs'] as { passed: Record<string, unknown>[] }[];
    expect(briefs[1]?.passed.map((p) => Object.keys(p))).toEqual([['wave', 'reason', 'brief']]);
  });
});

describe('writing the waves', () => {
  it('sets the wave of each brief that moves, and touches no other line', () => {
    const one = goodBrief({ wave: '"x"', affectedFiles: '[a]' }).replace('status: active', 'status: active # the round');
    const corpus = corpusOf({
      [B(1)]: one,
      [B(2)]: goodBrief({ affectedFiles: '[a]' }),
      [B(3)]: goodBrief({ wave: '1', affectedFiles: '[b]' }),
    });
    const plan = planWaves(schedule(corpus));
    expect(plan.refused).toEqual([]);
    expect(plan.ops.map((op) => op.path)).toEqual([B(1), B(2)]);
    const [first, second] = plan.ops.map((op) => (op.kind === 'write' ? op : { content: '', before: null }));
    expect(first?.before).toBe(one);
    expect(first?.content).toBe(one.replace('wave: "x"', 'wave: 1'));
    expect(second?.content).toBe(goodBrief({ affectedFiles: '[a]' }).replace('affectedFiles: [a]\n', 'affectedFiles: [a]\nwave: 2\n'));
  });

  it('keeps a byte-order mark, CRLF and a missing final newline, and gives a brief with no front matter one', () => {
    const cfg = config({ status: { field: null } });
    const crlf = `﻿${goodBrief({ affectedFiles: '[a]' }).replace(/\n/g, '\r\n').trimEnd()}`;
    const bare = '# T\n\n## Intent\n\nx\n';
    const corpus = corpusOf({ [B(1)]: crlf, [B(2)]: bare }, cfg);
    const plan = planWaves(schedule(corpus));
    expect(plan.ops.map((op) => (op.kind === 'write' ? op.content : ''))).toEqual([
      crlf.replace('affectedFiles: [a]\r\n', 'affectedFiles: [a]\r\nwave: 1\r\n'),
      `---\nwave: 2\n---\n${bare}`,
    ]);
  });

  it('refuses a front matter that is never closed', () => {
    const corpus = corpusOf({ [B(1)]: '---\nstatus: active\naffectedFiles: [a]\n' });
    expect(planWaves(schedule(corpus))).toEqual({
      ops: [],
      refused: [
        {
          rule: 'front-matter',
          severity: 'error',
          message: 'the front matter is never closed, so wave 1 cannot be written into it',
          file: B(1),
          line: 1,
          brief: '001',
          hint: 'close the front matter with a "---" line, and schedule again',
        },
      ],
    });
  });

  /**
   * Checked against the matrix and lint rather than against itself: every
   * schedule of a generated corpus, once written, has no collision and no
   * wave-order finding, keeps each unscoped brief alone, and is its own
   * schedule - writing it again would change nothing.
   */
  it('writes waves the matrix finds no collision in and lint finds in order, and that schedule to themselves', async () => {
    let seed = 20260926;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const patterns = ['src/**', 'src/a/**', 'src/a/x.ts', 'src/*.ts', 'lib/**', 'lib/y.ts', 'docs/**', '**/*.md', 'test/**', 'src/b/'];
    const seen = { shared: 0, moved: 0, passed: 0 };
    for (let round = 0; round < 25; round += 1) {
      const count = 3 + random(6);
      const files: Record<string, string> = {};
      for (let i = 1; i <= count; i += 1) {
        const scope = Array.from({ length: random(3) }, () => patterns[random(patterns.length)] as string);
        // Dependencies point at lower ids only, so the graph has no cycle.
        const deps = Array.from({ length: i > 1 ? random(3) : 0 }, () => 1 + random(i - 1));
        const front: Record<string, string> = { affectedFiles: JSON.stringify(scope) };
        if (deps.length > 0) front['dependsOn'] = `[${[...new Set(deps)].join(', ')}]`;
        if (random(3) === 0) front['protectedFiles'] = JSON.stringify([patterns[random(patterns.length)]]);
        if (random(2) === 0) front['wave'] = String(1 + random(3));
        files[B(i)] = goodBrief(front);
      }
      const corpus = corpusOf(files);
      const s = schedule(corpus);
      expect(s.placements, JSON.stringify(files)).toHaveLength(count);
      const written = { ...files };
      for (const op of planWaves(s).ops) if (op.kind === 'write') written[op.path] = op.content;
      const after = buildCorpus(
        Object.entries(written).map(([path, text]) => ({ path, text, phase: 'live' as const })),
        corpus.config,
      );
      const label = JSON.stringify(Object.fromEntries(after.briefs.map((b) => [b.id, [b.wave, b.affectedFiles, b.protectedFiles, b.dependsOn]])));
      const matrix = collisions(after);
      expect(matrix.waves.flatMap((w) => w.collisions), label).toEqual([]);
      expect(matrix.waves.flatMap((w) => w.undecided), label).toEqual([]);
      for (const wave of matrix.waves) {
        if (wave.briefs.some((b) => b.affectedFiles.length === 0)) expect(wave.briefs, label).toHaveLength(1);
      }
      expect((await lint(after)).filter((f) => f.rule === 'wave-order'), label).toEqual([]);
      expect(moves(schedule(after)), label).toEqual([]);
      seen.shared += matrix.waves.filter((w) => w.briefs.length > 1).length;
      seen.moved += moves(s).length;
      seen.passed += s.placements.filter((p) => p.passed.length > 0).length;
    }
    // The corpus exercises sharing a wave, moving and passing one over, not only the easy case.
    expect(seen).toEqual({ shared: 23, moved: 81, passed: 54 });
  });
});
