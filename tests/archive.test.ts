import { describe, expect, it } from 'vitest';

import { applyPlan, ConflictError, TransactionError } from '../src/apply.js';
import { openTasks, type Plan, planArchive, planUnarchive, renderBanner } from '../src/archive.js';
import { BANNER_CLOSE, BANNER_OPEN } from '../src/brief.js';
import { buildCorpus, type Corpus, findBriefs } from '../src/corpus.js';
import { MemoryFileSystem } from '../src/fs.js';
import type { CommitInfo } from '../src/git.js';
import { integrityOf } from '../src/integrity.js';
import { lint } from '../src/lint.js';
import { config, corpusOf, goodBrief } from './helpers.js';

const A = 'briefs/001_a.md';
const B = 'briefs/002_b.md';
const COMMIT: CommitInfo = { sha: 'abcdef1234567890', author: 'Tester', date: '2026-09-24T00:00:00Z' };

function the(corpus: Corpus, id: string) {
  const found = findBriefs(corpus, id);
  if (found.length !== 1) throw new Error(`expected one ${id}`);
  return found[0]!;
}

function write(plan: Plan, path: string): string {
  const op = plan.ops.find((o) => o.path === path && o.kind === 'write');
  if (op?.kind !== 'write') throw new Error(`no write to ${path}`);
  return op.content;
}

const linked = goodBrief(
  { affectedFiles: '[src/auth/**]', protectedFiles: '[src/db/schema.ts]' },
  '\nSee [b](002_b.md), [docs](../docs/x.md#s) and [web](https://example.com).\n',
);

