import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, HELP, main, parse, UsageError } from '../src/cli.js';
import { commitAll, goodBrief, initRepo, Sink, tempDir, writeTree } from './helpers.js';

const made: string[] = [];
function dir(name: string): string {
  const d = tempDir(name);
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string;
  err: string;
}

async function run(cwd: string, args: string[], env: Record<string, string | undefined> = {}, tty = false): Promise<Result> {
  const stdout = new Sink();
  stdout.isTTY = tty;
  const stderr = new Sink();
  // A directory with no repository gets --no-git, so the suite does not spawn
  // git to learn what it already knows. The engine tests cover discovery.
  const git = existsSync(join(cwd, '.git')) || args.includes('--no-git') || cwd === process.cwd() ? [] : ['--no-git'];
  const code = await main([...args, ...git], { stdout, stderr, cwd, env: { SOURCE_DATE_EPOCH: '1790208000', ...env } });
  return { code, out: stdout.text, err: stderr.text };
}

/** A directory with a configuration and no git: most commands need nothing more. */
function plain(name: string, files: Record<string, string>): string {
  const root = dir(name);
  writeTree(root, { '.spec-brief.json': '{}', ...files });
  return root;
}

function repo(name: string, files: Record<string, string>): string {
  const root = dir(name);
  initRepo(root);
  writeTree(root, { '.spec-brief.json': '{}', ...files });
  commitAll(root, 'init');
  return root;
}

describe('arguments', () => {
  it('finds the command past global options that take a value', () => {
    expect(parse(['--root', 'x', 'lint', 'a']).command).toBe('lint');
    expect(parse(['--format', 'json', 'list']).command).toBe('list');
    expect(parse(['--config', 'c.json', '--strict', 'lint']).positionals).toEqual([]);
    expect(parse(['lint', '--', '--odd']).positionals).toEqual(['--odd']);
    expect(parse(['--', 'lint']).command).toBe('lint');
    expect(parse(['--strict']).command).toBeUndefined();
  });

  it('refuses an unknown command and an unknown option', () => {
    expect(() => parse(['lnit'])).toThrow(new UsageError('"lnit" is not a command; run spec-brief --help'));
    expect(() => parse(['lint', '--pr', '3'])).toThrow(UsageError);
  });
});

describe('help, version and usage errors', () => {
  const cwd = process.cwd();

  it('prints help and the version', async () => {
    expect(await run(cwd, ['--help'])).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    expect(await run(cwd, ['lint', '-h'])).toEqual({ code: EXIT_OK, out: HELP, err: '' });
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(await run(cwd, ['-v'])).toEqual({ code: EXIT_OK, out: `${pkg.version}\n`, err: '' });
  });

  it('exits 2 for no command, a bad command, a bad option or a bad format', async () => {
    expect((await run(cwd, [])).code).toBe(EXIT_ERROR);
    expect(await run(cwd, ['frobnicate'])).toEqual({ code: EXIT_ERROR, out: '', err: 'spec-brief: "frobnicate" is not a command; run spec-brief --help\n' });
    expect((await run(cwd, ['lint', '--bogus'])).code).toBe(EXIT_ERROR);
    expect((await run(cwd, ['list', '--format', 'sarif'])).err).toBe('spec-brief: --format for list is one of pretty, json, not "sarif"\n');
  });
});

