import { describe, expect, it } from 'vitest';

import { planArchive, planUnarchive, type Plan } from '../src/archive.js';
import { BANNER_CLOSE, BANNER_OPEN } from '../src/brief.js';
import { collisionFindings, collisions } from '../src/collisions.js';
import { type Corpus, findBriefs } from '../src/corpus.js';
import { BriefEngine } from '../src/engine.js';
import { MemoryFileSystem } from '../src/fs.js';
import type { Git } from '../src/git.js';
import { checkRuleIds, lint, ruleIds } from '../src/lint.js';
import { linksOf, scan } from '../src/markdown.js';
import { matrixJson, prettyMatrix } from '../src/report.js';
import { inWords } from '../src/text.js';
import type { Finding } from '../src/types.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';

/**
 * Defects found by reviews, each held here by the input that showed it: one of
 * 0.1.0 before its release, and one after it.
 */

const A = 'briefs/001_a.md';
const B = 'briefs/002_b.md';
const DATE = '2026-09-24';

const table = (findings: readonly Finding[]): string[] =>
  findings.map((f) => `${f.file}:${f.line} ${f.severity} ${f.rule}: ${f.message}${f.hint === undefined ? '' : ` | ${f.hint}`}`);

function the(corpus: Corpus, id: string) {
  return findBriefs(corpus, id)[0]!;
}

function written(plan: Plan, path: string): string {
  const op = plan.ops.find((o) => o.path === path);
  if (op?.kind !== 'write') throw new Error(`no write to ${path}`);
  return op.content;
}

function roundTrip(files: Record<string, string>, cfg = config()): { archived: string; back: string; other: Record<string, string> } {
  const corpus = corpusOf(files, cfg);
  const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
  expect(plan.blocking).toEqual([]);
  const archivedPath = `${cfg.archive}/001_a.md`;
  const after: Record<string, string> = { [archivedPath]: written(plan, archivedPath) };
  for (const [path] of Object.entries(files)) if (path !== A) after[path] = plan.ops.some((o) => o.path === path) ? written(plan, path) : (files[path] as string);
  const reopened = corpusOf(after, cfg);
  const back = planUnarchive(reopened, the(reopened, '001'));
  const other: Record<string, string> = {};
  for (const path of Object.keys(files)) if (path !== A) other[path] = back.ops.some((o) => o.path === path) ? written(back, path) : (after[path] as string);
  return { archived: after[archivedPath] as string, back: written(back, A), other };
}