describe('refusals', () => {
  it('refuses on lint errors of the brief, and not on another brief\'s', async () => {
    const corpus = corpusOf({ [A]: goodBrief({ type: 'epic' }), [B]: goodBrief({ type: 'epic' }) });
    const findings = await lint(corpus);
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', findings });
    expect(plan.blocking.map((f) => [f.rule, f.file])).toEqual([['unknown-type', A]]);
  });

  it('refuses a draft', () => {
    const corpus = corpusOf({ [A]: goodBrief({ status: 'draft' }) });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
    expect(plan.blocking.map((f) => [f.rule, f.line, f.hint])).toEqual([['archive-draft', 2, 'set "status: active" once the round runs']]);
    const noField = corpusOf({ [A]: goodBrief() }, config({ status: { field: null } }));
    expect(planArchive(noField, the(noField, '001'), { date: '2026-09-24' }).blocking).toEqual([]);
  });

  it('refuses open task items, unless a note under one disposes of it', () => {
    const body = '\n## Deliverables\n\n- [ ] open\n- [ ] delegated\n  **Delegated to** brief 9.\n- [ ] rejected\n**Rejected** by the rule.\n- [ ] in code `**Rejected**`\n- [ ]\n';
    const corpus = corpusOf({ [A]: goodBrief({}, body) });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
    expect(plan.blocking.map((f) => f.message)).toEqual([
      '"open" is neither ticked nor dispositioned',
      '"in code `**Rejected**`" is neither ticked nor dispositioned',
      '"(empty)" is neither ticked nor dispositioned',
    ]);
    expect(plan.blocking[0]?.hint).toBe('tick it, or say why under it with a note starting "**Delegated", "**Accepted debt", "**Rejected"');
  });

  it('checks only the configured sections\' tasks when told to', () => {
    const body = '\n## Deliverables\n\n- [ ] open\n\n## Notes\n\n- [ ] ignored\n';
    const scoped = corpusOf({ [A]: goodBrief({}, body) }, config({ archiving: { tasks: ['Deliverables'] } }));
    expect(openTasks(the(scoped, '001'), scoped).map((t) => t.text)).toEqual(['open']);
    const none = corpusOf({ [A]: goodBrief({}, body) }, config({ archiving: { tasks: [] } }));
    expect(openTasks(the(none, '001'), none)).toEqual([]);
  });

  it('refuses while a dependency is live, and not once it is archived', () => {
    const corpus = corpusOf({ [A]: goodBrief({ dependsOn: '[002, 003, 001]' }), [B]: goodBrief(), 'briefs/archive/003_c.md': goodBrief({ status: 'archived' }) });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
    expect(plan.blocking.map((f) => f.message)).toEqual(['depends on 002, which is not archived yet']);
  });

  it('refuses uncommitted work outside the briefs, unless allowed', () => {
    const corpus = corpusOf({ [A]: goodBrief() });
    const dirty = ['briefs/001_a.md', 'briefs/archive/002_x.md', 'src/a.ts', 'b', 'c', 'd', 'e', 'f'];
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', dirty });
    expect(plan.blocking.map((f) => f.message)).toEqual(['the working tree has uncommitted changes outside the briefs: src/a.ts, b, c, d, e, and 1 more']);
    expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', dirty, allowDirty: true }).blocking).toEqual([]);
    expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', dirty: ['src/a.ts'] }).blocking[0]?.message).toBe(
      'the working tree has uncommitted changes outside the briefs: src/a.ts',
    );
    expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', dirty: ['briefs/001_a.md'] }).blocking).toEqual([]);
    // Only briefs are the ceremony: a README beside them, or a brief-shaped file one level down, is work.
    for (const path of ['briefs/README.md', 'briefs/sub/003_c.md']) {
      expect(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', dirty: [path] }).blocking.map((f) => f.rule), path).toEqual(['dirty-tree']);
    }
    const excluding = corpusOf({ [A]: goodBrief() }, config({ exclude: ['00*'] }));
    expect(planArchive(excluding, the(excluding, '001'), { date: '2026-09-24', dirty: ['briefs/00_INDEX.md'] }).blocking.map((f) => f.rule)).toEqual(['dirty-tree']);
  });

  it('refuses a change to a protected file, and reports it once', () => {
    const corpus = corpusOf({ [A]: linked });
    const changes = [
      { path: 'src/db/schema.ts', insertions: 1, deletions: 0 },
      { path: 'src/auth/a.ts', insertions: 1, deletions: 0 },
      { path: 'briefs/001_a.md', insertions: 3, deletions: 1 },
    ];
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT, changes });
    expect(plan.blocking.map((f) => [f.rule, f.line])).toEqual([['protected-file', 4]]);
    expect(plan.warnings).toEqual([]);
  });

  it('warns on changes outside the scope, and refuses them under --strict', () => {
    const corpus = corpusOf({ [A]: linked });
    const changes = ['src/auth/a.ts', 'lib/1', 'lib/2', 'lib/3', 'lib/4', 'lib/5', 'lib/6'].map((path) => ({ path, insertions: 1, deletions: 1 }));
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT, changes });
    expect(plan.blocking).toEqual([]);
    expect(plan.warnings.map((f) => [f.rule, f.severity, f.line, f.message])).toEqual([
      ['out-of-scope', 'warning', 3, 'the round changed 6 file(s) outside affectedFiles: lib/1, lib/2, lib/3, lib/4, lib/5, and 1 more'],
    ]);
    const strict = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT, changes: changes.slice(0, 2), strict: true });
    expect(strict.blocking.map((f) => [f.rule, f.severity, f.message])).toEqual([['out-of-scope', 'error', 'the round changed 1 file(s) outside affectedFiles: lib/1']]);
    const unscoped = corpusOf({ [A]: goodBrief() });
    expect(planArchive(unscoped, the(unscoped, '001'), { date: '2026-09-24', commit: COMMIT, changes }).warnings).toEqual([]);
  });

  it('treats a changed path as a file, whatever its name', () => {
    const corpus = corpusOf({ [A]: goodBrief({ protectedFiles: '[Makefile]' }) });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT, changes: [{ path: 'Makefile', insertions: 1, deletions: 0 }] });
    expect(plan.blocking.map((f) => f.rule)).toEqual(['protected-file']);
  });

  it('refuses to overwrite an archived brief of the same name', () => {
    const corpus = corpusOf({ [A]: goodBrief(), 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }) });
    const live = corpus.live[0]!;
    expect(planArchive(corpus, live, { date: '2026-09-24' }).blocking.map((f) => f.rule)).toEqual(['archive-exists']);
  });
});