describe('init and new', () => {
  it('writes a configuration and the directories, and refuses to do it twice', async () => {
    const root = dir('cli-init');
    const first = await run(root, ['init']);
    expect(first).toEqual({
      code: EXIT_OK,
      out: 'wrote .spec-brief.json\nwrote briefs/.gitkeep\nwrote briefs/archive/.gitkeep\nnext: spec-brief new "<title>"\n',
      err: '',
    });
    expect(JSON.parse(readFileSync(join(root, '.spec-brief.json'), 'utf8'))).toEqual(expect.objectContaining({ briefs: 'briefs' }));
    expect((await run(root, ['init'])).err).toBe('spec-brief: .spec-brief.json already exists here; edit it instead\n');
  });

  it('takes the directories as options, keeps existing ones, and reports as JSON', async () => {
    const root = dir('cli-init-json');
    writeTree(root, { 'specs/keep.md': '' });
    const result = await run(root, ['init', '--briefs', './specs/', '--format', 'json']);
    expect(JSON.parse(result.out)).toEqual(expect.objectContaining({ command: 'init', ok: true, written: ['.spec-brief.json', 'specs/archive/.gitkeep'] }));
    expect(existsSync(join(root, 'specs', '.gitkeep'))).toBe(false);
    expect((await run(dir('cli-init-same'), ['init', '--briefs', 'a', '--archive', 'a'])).code).toBe(EXIT_ERROR);
    expect((await run(dir('cli-init-root'), ['init', '--briefs', '.'])).code).toBe(EXIT_ERROR);
  });

  it('scaffolds a brief with the next id, and says why it cannot', async () => {
    const root = dir('cli-new');
    await run(root, ['init']);
    const made1 = await run(root, ['new', 'Rotate', 'the', 'tokens', '--wave', '2', '--depends-on', '7, 8,', '--type', 'feature']);
    expect(made1).toEqual({ code: EXIT_OK, out: 'wrote briefs/001_rotate-the-tokens.md\n', err: '' });
    const text = readFileSync(join(root, 'briefs', '001_rotate-the-tokens.md'), 'utf8');
    expect(text).toContain('date: 2026-09-24\ntype: feature\nwave: 2\ndependsOn: ["7", "8"]');
    const json = await run(root, ['new', 'Second', '--format', 'json', '--date', '2026-01-02']);
    expect(JSON.parse(json.out)).toEqual(expect.objectContaining({ command: 'new', file: 'briefs/002_second.md' }));
    expect((await run(root, ['new'])).err).toBe('spec-brief: new needs a title: spec-brief new "<title>"\n');
    expect((await run(root, ['new', 'x', '--wave', 'two'])).err).toBe('spec-brief: --wave must be a whole number of at least 0, not "two"\n');
    expect((await run(root, ['new', 'x', '--id', '001'])).err).toBe('spec-brief: the id "001" is taken\n');
  });
});

