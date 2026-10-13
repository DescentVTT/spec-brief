/**
 * Which sweep reads what, and when it runs: the two Stryker configurations
 * held to the sources, and the workflow to every change.
 *
 * Until 2026-10-14 a pull request ran no sweep, main's push ran the core
 * sweep after the merge, the five edges waited for Monday, and one file that
 * defines a value was in neither sweep's list under a comment that called it
 * re-exports (ADR-0009, amended 2026-10-14). No test said so: a sweep says
 * what it read, and nothing of what it was never handed or never started
 * for. So the arrangement is held here. A source of which Stryker makes a
 * mutant is in the full sweep's list, a source the core sweep leaves out is
 * one of the edges, and both sweeps start for every pull request and every
 * push to main, with no filter that could leave one out.
 *
 * This file reads the disk and loads Stryker's instrumenter, and in a
 * sweep's sandbox the sources it would read are Stryker's copies: it is in
 * neither sweep's suite.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { matchGlob, parseGlob } from '../src/glob.js';
import strykerCore from '../stryker.core.config.mjs';
import stryker from '../stryker.config.mjs';
import vitestCore from '../vitest.core.config.js';
import vitestMutation from '../vitest.mutation.config.js';
import { instrumenter } from './instrumenter.js';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Whether a `mutate` list holds a file: a pattern names it, and none written after a `!` does. */
function holds(patterns: readonly string[], file: string): boolean {
  const names = (pattern: string): boolean => {
    const parsed = parseGlob(pattern);
    return parsed.ok && matchGlob(parsed.glob, file);
  };
  return patterns.some((pattern) => !pattern.startsWith('!') && names(pattern)) && !patterns.some((pattern) => pattern.startsWith('!') && names(pattern.slice(1)));
}

const mutatedBy = (sweep: typeof stryker): string[] => (sweep.mutate ?? []).filter((pattern) => pattern !== undefined);

/** This repository's own sources, at any depth. The vendored spec-core is mutated in spec-core (tests/vendor.test.ts). */
const sources = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
  .map((name) => `src/${name.replaceAll('\\', '/')}`)
  .filter((file) => file.endsWith('.ts') && !file.startsWith('src/vendor/'))
  .sort();

/**
 * The files a list leaves out of which Stryker would have made a mutant,
 * each with how many: what a sweep by that list never reads.
 */
async function unread(patterns: readonly string[], files: readonly string[]): Promise<string[]> {
  const instrument = await instrumenter();
  const found: string[] = [];
  for (const file of files.filter((name) => !holds(patterns, name))) {
    const made = (await instrument(file, read(file))).length;
    if (made > 0) found.push(`${file}: ${made} mutant(s) that no sweep makes`);
  }
  return found;
}

/** The modules that meet the disk, git or the process, which tests/source.test.ts holds to that. */
const EDGES = ['src/cli.ts', 'src/engine.ts', 'src/fs.ts', 'src/git.ts', 'src/plugins.ts'];

describe('what the sweeps mutate', () => {
  const full = mutatedBy(stryker);
  const core = mutatedBy(strykerCore);

  it('is, for the full sweep, every source Stryker makes a mutant of: a file its list leaves out has none', async () => {
    expect(sources).toEqual(expect.arrayContaining(['src/cli.ts', 'src/index.ts', 'src/literal.ts', 'src/types.ts']));
    expect(await unread(full, sources)).toEqual([]);
  });

  it('is found short by a list that leaves out a file with a value, as index.ts was left, and not by one that leaves out types alone', async () => {
    // The list as it stood: index.ts was called re-exports, and holds `definePlugin`.
    const short = await unread([...full, '!src/index.ts'], sources);
    expect(short).toHaveLength(1);
    expect(short[0]).toMatch(/^src\/index\.ts: [1-9]\d* mutant\(s\) that no sweep makes$/);
    // A file of types is no finding wherever it is left out, and a file a list holds is not asked about.
    expect(await unread(['src/**/*.ts', '!src/types.ts'], ['src/types.ts'])).toEqual([]);
    expect(await unread(['src/**/*.ts'], ['src/index.ts'])).toEqual([]);
  });

  it('is, for the core sweep, all of that but the edges, so a module added to src/ is in both', () => {
    const byFull = sources.filter((file) => holds(full, file));
    const byCore = sources.filter((file) => holds(core, file));
    expect(byFull.filter((file) => !byCore.includes(file))).toEqual(EDGES);
    expect(byCore.filter((file) => !byFull.includes(file))).toEqual([]);
    expect(byCore).toContain('src/index.ts');
    // A file nobody has written yet, at the top or under a directory of its own.
    for (const later of ['src/later.ts', 'src/later/part.ts']) {
      expect(holds(full, later), later).toBe(true);
      expect(holds(core, later), later).toBe(true);
    }
    // And the reading says no where it is no.
    expect(holds(full, 'src/vendor/spec-core/pattern/glob.ts')).toBe(false);
    expect(holds(core, 'src/cli.ts')).toBe(false);
  });

  it('keeps this file out of both sweeps, where it would read the sources as Stryker wrote them', () => {
    expect(vitestCore.test?.exclude).toContain('tests/mutation-sweeps.test.ts');
    expect(vitestMutation.test?.exclude).toContain('tests/mutation-sweeps.test.ts');
  });
});