describe('regressions', () => {
  it('does not take banner markers quoted in a code block for a banner', () => {
    const quoted = goodBrief({}, `\n\`\`\`md\n${BANNER_OPEN}\n> an example\n${BANNER_CLOSE}\n\`\`\`\n`);
    expect(brief(quoted).banner).toBeNull();
    const corpus = corpusOf({ [A]: quoted });
    const out = written(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' }), 'briefs/archive/001_a.md');
    expect(out).toContain(`\`\`\`md\n${BANNER_OPEN}\n> an example\n${BANNER_CLOSE}\n\`\`\``);
  });

  it('does not read a footnote, or prose shaped like a definition, as a link', () => {
    const s = scan(['[^1]: Measured on the build server.', '[Note]: this is important', '[ok]: ../x.md "a title"', "[ok2]: <y z.md> 'title'", '[ok3]: w.md (title)']);
    expect(linksOf(s).map((l) => l.target)).toEqual(['../x.md', 'y z.md', 'w.md']);
    const corpus = corpusOf({ [A]: goodBrief({}, '\n[^1]: Measured on the build server.\n[Note]: this is important\n') });
    const out = written(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' }), 'briefs/archive/001_a.md');
    expect(out).toContain('[^1]: Measured on the build server.\n[Note]: this is important\n');
  });

  it('keeps every safety check when the briefs live at the root', async () => {
    const cfg = config({ briefs: '.', archive: 'done' });
    const corpus = corpusOf({ '001_a.md': goodBrief({ protectedFiles: '[src/locked.ts]' }) }, cfg);
    const plan = planArchive(corpus, corpus.briefs[0]!, {
      date: '2026-09-24',
      dirty: ['src/wip.ts'],
      commit: { sha: 'abcdef1', author: 'A', date: '' },
      changes: [{ path: 'src/locked.ts', insertions: 1, deletions: 0 }],
    });
    expect(plan.to).toBe('done/001_a.md');
    expect(plan.blocking.map((f) => f.rule)).toEqual(['dirty-tree', 'protected-file']);
    const archived = corpusOf({ 'done/001_a.md': goodBrief({ status: 'archived' }), '001_a.md': goodBrief() }, cfg);
    expect(planUnarchive(archived, archived.archived[0]!).blocking.map((f) => f.rule)).toEqual(['unarchive-exists']);
    expect(planUnarchive(archived, archived.archived[0]!).to).toBe('001_a.md');
    expect(await lint(corpus)).toEqual([]);
  });

  it('does not let a note under a nested box close its parent', () => {
    const body = '\n- [ ] Migrate the database\n  - [ ] Also migrate the cache\n    **Rejected**: out of scope\n';
    const corpus = corpusOf({ [A]: goodBrief({}, body) });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
    expect(plan.blocking.map((f) => f.message)).toEqual(['"Migrate the database" is neither ticked nor dispositioned']);
  });

  it('does not refuse on a box that is an example inside a fence in a list item', () => {
    const body = '\n- [x] Write the guide\n  - with an example:\n\n    ```md\n    - [ ] write the thing\n    ```\n';
    const corpus = corpusOf({ [A]: goodBrief({}, body) });
    expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' }).blocking).toEqual([]);
  });

  it('restores blank lines and a missing final newline exactly on reopening', () => {
    const tight = goodBrief().replace('---\n\n# A brief', '---\n# A brief').replace(/\n$/, '');
    const { back } = roundTrip({ [A]: tight });
    expect(back).toBe(tight);
    const spaced = goodBrief().replace('---\n\n# A brief', '---\n\n\n# A brief');
    expect(roundTrip({ [A]: spaced }).back).toBe(spaced);
  });

  it('writes the banner after the blank line that follows the front matter', () => {
    const { archived } = roundTrip({ [A]: goodBrief() });
    expect(archived).toContain(`---\n\n${BANNER_OPEN}\n`);
    expect(archived).toContain(`${BANNER_CLOSE}\n\n# A brief`);
  });

  it('refuses under --strict an archival that lint --strict would fail', async () => {
    const corpus = corpusOf({ [A]: goodBrief({ owner: 'x' }) });
    const findings = await lint(corpus);
    expect(findings.map((f) => f.severity)).toEqual(['warning']);
    expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', findings }).blocking).toEqual([]);
    expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', findings, strict: true }).blocking.map((f) => f.rule)).toEqual(['unknown-field']);
  });
});

describe('regressions after 0.1.0', () => {
  const COMMIT = { sha: 'abcdef1234567890', author: 'A', date: '' };
  const scoped = goodBrief({ affectedFiles: '[src/auth/**]', protectedFiles: '[src/db/schema.ts]' });
  const UNREAD =
    'briefs/001_a.md:4 warning scope-unmeasured: protectedFiles and affectedFiles went unchecked: no commit or base was named, so the files the round changed were not read' +
    ' | pass --commit <rev> for the commit the round landed as, or --base <rev> for the branch it started from, or set "archiving.base"';

  /** Git that knows one commit, already in the base branch: its merge base with any base is itself. */
  function mergedGit(calls: string[]): Git {
    return {
      commit: (rev) => {
        calls.push(`commit ${rev}`);
        return Promise.resolve({ sha: 'feedface00000000', author: 'A', date: '' });
      },
      mergeBase: (a, b) => {
        calls.push(`merge-base ${a} ${b}`);
        return Promise.resolve(b);
      },
      changes: (from, to) => {
        calls.push(`changes ${from ?? 'parent'} ${to}`);
        return Promise.resolve([]);
      },
      dirty: () => Promise.resolve([]),
      files: () => Promise.resolve(['src/auth/a.ts', 'src/db/schema.ts']),
      remoteUrl: () => Promise.resolve(null),
    };
  }

  function engineOver(files: Record<string, string>, git: Git | null, archiving: Record<string, unknown> = {}): BriefEngine {
    return new BriefEngine({ root: '/virtual', config: config({ archiving }), configFile: null, fs: new MemoryFileSystem(files), git, plugins: [] });
  }

  it('does not pass a scope it never measured, and refuses it under --strict', () => {
    const corpus = corpusOf({ [A]: scoped });
    const plan = planArchive(corpus, the(corpus, '001'), { date: DATE });
    expect(plan.blocking).toEqual([]);
    expect(table(plan.warnings)).toEqual([UNREAD]);
    expect(table(planArchive(corpus, the(corpus, '001'), { date: DATE, strict: true }).blocking)).toEqual([UNREAD.replace(' warning ', ' error ')]);
    // Only the scope the brief declares is named, at its own line.
    const affected = corpusOf({ [A]: goodBrief({ affectedFiles: '[src/**]' }) });
    expect(table(planArchive(affected, the(affected, '001'), { date: DATE }).warnings)[0]).toMatch(
      /^briefs\/001_a\.md:3 warning scope-unmeasured: affectedFiles went unchecked: /,
    );
    const guarded = corpusOf({ [A]: goodBrief({ protectedFiles: '[src/**]' }) });
    expect(table(planArchive(guarded, the(guarded, '001'), { date: DATE }).warnings)[0]).toMatch(
      /^briefs\/001_a\.md:3 warning scope-unmeasured: protectedFiles went unchecked: /,
    );
    // A brief with no scope has nothing to check, and a round whose changes
    // were read was measured, even one that changed nothing but briefs.
    const unscoped = corpusOf({ [A]: goodBrief() });
    expect(planArchive(unscoped, the(unscoped, '001'), { date: DATE }).warnings).toEqual([]);
    const briefsOnly = [{ path: A, insertions: 1, deletions: 1 }];
    expect(planArchive(corpus, the(corpus, '001'), { date: DATE, commit: COMMIT, changes: briefsOnly }).warnings).toEqual([]);
    expect(planArchive(corpus, the(corpus, '001'), { date: DATE, changes: [] }).warnings).toEqual([]);
  });

  it('does not pass a round archived on its base branch after the merge', async () => {
    const calls: string[] = [];
    const engine = engineOver({ [A]: scoped }, mergedGit(calls), { base: 'main' });
    await engine.load();
    const plan = await engine.planArchive('1', { date: DATE });
    // The diff from a commit to itself is empty, so it is not asked for.
    expect(calls).toEqual(['commit HEAD', 'merge-base main feedface00000000']);
    expect(plan.blocking).toEqual([]);
    expect(table(plan.warnings)).toEqual([
      'briefs/001_a.md:4 warning scope-unmeasured: protectedFiles and affectedFiles went unchecked: feedfac is already in main, so the diff from their merge base is empty' +
        " | archive on the round's branch before it merges, or pass --base <rev> naming the commit the round started from",
    ]);
    // Nothing was measured, so the banner claims no diffstat.
    expect(plan.changes).toEqual([]);
    expect(plan.banner.some((line) => line.includes('Recorded at commit'))).toBe(false);
    const strict = await engine.planArchive('1', { date: DATE, strict: true, commit: 'v1', base: 'release' });
    expect(table(strict.blocking)).toEqual([
      'briefs/001_a.md:4 error scope-unmeasured: protectedFiles and affectedFiles went unchecked: feedfac is already in release, so the diff from their merge base is empty' +
        " | archive on the round's branch before it merges, or pass --base <rev> naming the commit the round started from",
    ]);
  });

  it('does not pass a scope when git is left out, or is not there', async () => {
    const calls: string[] = [];
    const engine = engineOver({ [A]: scoped }, mergedGit(calls), { base: 'main' });
    await engine.load();
    const without =
      'briefs/001_a.md:4 warning scope-unmeasured: protectedFiles and affectedFiles went unchecked: without git, the files the round changed cannot be read' +
      ' | archive inside the git work tree without --no-git, and name the round with --commit <rev> or --base <rev>';
    expect(table((await engine.planArchive('1', { date: DATE, noGit: true })).warnings)).toEqual([without]);
    expect(calls).toEqual([]);
    const gitless = engineOver({ [A]: scoped }, null);
    await gitless.load();
    expect(table((await gitless.planArchive('1', { date: DATE })).warnings)).toEqual([without]);
    const unnamed = engineOver({ [A]: scoped }, mergedGit(calls));
    await unnamed.load();
    expect(table((await unnamed.planArchive('1', { date: DATE })).warnings)).toEqual([UNREAD]);
  });

  it('knows the archive rules by name, so configuration can set them', () => {
    expect(ruleIds()).toEqual(expect.arrayContaining(['scope-unmeasured', 'stale-link']));
    expect(() => checkRuleIds(corpusOf({}, config({ rules: { 'scope-unmeasured': 'error', 'stale-link': 'off' } })))).not.toThrow();
  });

  it('takes the severity of an unmeasured scope from the configuration', () => {
    const plan = (severity: string, strict = false): Plan => {
      const corpus = corpusOf({ [A]: scoped }, config({ rules: { 'scope-unmeasured': severity } }));
      return planArchive(corpus, the(corpus, '001'), { date: DATE, strict });
    };
    expect(plan('off').warnings).toEqual([]);
    expect(plan('off').blocking).toEqual([]);
    expect(plan('error').blocking.map((f) => [f.rule, f.severity])).toEqual([['scope-unmeasured', 'error']]);
    expect(plan('note', true).blocking).toEqual([]);
    expect(plan('note', true).warnings.map((f) => [f.rule, f.severity])).toEqual([['scope-unmeasured', 'note']]);
  });
});

describe('dispositions, after 0.1.0', () => {
  const open = (body: string): string[] => {
    const corpus = corpusOf({ [A]: goodBrief({}, `\n- [ ] Migrate the cache\n${body}\n`) });
    return planArchive(corpus, the(corpus, '001'), { date: DATE }).blocking.map((f) => f.message);
  };
  const OPEN = ['"Migrate the cache" is neither ticked nor dispositioned'];

  it('does not take a marker in the task itself for a note closing it', () => {
    // The input the review archived with: the marker is a word in the task.
    const corpus = corpusOf({ [A]: goodBrief({}, '\n- [ ] Explain why the **Rejected** designs failed\n') });
    expect(planArchive(corpus, the(corpus, '001'), { date: DATE }).blocking.map((f) => [f.rule, f.message])).toEqual([
      ['open-task', '"Explain why the **Rejected** designs failed" is neither ticked nor dispositioned'],
    ]);
  });

  it('closes a box only with a note that starts with a marker', () => {
    const words = [
      '  see the **Rejected** list',
      '  `x` **Rejected** after a code span',
      '  <!-- aside --> **Rejected** after a comment',
      '  > **Rejected** in a quote',
      '  ```\n  **Rejected** in a fence\n  ```',
      '  -**Rejected** with no space after the marker',
      // A sibling item is not a note under the box.
      '- **Rejected** as a sibling item',
    ];
    for (const note of words) expect(open(note), note).toEqual(OPEN);
  });

  it('closes a box with a note under it, indented, as a bullet or a numbered item, or folded into it', () => {
    const notes = [
      '  **Rejected** by the rule.',
      '\t**Rejected** by the rule.',
      '  - **Delegated to** 012',
      '  -   **Delegated to** 012, after several spaces',
      '  * **Accepted debt**: after the release',
      '  + **Rejected**',
      '  1. **Rejected**',
      '  12) **Rejected**',
      '**Rejected** because it folds into the item',
      '  First the context.\n  **Rejected** on the second line',
      '\n  **Rejected** after a blank line',
    ];
    for (const note of notes) expect(open(note), note).toEqual([]);
  });
});

describe('links with rewriting off, after 0.1.0', () => {
  const off = config({ archiving: { rewriteLinks: false } });
  const STALE =
    'warning stale-link: links on 2 line(s) of other live briefs will stop resolving when it moves: briefs/002_b.md:19, briefs/003_c.md:19' +
    ' | turn "archiving.rewriteLinks" on to have them rewritten, or fix them by hand';
  const files = {
    [A]: goodBrief({}, '\n[docs](../docs/x.md)\n'),
    [B]: goodBrief({}, '\nAfter [one](001_a.md#top) and [again](./001_a.md).\n'),
    'briefs/003_c.md': goodBrief({}, '\n[a](001_a.md)\n'),
    'briefs/archive/000_z.md': goodBrief({ status: 'archived' }, '\n[a](../001_a.md)\n'),
  };

  it('writes no other brief, and names the links it leaves behind', () => {
    // The input the review archived with: the plan still wrote briefs/002_b.md.
    const corpus = corpusOf(files, off);
    const plan = planArchive(corpus, the(corpus, '001'), { date: DATE });
    expect(plan.ops.map((o) => [o.kind, o.path])).toEqual([
      ['write', 'briefs/archive/001_a.md'],
      ['remove', A],
    ]);
    expect(plan.inboundRewritten).toEqual([]);
    expect(plan.inboundFrozen).toEqual([{ file: 'briefs/archive/000_z.md', line: 19 }]);
    expect(written(plan, 'briefs/archive/001_a.md')).toContain('[docs](../docs/x.md)');
    expect(plan.blocking).toEqual([]);
    expect(table(plan.warnings)).toEqual([`${A}:1 ${STALE}`]);
    expect(table(planArchive(corpus, the(corpus, '001'), { date: DATE, strict: true }).blocking)).toEqual([`${A}:1 ${STALE.replace('warning', 'error')}`]);
    // Rewriting on, the same links are rewritten and nothing is reported.
    const on = corpusOf(files);
    const rewritten = planArchive(on, the(on, '001'), { date: DATE });
    expect(rewritten.inboundRewritten).toEqual([B, 'briefs/003_c.md']);
    expect(rewritten.warnings).toEqual([]);
  });

  it('reopens under the same switch', () => {
    const archived = corpusOf({ 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }), [B]: goodBrief({}, '\n[a](archive/001_a.md)\n') }, off);
    const back = planUnarchive(archived, the(archived, '001'));
    expect(back.ops.map((o) => [o.kind, o.path])).toEqual([
      ['write', A],
      ['remove', 'briefs/archive/001_a.md'],
    ]);
    expect(table(back.warnings)).toEqual([
      'briefs/archive/001_a.md:1 warning stale-link: links on 1 line(s) of other live briefs will stop resolving when it moves: briefs/002_b.md:19' +
        ' | turn "archiving.rewriteLinks" on to have them rewritten, or fix them by hand',
    ]);
    expect(back.blocking).toEqual([]);
    expect(planUnarchive(archived, the(archived, '001'), { strict: true }).blocking.map((f) => [f.rule, f.severity])).toEqual([['stale-link', 'error']]);
  });

  it('takes the severity of a stale link from the configuration', () => {
    const quiet = corpusOf(files, config({ archiving: { rewriteLinks: false }, rules: { 'stale-link': 'off' } }));
    const plan = planArchive(quiet, the(quiet, '001'), { date: DATE, strict: true });
    expect(plan.warnings).toEqual([]);
    expect(plan.blocking).toEqual([]);
    const loud = corpusOf(files, config({ archiving: { rewriteLinks: false }, rules: { 'stale-link': 'error' } }));
    expect(planArchive(loud, the(loud, '001'), { date: DATE }).blocking.map((f) => f.rule)).toEqual(['stale-link']);
  });

  it('names five places and counts the rest', () => {
    const many = Object.fromEntries(['002_b', '003_c', '004_d', '005_e', '006_f', '007_g'].map((n) => [`briefs/${n}.md`, goodBrief({}, '\n[a](001_a.md)\n')]));
    const corpus = corpusOf({ [A]: goodBrief(), ...many }, off);
    expect(planArchive(corpus, the(corpus, '001'), { date: DATE }).warnings[0]?.message).toBe(
      'links on 6 line(s) of other live briefs will stop resolving when it moves: briefs/002_b.md:19, briefs/003_c.md:19, briefs/004_d.md:19, briefs/005_e.md:19, briefs/006_f.md:19, and 1 more',
    );
  });
});