describe('lint', () => {
  it('exits 0 with a summary when there is nothing to report', async () => {
    const root = plain('cli-lint-clean', { 'briefs/001_a.md': goodBrief() });
    expect(await run(root, ['lint'])).toEqual({ code: EXIT_OK, out: '1 brief(s) checked, no findings\n', err: '' });
  });

  it('exits 1 on an error, and on a warning only under --strict', async () => {
    const root = plain('cli-lint-dirty', { 'briefs/001_a.md': goodBrief({ type: 'epic' }), 'briefs/002_b.md': goodBrief().replace('# A brief\n', '') });
    const pretty = await run(root, ['lint', '--no-color']);
    expect(pretty.code).toBe(EXIT_FAILED);
    expect(pretty.out).toContain('briefs/001_a.md\n  3  error    "epic" is not a brief type here  unknown-type\n');
    expect(pretty.out).toContain('1 error, 1 warning, 0 notes in 2 brief(s)\n');
    const one = await run(root, ['lint', '2']);
    expect(one.code).toBe(EXIT_OK);
    expect((await run(root, ['lint', '2', '--strict'])).code).toBe(EXIT_FAILED);
  });

  it('writes JSON, SARIF and GitHub annotations', async () => {
    const root = plain('cli-lint-formats', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const json = JSON.parse((await run(root, ['lint', '--format', 'json'])).out) as Record<string, unknown>;
    expect((json['sections'] as { name: string }[]).map((s) => s.name)).toContain('Negative Scope');
    expect(json).toEqual(
      expect.objectContaining({ tool: 'spec-brief', schemaVersion: 2, command: 'lint', ok: false, checked: 1, summary: { errors: 1, warnings: 0, notes: 0 } }),
    );
    const sarif = JSON.parse((await run(root, ['lint', '--format', 'sarif'])).out) as { runs: { results: unknown[] }[] };
    expect(sarif.runs[0]?.results).toHaveLength(1);
    expect((await run(root, ['lint', '--format', 'github'])).out).toMatch(/^::error file=briefs\/001_a\.md,line=3,title=spec-brief unknown-type::/);
  });

  it('colours a terminal, and follows NO_COLOR, FORCE_COLOR and the flags', async () => {
    const root = plain('cli-lint-color', { 'briefs/001_a.md': goodBrief({ type: 'epic' }) });
    const esc = String.fromCharCode(27);
    expect((await run(root, ['lint'], {}, true)).out).toContain(`${esc}[`);
    expect((await run(root, ['lint'], { NO_COLOR: '1' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { NO_COLOR: '' }, true)).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '1' })).out).toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '0' }, true)).out).not.toContain(esc);
    expect((await run(root, ['lint'], { FORCE_COLOR: '' })).out).not.toContain(esc);
    expect((await run(root, ['lint', '--color'])).out).toContain(esc);
    expect((await run(root, ['lint', '--no-color'], { FORCE_COLOR: '1' })).out).not.toContain(esc);
    expect((await run(root, ['lint', '--format', 'json', '--color'])).out).not.toContain(esc);
  });

  it('exits 2 for a configuration that does not load, a missing brief and a misspelt rule', async () => {
    const root = plain('cli-lint-config', { 'briefs/001_a.md': goodBrief() });
    writeTree(root, { '.spec-brief.json': '{"briefz": "x"}' });
    expect((await run(root, ['lint'])).err).toBe('spec-brief: .spec-brief.json: "briefz" is not a known key; did you mean "briefs"?\n');
    writeTree(root, { '.spec-brief.json': '{"rules": {"titel": "off"}}' });
    expect((await run(root, ['lint'])).err).toBe('spec-brief: configuration: "rules.titel" names no rule\n');
    writeTree(root, { '.spec-brief.json': '{}' });
    expect((await run(root, ['lint', '404'])).err).toBe('spec-brief: no brief is named "404"\n');
    expect((await run(root, ['lint', '--no-config', '--root', root])).code).toBe(EXIT_OK);
    expect((await run(process.cwd(), ['lint', '--config', join(root, '.spec-brief.json')])).code).toBe(EXIT_OK);
  });
});

