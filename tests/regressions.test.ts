import { describe, expect, it } from 'vitest';

import { planArchive, planUnarchive, type Plan } from '../src/archive.js';
import { BANNER_CLOSE, BANNER_OPEN } from '../src/brief.js';
import { type Corpus, findBriefs } from '../src/corpus.js';
import { lint } from '../src/lint.js';
import { linksOf, scan } from '../src/markdown.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';

/**
 * Defects found by a review of 0.1.0 before its release, each held here by the
 * input that showed it.
 */

const A = 'briefs/001_a.md';

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