describe('the archived text', () => {
  it('moves the file, sets the status, writes the banner and the freeze, and rewrites links', () => {
    const corpus = corpusOf({ [A]: linked, [B]: goodBrief({}, '\nAfter [one](001_a.md#top).\n') });
    const changes = [{ path: 'src/auth/a.ts', insertions: 10, deletions: 2 }, { path: 'src/auth/b.png', insertions: null, deletions: null }];
    const plan = planArchive(corpus, the(corpus, '001'), {
      date: '2026-09-24',
      summary: '  Tokens rotate.  ',
      pr: { number: 42, url: 'https://github.com/o/r/pull/42' },
      commit: COMMIT,
      changes,
    });
    expect(plan.blocking).toEqual([]);
    expect(plan.to).toBe('briefs/archive/001_a.md');
    expect(plan.ops.map((o) => [o.kind, o.path])).toEqual([
      ['write', 'briefs/archive/001_a.md'],
      ['write', B],
      ['remove', A],
    ]);
    const text = write(plan, 'briefs/archive/001_a.md');
    const hash = /integrity: (sha256-[0-9a-f]{64})/.exec(text)?.[1];
    expect(hash).toBe(integrityOf(text));
    expect(text.replace(hash as string, 'HASH')).toBe(
      [
        '---',
        'status: archived',
        'affectedFiles: [src/auth/**]',
        'protectedFiles: [src/db/schema.ts]',
        'integrity: HASH',
        '---',
        '',
        BANNER_OPEN,
        '> **Archived 2026-09-24.**',
        '> Tokens rotate.',
        '> Merged in pull request [#42](https://github.com/o/r/pull/42).',
        '> Recorded at commit `abcdef1`: 2 files changed, +10 \u221212.'.replace('\u221212', '\u22122'),
        '> Relative links were rewritten to resolve from `briefs/archive/` (2); no other word changed.',
        '> The body below describes the tree before execution and is not maintained.',
        BANNER_CLOSE,
        '',
        '# A brief',
        '',
        '## Intent',
        '',
        'The tree is better.',
        '',
        '## Negative Scope',
        '',
        '- Nothing else changes.',
        '',
        '## Invariants',
        '',
        '- [x] the tests pass',
        '',
        'See [b](../002_b.md), [docs](../../docs/x.md#s) and [web](https://example.com).',
        '',
      ].join('\n'),
    );
    expect(write(plan, B)).toContain('After [one](archive/001_a.md#top).');
    expect(plan.inboundRewritten).toEqual([B]);
    expect(plan.linksRewritten).toBe(2);
  });

  it('leaves out banner lines it has nothing for, and keeps a bare pull-request number', () => {
    const corpus = corpusOf({ [A]: goodBrief() });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', pr: { number: 7, url: null } });
    expect(plan.banner).toEqual([
      BANNER_OPEN,
      '> **Archived 2026-09-24.**',
      '> Merged in pull request #7.',
      '> The body below describes the tree before execution and is not maintained.',
      BANNER_CLOSE,
    ]);
  });

  it('counts one file in the singular, and leaves the diffstat out without changes', () => {
    const corpus = corpusOf({ [A]: goodBrief() });
    const one = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT, changes: [{ path: 'x', insertions: 1, deletions: 0 }] });
    expect(one.banner).toContain('> Recorded at commit `abcdef1`: 1 file changed, +1 \u22120.');
    const bare = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT });
    expect(bare.banner.some((l) => l.includes('Recorded'))).toBe(false);
  });

  it('fills every placeholder a configured banner may use, and a blank line stays a quote line', () => {
    const cfg = config({ archiving: { banner: ['{id} {title} by {author} on {date}', '', 'end'] } });
    const corpus = corpusOf({ [A]: goodBrief() }, cfg);
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', commit: COMMIT });
    expect(plan.banner).toEqual([BANNER_OPEN, '> 001 A brief by Tester on 2026-09-24', '>', '> end', BANNER_CLOSE]);
    expect(renderBanner(['{nothing}', 'kept'], {})).toEqual([BANNER_OPEN, '> kept', BANNER_CLOSE]);
  });

  it('keeps CRLF and a byte-order mark, adds front matter where there is none, and can skip the freeze and the links', () => {
    const cfg = config({ archiving: { freeze: false, rewriteLinks: false } });
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}${goodBrief().replace(/\n/g, '\r\n')}[x](y.md)\r\n`;
    const corpus = corpusOf({ [A]: text }, cfg);
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
    const out = write(plan, 'briefs/archive/001_a.md');
    expect(out.startsWith(`${bom}---\r\nstatus: archived\r\n---\r\n\r\n${BANNER_OPEN}\r\n`)).toBe(true);
    expect(out).not.toContain('integrity');
    expect(out).toContain('[x](y.md)');
    expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);

    const bare = corpusOf({ [A]: '# Bare\n' }, config({ status: { field: null }, sections: [], types: {} }));
    const barePlan = planArchive(bare, the(bare, '001'), { date: '2026-09-24' });
    expect(write(barePlan, 'briefs/archive/001_a.md').startsWith(`---\nintegrity: sha256-`)).toBe(true);
    const archivedBare = buildCorpus([{ path: 'briefs/archive/001_a.md', text: write(barePlan, 'briefs/archive/001_a.md'), phase: 'archived' }], bare.config);
    expect(archivedBare.archived[0]?.integrity).toBe(integrityOf(write(barePlan, 'briefs/archive/001_a.md')));
  });

  it('puts the banner at the top of a file with no front matter, and separates it from the title', () => {
    const cfg = config({ status: { field: null }, archiving: { freeze: false } });
    const corpus = corpusOf({ [A]: '# Bare\n' }, cfg);
    const out = write(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' }), 'briefs/archive/001_a.md');
    expect(out.split('\n').slice(0, 1)).toEqual([BANNER_OPEN]);
    expect(out).toContain(`${BANNER_CLOSE}\n\n# Bare`);
  });

  it('reports links archived briefs hold to the old path, and leaves them frozen', () => {
    const corpus = corpusOf({ [A]: goodBrief(), 'briefs/archive/000_z.md': goodBrief({ status: 'archived' }, '\n[a](../001_a.md)\n') });
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' });
    expect(plan.inboundFrozen).toEqual([{ file: 'briefs/archive/000_z.md', line: 19 }]);
    expect(plan.ops.some((o) => o.path === 'briefs/archive/000_z.md')).toBe(false);
  });

  it('replaces a stale banner rather than stacking a second one', () => {
    const stale = goodBrief().replace('# A brief', `${BANNER_OPEN}\n> old\n${BANNER_CLOSE}\n\n# A brief`);
    const corpus = corpusOf({ [A]: stale });
    const out = write(planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' }), 'briefs/archive/001_a.md');
    expect(out.split(BANNER_OPEN).length).toBe(2);
    expect(out).not.toContain('> old');
  });

  it('does nothing for a brief that is already archived', () => {
    const corpus = corpusOf({ 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }) });
    const plan = planArchive(corpus, corpus.briefs[0]!, { date: '2026-09-24' });
    expect(plan.done).toBe(true);
    expect(plan.ops).toEqual([]);
    expect(plan.from).toBe(plan.to);
  });
});