describe('list and matrix', () => {
  const files = {
    'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/auth/**]' }),
    'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["src/**/session.ts"]', dependsOn: '[003]' }),
    'briefs/003_c.md': goodBrief({ wave: '0' }),
    'briefs/archive/004_d.md': goodBrief({ status: 'archived' }),
  };

  it('lists live briefs, archived ones on request, and the ready ones', async () => {
    const root = plain('cli-list', files);
    const all = await run(root, ['list', '--archived', '--no-color']);
    expect(all.out.split('\n').map((l) => l.trimEnd())).toEqual([
      'ID   STATUS    WAVE  TASKS  READY      TITLE',
      '001  active    1     1/1    yes        A brief',
      '002  active    1     1/1    after 003  A brief',
      '003  active    0     1/1    yes        A brief',
      '004  archived  -     1/1    -          A brief',
      '',
    ]);
    const ready = JSON.parse((await run(root, ['list', '--ready', '--format', 'json'])).out) as {
      briefs: { id: string; ready: boolean }[];
      sections: { name: string; type: string | null; hint: string | null }[];
    };
    expect(ready.briefs.map((b) => b.id)).toEqual(['001', '003']);
    expect(ready.sections.map((s) => [s.name, s.type])).toEqual([
      ['Intent', null],
      ['Negative Scope', null],
      ['Not Empowered', null],
      ['Invariants', null],
      ['Acceptance Criteria', 'feature'],
      ['The Defect, Measured', 'defect'],
    ]);
    expect(ready.sections[0]?.hint).toBe('The state of the tree when this round is done, and why it matters. One paragraph.');
    const empty = plain('cli-list-empty', { 'briefs/.gitkeep': '' });
    expect((await run(empty, ['list'])).out).toBe('no briefs\n');
    const missing = plain('cli-list-missing', {});
    for (const command of ['list', 'lint', 'matrix']) {
      expect(await run(missing, [command])).toEqual({
        code: EXIT_ERROR,
        out: '',
        err: 'spec-brief: briefs/ does not exist; run "spec-brief init", or set "briefs" in the configuration\n',
      });
    }
  });

  it('draws the matrix, exits 1 on a collision, and reports it in every format', async () => {
    const root = plain('cli-matrix', files);
    const pretty = await run(root, ['matrix', '--no-color']);
    expect(pretty.code).toBe(EXIT_FAILED);
    expect(pretty.out).toContain('wave 1 \u00b7 2 briefs');
    expect(pretty.out).toContain('X 001 "src/auth/**" and 002 "src/**/session.ts" both cover src/auth/session.ts');
    const json = JSON.parse((await run(root, ['matrix', '--format', 'json'])).out) as { waves: { wave: number; collisions: unknown[] }[]; unscheduled: string[] };
    expect(json.waves.map((w) => [w.wave, w.collisions.length])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect((await run(root, ['matrix', '--format', 'github'])).out).toContain('::error file=briefs/002_b.md');
    expect((await run(root, ['matrix', '--all-waves', '--no-color'])).out).toContain('all live briefs');
    const calm = plain('cli-matrix-calm', { 'briefs/001_a.md': goodBrief({ wave: '1' }) });
    expect((await run(calm, ['matrix'])).code).toBe(EXIT_OK);
    const near = plain('cli-matrix-near', {
      '.spec-brief.json': JSON.stringify({ rules: { 'shared-directory': 'note' } }),
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/a.ts]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[src/b.ts]' }),
      'briefs/003_c.md': goodBrief({ wave: '1' }),
    });
    const doc = JSON.parse((await run(near, ['matrix', '--format', 'json'])).out) as { ok: boolean; waves: { sharedDirectories: unknown[]; unscoped: string[] }[] };
    expect(doc.ok).toBe(true);
    expect(doc.waves[0]?.sharedDirectories).toEqual([{ a: '001', b: '002', directories: ['src'] }]);
    expect(doc.waves[0]?.unscoped).toEqual(['003']);
  });
});