describe('collisions, after 0.1.0', () => {
  // Three pairs of patterns meet between two briefs: one defect, fixed once.
  const files = {
    [A]: goodBrief({ wave: '1', affectedFiles: '[src/**, docs/**, lib/a.ts]' }),
    [B]: goodBrief({ wave: '1', affectedFiles: '[src/x.ts, docs/y.md, "lib/**"]' }),
    'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[etc/c.ts]' }),
    'briefs/004_d.md': goodBrief({ affectedFiles: '[src/**]' }),
  };

  it('reports a pair of briefs once, with every pair of patterns that meets', () => {
    const corpus = corpusOf(files);
    const report = collisions(corpus);
    expect(report.waves[0]?.collisions.map((c) => [c.a.id, c.b.id, c.overlaps])).toEqual([
      [
        '001',
        '002',
        [
          { patterns: ['src/**', 'src/x.ts'], witness: 'src/x.ts' },
          { patterns: ['docs/**', 'docs/y.md'], witness: 'docs/y.md' },
          { patterns: ['lib/a.ts', 'lib/**'], witness: 'lib/a.ts' },
        ],
      ],
    ]);
    expect(table(collisionFindings(corpus, report))).toEqual([
      'briefs/002_b.md:4 error collision: overlaps 001 in wave 1 through 3 pairs of patterns: ' +
        '"src/x.ts" and 001\'s "src/**" both cover src/x.ts; "docs/y.md" and 001\'s "docs/**" both cover docs/y.md; "lib/**" and 001\'s "lib/a.ts" both cover lib/a.ts' +
        ' | run them in different waves, make one depend on the other, or narrow a scope',
    ]);
    expect(prettyMatrix(report, { color: false }).split('\n')).toEqual([
      'wave 1 \u00b7 3 briefs',
      '       001  002  003',
      '  001    \u00b7    X    \u00b7',
      '  002    X    \u00b7    \u00b7',
      '  003    \u00b7    \u00b7    \u00b7',
      '  X 001 "src/**" and 002 "src/x.ts" both cover src/x.ts',
      '    001 "docs/**" and 002 "docs/y.md" both cover docs/y.md',
      '    001 "lib/a.ts" and 002 "lib/**" both cover lib/a.ts',
      '',
      'no wave: 004',
    ]);
    expect(matrixJson(report)).toEqual({
      waves: [
        {
          wave: 1,
          briefs: ['001', '002', '003'],
          collisions: [
            {
              a: '001',
              b: '002',
              overlaps: [
                { patterns: ['src/**', 'src/x.ts'], witness: 'src/x.ts' },
                { patterns: ['docs/**', 'docs/y.md'], witness: 'docs/y.md' },
                { patterns: ['lib/a.ts', 'lib/**'], witness: 'lib/a.ts' },
              ],
            },
          ],
          undecided: [],
          sharedDirectories: [],
          unscoped: [],
        },
      ],
      unscheduled: ['004'],
      deferred: [],
    });
  });

  it('reports a pair writing into several directories once, naming them all', () => {
    const corpus = corpusOf(
      {
        [A]: goodBrief({ wave: '1', affectedFiles: '[x/1.ts, y/1.ts, z/1.ts]' }),
        [B]: goodBrief({ wave: '1', affectedFiles: '[x/2.ts, y/2.ts, z/2.ts]' }),
        'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[y/3.ts]' }),
      },
      config({ rules: { 'shared-directory': 'warning' } }),
    );
    const report = collisions(corpus);
    expect(report.waves[0]?.shared.map((s) => [s.a.id, s.b.id, s.directories])).toEqual([
      ['001', '002', ['x', 'y', 'z']],
      ['001', '003', ['y']],
      ['002', '003', ['y']],
    ]);
    expect(collisionFindings(corpus, report).map((f) => [f.file, f.message])).toEqual([
      [B, 'writes into x/, y/ and z/, as 001 does in wave 1'],
      ['briefs/003_c.md', 'writes into y/, as 001 does in wave 1'],
      ['briefs/003_c.md', 'writes into y/, as 002 does in wave 1'],
    ]);
    expect(prettyMatrix(report, { color: false })).toContain('  ~ 001 and 002 both write into x/, y/ and z/');
    const unscoped = collisions(corpusOf({ [A]: goodBrief({ wave: '1', affectedFiles: '[x/1.ts]' }), [B]: goodBrief({ wave: '1', affectedFiles: '[x/2.ts]' }), 'briefs/003_c.md': goodBrief({ wave: '1' }) }));
    expect(matrixJson(unscoped)).toEqual({
      waves: [{ wave: 1, briefs: ['001', '002', '003'], collisions: [], undecided: [], sharedDirectories: [{ a: '001', b: '002', directories: ['x'] }], unscoped: ['003'] }],
      unscheduled: [],
      deferred: [],
    });
    expect(inWords(['a/', 'b/'])).toBe('a/ and b/');
    expect(inWords([])).toBe('');
  });
});