describe('reopening', () => {
  it('restores the brief it archived, byte for byte, and the links other briefs hold to it', () => {
    const original = { [A]: linked, [B]: goodBrief({}, '\nAfter [one](001_a.md).\n') };
    const corpus = corpusOf(original);
    const plan = planArchive(corpus, the(corpus, '001'), { date: '2026-09-24', summary: 'Done.', commit: COMMIT, changes: [] });
    const after = corpusOf({ 'briefs/archive/001_a.md': write(plan, 'briefs/archive/001_a.md'), [B]: write(plan, B) });
    const back = planUnarchive(after, the(after, '001'));
    expect(back.blocking).toEqual([]);
    expect(back.to).toBe(A);
    expect(write(back, A)).toBe(linked);
    expect(write(back, B)).toBe(original[B]);
    expect(back.ops.map((o) => [o.kind, o.path])).toEqual([
      ['write', A],
      ['write', B],
      ['remove', 'briefs/archive/001_a.md'],
    ]);
  });

  it('reopens a brief archived by hand, whose banner has no markers', () => {
    const byHand = '---\nstatus: archived\n---\n\n> **Executed.**\n\n# T\n\n[x](../../docs/a.md)\n';
    const corpus = corpusOf({ 'briefs/archive/001_a.md': byHand }, config({ status: { active: 'proposed', draft: null } }));
    const plan = planUnarchive(corpus, corpus.briefs[0]!);
    expect(write(plan, A)).toBe('---\nstatus: proposed\n---\n\n> **Executed.**\n\n# T\n\n[x](../docs/a.md)\n');
  });

  it('refuses to overwrite a live brief of the same name, and does nothing for a live brief', () => {
    const corpus = corpusOf({ [A]: goodBrief(), 'briefs/archive/001_a.md': goodBrief({ status: 'archived' }) });
    expect(planUnarchive(corpus, corpus.archived[0]!).blocking.map((f) => f.rule)).toEqual(['unarchive-exists']);
    const live = planUnarchive(corpus, corpus.live[0]!);
    expect(live.done).toBe(true);
    expect(live.action).toBe('unarchive');
  });

  it('removes a banner at the very top and the blank line after it', () => {
    const cfg = config({ status: { field: null }, archiving: { rewriteLinks: false } });
    const corpus = corpusOf({ 'briefs/archive/001_a.md': `${BANNER_OPEN}\n> x\n${BANNER_CLOSE}\n\n# T\n` }, cfg);
    expect(write(planUnarchive(corpus, corpus.briefs[0]!), A)).toBe('# T\n');
  });
});