describe('schedule', () => {
  const files = {
    'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/auth/**]' }),
    'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["src/**/session.ts"]' }),
    'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[docs/**]' }),
  };

  it('shows the waves, exits 1 while they would change, and 0 once written', async () => {
    const root = plain('cli-schedule', files);
    const pretty = await run(root, ['schedule', '--no-color']);
    expect(pretty.code).toBe(EXIT_FAILED);
    expect(pretty.out.split('\n')).toEqual([
      'wave 1 · 2 briefs',
      '  001  A brief',
      '  003  A brief',
      'wave 2 · 1 brief',
      '  002  A brief  moves from wave 1',
      '         not wave 1, where 001 also writes src/auth/session.ts ("src/**/session.ts" and "src/auth/**")',
      '',
      '1 brief would move; "spec-brief schedule --write" writes the waves',
      '',
    ]);
    const json = JSON.parse((await run(root, ['schedule', '--format', 'json'])).out) as Record<string, unknown>;
    expect(json).toEqual(expect.objectContaining({ command: 'schedule', ok: false, checked: 3, written: null }));
    expect(json['waves']).toEqual([
      { wave: 1, briefs: ['001', '003'] },
      { wave: 2, briefs: ['002'] },
    ]);
    expect((await run(root, ['schedule', '--format', 'github'])).out).toMatch(/^::error file=briefs\/002_b\.md,line=3,title=spec-brief wave-schedule::/);
    expect(JSON.parse((await run(root, ['schedule', '--format', 'sarif'])).out).runs[0].results).toHaveLength(1);

    const write = await run(root, ['schedule', '--write', '--no-color']);
    expect(write.code).toBe(EXIT_OK);
    expect(write.out).toContain('wrote the wave of 1 brief: briefs/002_b.md\n');
    expect(readFileSync(join(root, 'briefs/002_b.md'), 'utf8')).toBe(files['briefs/002_b.md'].replace('wave: 1', 'wave: 2'));
    expect(readFileSync(join(root, 'briefs/001_a.md'), 'utf8')).toBe(files['briefs/001_a.md']);
    const again = await run(root, ['schedule', '--no-color']);
    expect(again.code).toBe(EXIT_OK);
    expect(again.out.split('\n').at(-2)).toBe('the declared waves hold');
    expect((await run(root, ['matrix'])).code).toBe(EXIT_OK);
  });

  it('reports the written files as JSON, and prints the findings the view does not show', async () => {
    const root = plain('cli-schedule-json', { ...files, 'briefs/004_d.md': goodBrief({ wave: '3' }) });
    const doc = JSON.parse((await run(root, ['schedule', '--write', '--format', 'json'])).out) as { ok: boolean; written: string[]; findings: { rule: string }[] };
    expect(doc.written).toEqual(['briefs/002_b.md']);
    expect(doc.findings.map((f) => f.rule)).toEqual(['unscoped']);
    expect(doc.ok).toBe(true);
    const pretty = await run(root, ['schedule', '--no-color']);
    expect(pretty.out).toContain('briefs/004_d.md\n  1  note     declares no affectedFiles');
    expect((await run(root, ['schedule', '--strict'])).code).toBe(EXIT_OK);
  });

  it('writes nothing, and exits 1, over a cycle or a front matter it cannot edit', async () => {
    const cycle = plain('cli-schedule-cycle', {
      'briefs/001_a.md': goodBrief({ affectedFiles: '[a]', dependsOn: '[2]' }),
      'briefs/002_b.md': goodBrief({ affectedFiles: '[b]', dependsOn: '[1]' }),
      'briefs/003_c.md': goodBrief({ affectedFiles: '[c]' }),
    });
    const refused = await run(cycle, ['schedule', '--write', '--no-color']);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.out).toContain('cycle: 001 -> 002 -> 001\n');
    expect(refused.out).toContain('nothing was written: the dependencies form a cycle\n');
    expect(readFileSync(join(cycle, 'briefs/003_c.md'), 'utf8')).toBe(goodBrief({ affectedFiles: '[c]' }));
    const open = plain('cli-schedule-open', { 'briefs/001_a.md': '---\nstatus: active\n' });
    const edit = await run(open, ['schedule', '--write', '--no-color']);
    expect(edit.code).toBe(EXIT_FAILED);
    expect(edit.out).toContain('nothing was written: a front matter cannot be edited\n');
    expect(edit.out).toContain('the front matter is never closed, so wave 1 cannot be written into it  front-matter');
    expect(readFileSync(join(open, 'briefs/001_a.md'), 'utf8')).toBe('---\nstatus: active\n');
    expect((await run(plain('cli-schedule-missing', {}), ['schedule'])).code).toBe(EXIT_ERROR);
  });
});

