import { describe, expect, it } from 'vitest';
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node';

import strykerCore from '../stryker.core.config.mjs';
import stryker from '../stryker.config.mjs';
import vitestConfig from '../vitest.config.js';
import vitestCore from '../vitest.core.config.js';
import vitestMutation, { QuickestFirst } from '../vitest.mutation.config.js';

/**
 * The order a mutant's test files run in, in both sweeps (ADR-0009, amended
 * 2026-10-11): a file that failed last first, then the quickest.
 *
 * The order is the sweeps' and no mutant is under it. This file reaches
 * nothing under src/, so it cannot kill one, and it loads vitest's node side
 * to set the order beside vitest's own: it is left out of both sweeps'
 * suites, where every static mutant would run it.
 */

const ROOT = '/work/spec-brief';

/** What a worker knows of a file after its last run, by the key vitest files it under. */
type Timed = Record<string, { duration: number; failed: boolean }>;

// The files as the full sweep times them, the three longest and three of the
// quickest, and three the worker has not run yet, with sizes on disk: one of
// those is fewer bytes than the long files are milliseconds, and still runs
// after them, since a size is no time.
const TIMED: Timed = {
  ':tests/glob.test.ts': { duration: 2480, failed: false },
  ':tests/cli.test.ts': { duration: 1380, failed: false },
  ':tests/schedule.test.ts': { duration: 1170, failed: false },
  ':tests/config.test.ts': { duration: 22, failed: false },
  ':tests/trigger.test.ts': { duration: 9, failed: false },
  ':tests/text.test.ts': { duration: 8, failed: false },
};
const SIZES: Record<string, number> = {
  ':tests/glob.test.ts': 31_000,
  ':tests/cli.test.ts': 78_000,
  ':tests/schedule.test.ts': 41_000,
  ':tests/config.test.ts': 12_000,
  ':tests/trigger.test.ts': 6_000,
  ':tests/text.test.ts': 5_000,
  ':tests/rules.test.ts': 64_000,
  ':tests/links.test.ts': 900,
  ':tests/engine.test.ts': 52_000,
};
const FOUND = Object.keys(SIZES).map((key) => key.slice(1));

function worker(timed: Timed, found: readonly string[] = FOUND, project = '') {
  const asked: string[] = [];
  const ctx = {
    config: { root: ROOT, shard: { index: 1, count: 3 } },
    cache: {
      getFileTestResults: (key: string) => {
        asked.push(key);
        return timed[key];
      },
      getFileStats: (key: string) => (key in SIZES ? { size: SIZES[key] as number } : undefined),
    },
  } as unknown as Vitest;
  const files = found.map(
    (file) => ({ moduleId: `${ROOT}/${file}`, project: { name: project, config: { isolate: true, sequence: { groupOrder: 0 } } } }) as unknown as TestSpecification,
  );
  return { ctx, files, asked };
}

const names = (files: readonly TestSpecification[]): string[] => files.map((file) => file.moduleId.slice(`${ROOT}/tests/`.length).replace('.test.ts', ''));

describe("the order a mutant's test files run in", () => {
  it('runs the quickest file first, and a file the worker has not timed after those it has, the smaller first', async () => {
    const { ctx, files } = worker(TIMED);
    const order = names(await new QuickestFirst(ctx).sort(files));
    expect(order).toEqual(['text', 'trigger', 'config', 'schedule', 'cli', 'glob', 'links', 'engine', 'rules']);
    // Whatever order vitest found them in.
    expect(names(await new QuickestFirst(ctx).sort([...files].reverse()))).toEqual(order);
    // The list it was handed is left as it was.
    expect(names(files)).toEqual(FOUND.map((file) => file.slice('tests/'.length).replace('.test.ts', '')));
  });

  it('runs a file that failed in the last run before any that passed, however long it takes', async () => {
    // What keeps the next mutant of the same source cheap: the file that killed the last one goes first.
    const failed = { ...TIMED, ':tests/glob.test.ts': { duration: 2480, failed: true }, ':tests/config.test.ts': { duration: 22, failed: true } };
    const { ctx, files } = worker(failed);
    expect(names(await new QuickestFirst(ctx).sort(files))).toEqual(['config', 'glob', 'text', 'trigger', 'schedule', 'cli', 'links', 'engine', 'rules']);
  });

  it('differs from the order vitest would give in that alone, and reads what vitest recorded by the keys vitest reads', async () => {
    const failed = { ...TIMED, ':tests/config.test.ts': { duration: 22, failed: true } };
    const timed = Object.keys(TIMED).map((key) => key.slice(1));

    // Vitest's own: the failed file, then the longest, which is why a mutant
    // that only a unit test kills waited for the glob, CLI and schedule tests.
    const theirs = worker(failed, timed);
    expect(names(await new BaseSequencer(theirs.ctx).sort(theirs.files))).toEqual(['config', 'glob', 'cli', 'schedule', 'trigger', 'text']);
    const ours = worker(failed, timed);
    expect(names(await new QuickestFirst(ours.ctx).sort(ours.files))).toEqual(['config', 'text', 'trigger', 'schedule', 'cli', 'glob']);

    // A key vitest stopped using would find nothing, every file would count
    // as never run, and the order would quietly be by size.
    expect(new Set(ours.asked)).toEqual(new Set(theirs.asked));
    expect(new Set(ours.asked)).toEqual(new Set(Object.keys(TIMED)));

    // The key starts with the project's name, which is empty in a suite of
    // one project and would not be in one of several.
    const named = worker({}, timed, 'unit');
    const namedTheirs = worker({}, timed, 'unit');
    await new QuickestFirst(named.ctx).sort(named.files);
    await new BaseSequencer(namedTheirs.ctx).sort(namedTheirs.files);
    expect(new Set(named.asked)).toEqual(new Set(namedTheirs.asked));
    expect(named.asked).toContain('unit:tests/glob.test.ts');
  });

  it('gives a shard of the suite the files vitest gives it', async () => {
    // Neither sweep hands vitest a shard; one that did would split as vitest does.
    const { ctx, files } = worker(TIMED);
    const theirs = names(await new BaseSequencer(ctx).shard(files));
    expect(theirs).toHaveLength(3);
    expect(names(await new QuickestFirst(ctx).shard(files))).toEqual(theirs);
  });
});

describe('the suites that run in this order', () => {
  it('are the two sweeps, each of which runs every file of its suite for a static mutant', () => {
    // `related: false`: Stryker hands vitest the files itself, and with
    // perTest coverage a mutant no test covers alone runs them all.
    expect(stryker.vitest).toEqual({ configFile: 'vitest.mutation.config.ts', related: false });
    expect(strykerCore.vitest).toEqual({ configFile: 'vitest.core.config.ts', related: false });
    expect(vitestMutation.test?.sequence).toEqual({ sequencer: QuickestFirst });
    expect(vitestCore.test?.sequence).toEqual({ sequencer: QuickestFirst });
  });

  it('and not the suite `npm test` runs, which reports every failure and runs its files side by side', () => {
    expect(vitestConfig.test?.sequence).toBeUndefined();
  });

  it('leave this file out, which no mutant can fail', () => {
    expect(vitestCore.test?.exclude).toContain('tests/mutation-order.test.ts');
    expect(vitestMutation.test?.exclude).toContain('tests/mutation-order.test.ts');
  });
});