describe('the transaction', () => {
  function planFor(files: Record<string, string>): { fs: MemoryFileSystem; plan: Plan } {
    const corpus = corpusOf(files);
    return { fs: new MemoryFileSystem(files), plan: planArchive(corpus, the(corpus, '001'), { date: '2026-09-24' }) };
  }

  it('applies every operation in order', async () => {
    const { fs, plan } = planFor({ [A]: goodBrief(), [B]: goodBrief({}, '\n[a](001_a.md)\n') });
    await applyPlan(fs, plan.ops);
    expect([...fs.files.keys()].sort()).toEqual([B, 'briefs/archive/001_a.md']);
    expect(fs.files.get(B)).toContain('archive/001_a.md');
  });

  it('changes nothing when a file moved on since the plan was made', async () => {
    const { fs, plan } = planFor({ [A]: goodBrief() });
    fs.files.set(A, 'edited meanwhile');
    await expect(applyPlan(fs, plan.ops)).rejects.toBeInstanceOf(ConflictError);
    expect(fs.files.get(A)).toBe('edited meanwhile');
    expect(fs.files.has('briefs/archive/001_a.md')).toBe(false);
    const { fs: other, plan: again } = planFor({ [A]: goodBrief() });
    other.files.set('briefs/archive/001_a.md', 'appeared');
    await expect(applyPlan(other, again.ops)).rejects.toThrow('briefs/archive/001_a.md changed after the plan was made');
  });

  it('rolls back every completed operation when a later one fails', async () => {
    const files = { [A]: goodBrief(), [B]: goodBrief({}, '\n[a](001_a.md)\n') };
    const { fs, plan } = planFor(files);
    fs.fail = (operation, path) => operation === 'remove' && path === A;
    const error = await applyPlan(fs, plan.ops).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as TransactionError).rolledBack).toBe(true);
    expect((error as TransactionError).message).toBe(`injected failure removing ${A}; every change was rolled back`);
    expect(Object.fromEntries(fs.files)).toEqual(files);
  });

  it('restores a removed file when a write after it fails', async () => {
    const fs = new MemoryFileSystem({ a: '1', b: '2' });
    fs.fail = (operation, path) => operation === 'write' && path === 'c';
    await expect(
      applyPlan(fs, [
        { kind: 'remove', path: 'a', before: '1' },
        { kind: 'write', path: 'b', content: 'new', before: '2' },
        { kind: 'write', path: 'c', content: 'x', before: null },
      ]),
    ).rejects.toThrow('every change was rolled back');
    expect(Object.fromEntries(fs.files)).toEqual({ a: '1', b: '2' });
  });

  it('says so when the rollback fails too, and names the files', async () => {
    const fs = new MemoryFileSystem({ a: '1' });
    let failures = 0;
    fs.fail = (operation, path) => {
      if (operation === 'write' && path === 'b') return true;
      if (operation === 'write' && path === 'a') failures += 1;
      return operation === 'write' && path === 'a' && failures > 1;
    };
    const error = await applyPlan(fs, [
      { kind: 'write', path: 'a', content: '2', before: '1' },
      { kind: 'write', path: 'b', content: 'x', before: null },
    ]).catch((e: unknown) => e);
    expect((error as TransactionError).rolledBack).toBe(false);
    expect((error as TransactionError).failures).toEqual(['a: injected failure writing a']);
    expect((error as Error).message).toBe('injected failure writing b; the rollback also failed (a: injected failure writing a), so check these files by hand');
  });

  it('describes a failure that is not an Error', async () => {
    const fs = new MemoryFileSystem({});
    fs.write = () => Promise.reject('plain string');
    const error = await applyPlan(fs, [{ kind: 'write', path: 'x', content: '', before: null }]).catch((e: unknown) => e);
    expect((error as Error).message).toBe('plain string; every change was rolled back');
  });

  it('reports a rollback step that throws something that is not an Error', async () => {
    const fs = new MemoryFileSystem({ a: '1' });
    const write = fs.write.bind(fs);
    let calls = 0;
    fs.write = (path, content) => {
      calls += 1;
      if (calls === 1) return write(path, content);
      return Promise.reject(calls === 2 ? new Error('second write') : 'undo refused');
    };
    const error = await applyPlan(fs, [
      { kind: 'write', path: 'a', content: '2', before: '1' },
      { kind: 'write', path: 'b', content: 'x', before: null },
    ]).catch((e: unknown) => e);
    expect((error as TransactionError).failures).toEqual(['a: undo refused']);
  });
});