describe('archive and unarchive', () => {
  it('dry-runs, archives, is idempotent, and reopens', async () => {
    const root = repo('cli-archive', { 'briefs/001_a.md': goodBrief({ affectedFiles: '[src/**]' }), 'src/a.ts': 'x\n' });
    const dry = await run(root, ['archive', '1', '--dry-run', '--summary', 'Done.', '--no-color']);
    expect(dry.code).toBe(EXIT_OK);
    expect(dry.out).toContain('would move briefs/001_a.md -> briefs/archive/001_a.md');
    expect(dry.out).toContain('> Done.');
    expect(existsSync(join(root, 'briefs', '001_a.md'))).toBe(true);

    const done = await run(root, ['archive', '001', '--commit', 'HEAD', '--pr', '12', '--no-color']);
    expect(done.code).toBe(EXIT_OK);
    expect(done.out).toContain('moved briefs/001_a.md -> briefs/archive/001_a.md');
    expect(done.out).toContain('nothing was committed');
    expect(existsSync(join(root, 'briefs', 'archive', '001_a.md'))).toBe(true);

    expect((await run(root, ['archive', '1'])).out).toBe('briefs/archive/001_a.md is already archived; nothing to do\n');
    const json = JSON.parse((await run(root, ['unarchive', '1', '--format', 'json'])).out) as { ok: boolean; plan: { to: string } };
    expect(json).toEqual(expect.objectContaining({ ok: true, plan: expect.objectContaining({ to: 'briefs/001_a.md' }) }));
    expect((await run(root, ['unarchive', '1'])).out).toBe('briefs/001_a.md is already live; nothing to do\n');
  });

  it('refuses with the reasons and exits 1, and exits 2 on bad arguments', async () => {
    const root = repo('cli-archive-refused', {
      'briefs/001_a.md': goodBrief({ protectedFiles: '[src/locked.ts]', affectedFiles: '[src/ok.ts]' }, '\n- [ ] still open\n'),
      'src/locked.ts': 'x\n',
    });
    writeTree(root, { 'src/locked.ts': 'y\n', 'src/other.ts': 'z\n' });
    commitAll(root, 'work');
    const refused = await run(root, ['archive', '1', '--commit', 'HEAD', '--no-color']);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.out).toContain('cannot archive briefs/001_a.md:');
    expect(refused.out).toContain('open-task');
    expect(refused.out).toContain('protected-file');
    expect(refused.out).toContain('out-of-scope');
    expect((await run(root, ['archive'])).err).toBe('spec-brief: archive takes one brief: spec-brief archive <brief>\n');
    expect((await run(root, ['archive', '1', '2'])).code).toBe(EXIT_ERROR);
    expect((await run(root, ['archive', '1', '--pr', '0'])).err).toBe('spec-brief: --pr must be a whole number of at least 1, not "0"\n');
    expect((await run(root, ['archive', '1', '--no-git', '--base', 'main'])).code).toBe(EXIT_ERROR);
  });

  it('shows warnings beside a refusal and a banner only on a dry run', async () => {
    const root = repo('cli-archive-warn', { 'briefs/001_a.md': goodBrief({ affectedFiles: '[src/ok.ts]' }), 'src/x.ts': '1' });
    writeTree(root, { 'src/x.ts': '2' });
    commitAll(root, 'work');
    const out = (await run(root, ['archive', '1', '--commit', 'HEAD', '--no-color', '--allow-dirty'])).out;
    expect(out).toContain('out-of-scope');
    expect(out).toContain('the round changed 1 file');
    expect(out).not.toContain('banner:');
    writeTree(root, { 'briefs/002_b.md': goodBrief({ affectedFiles: '[src/ok.ts]', status: 'draft' }) });
    commitAll(root, 'second');
    writeTree(root, { 'src/x.ts': '3' });
    commitAll(root, 'more work');
    const both = (await run(root, ['archive', '2', '--commit', 'HEAD', '--no-color'])).out;
    expect(both).toContain('archive-draft');
    expect(both).toContain('out-of-scope');
  });

  it('refuses under --strict to reopen a brief whose links it would leave behind', async () => {
    const root = plain('cli-unarchive-strict', {
      '.spec-brief.json': JSON.stringify({ archiving: { rewriteLinks: false } }),
      'briefs/archive/001_a.md': goodBrief({ status: 'archived' }),
      'briefs/002_b.md': goodBrief({}, '\n[a](archive/001_a.md)\n'),
    });
    const strict = await run(root, ['unarchive', '1', '--strict', '--no-color']);
    expect(strict.code).toBe(EXIT_FAILED);
    expect(strict.out).toContain('stale-link');
    expect(existsSync(join(root, 'briefs', 'archive', '001_a.md'))).toBe(true);
    const lenient = await run(root, ['unarchive', '1', '--no-color']);
    expect(lenient.code).toBe(EXIT_OK);
    expect(lenient.out).toContain('briefs/002_b.md:19');
    expect(readFileSync(join(root, 'briefs', '002_b.md'), 'utf8')).toContain('[a](archive/001_a.md)');
  });

  it('reports a conflict and an unexpected failure with exit 2', async () => {
    const root = repo('cli-archive-conflict', { 'briefs/001_a.md': goodBrief() });
    writeTree(root, { 'briefs/archive/001_a.md/blocker': '' });
    const result = await run(root, ['archive', '1', '--allow-dirty']);
    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(/^spec-brief: /);
  });
});
