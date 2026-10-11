import { readdirSync, readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { gate, LEFT, main, measure, type Parse, parser, type Report, unmeasured } from '../scripts/mutation-unmeasured.mjs';
import strykerCore from '../stryker.core.config.mjs';
import stryker from '../stryker.config.mjs';
import vitestCore from '../vitest.core.config.js';
import vitestMutation from '../vitest.mutation.config.js';

/**
 * What a sweep leaves unmeasured because it stands under a TypeScript `as`
 * (ADR-0009, amended 2026-10-12): Stryker makes no mutant there, so a score
 * says nothing of it, and `scripts/mutation-unmeasured.mjs` counts it.
 *
 * The count is held here to a source small enough to count by hand, and the
 * repository's own sources to the count the script records as left. This file
 * reads the sources as text, which in a sweep's sandbox is Stryker's
 * instrumented copy, and it can fail for no mutant: it is in neither sweep's
 * suite.
 */

// One line an expression, so that a row's line says which it is.
const SOURCE = [
  /*  1 */ 'const CODES = { red: [31, 39], dim: [2, 22] } as const;',
  /*  2 */ 'const last = (items: string[]) => items[items.length - 1] as string;',
  /*  3 */ 'const first = (found: Item[]) => [...found].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Item;',
  /*  4 */ "const format = (values['format'] ?? 'pretty') as Format;",
  /*  5 */ "const why = { reason: 'revision' as const };",
  /*  6 */ 'const raw = value as Record<string, unknown>;',
  /*  7 */ "const kind = input as { kind: 'a' | 'b' };",
  /*  8 */ "const keyed = { 'a-key': count } as Shape;",
  /*  9 */ 'const inner = (rows[i - 1] as Row[])[0] as Row;',
  /* 10 */ 'const held = [left, right] satisfies readonly string[];',
  /* 11 */ 'const above = lines[i - 1]!;',
  /* 12 */ 'const table = literal({ on: [1, 2] });',
  /* 13 */ "const named: readonly [string, string] = [own, 'theirs'];",
].join('\n');

const NOTHING = 'export const nothing = 1;';

/** A mutant over a text of a line, placed as a report places it: columns from one. */
function mutantAt(source: string, line: number, text: string): Report['files'][string]['mutants'][number] {
  const from = (source.split('\n')[line - 1] ?? '').indexOf(text) + 1;
  expect(from, text).toBeGreaterThan(0);
  return { id: `${line}:${from}`, location: { start: { line, column: from }, end: { line, column: from + text.length } } };
}

let parse: Parse;
beforeAll(async () => {
  parse = await parser();
});

describe('what stands under an `as`', () => {
  it('is counted where a mutator would have had a site, one row for each outermost `as` that has any', () => {
    expect(unmeasured(SOURCE, parse).map(({ line, sites, text }) => ({ line, sites, text }))).toEqual([
      // The table and each of its two arrays; a number is no site.
      { line: 1, sites: 3, text: '{ red: [31, 39], dim: [2, 22] } as const' },
      // The subtraction of an index read.
      { line: 2, sites: 1, text: 'items[items.length - 1] as string' },
      // The copy, the sort, its comparator, the choice in it, the comparison and the minus.
      { line: 3, sites: 6, text: '[...found].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Item' },
      // The fallback and both strings.
      { line: 4, sites: 3, text: "(values['format'] ?? 'pretty') as Format" },
      // The string alone: the object around it stands under no `as`.
      { line: 5, sites: 1, text: "'revision' as const" },
      // The object, and not its key, which no mutator reads.
      { line: 8, sites: 1, text: "{ 'a-key': count } as Shape" },
      // One row for the outer `as`, with what the inner one holds.
      { line: 9, sites: 1, text: '(rows[i - 1] as Row[])[0] as Row' },
    ]);
  });

  it('is not counted under a cast with nothing to mutate, in a type, or under `satisfies`, `!`, an annotation or a call', () => {
    const lines = unmeasured(SOURCE, parse).map((row) => row.line);
    // Lines 6 and 7: a name, and a type whose strings are no code.
    // Lines 10 to 13: the ways out, each of which Stryker reads through.
    for (const line of [6, 7, 10, 11, 12, 13]) expect(lines, `line ${line}`).not.toContain(line);
  });

  it('is counted for every source of a report, less what the report has a mutant inside', () => {
    const report: Report = {
      files: {
        'src/a.ts': { source: SOURCE, mutants: [] },
        // One under the `as` of line 2, and one on line 13, where there is none.
        'src/b.ts': { source: SOURCE, mutants: [mutantAt(SOURCE, 2, 'items.length - 1'), mutantAt(SOURCE, 13, "[own, 'theirs']")] },
        'src/c.ts': { source: NOTHING, mutants: [mutantAt(NOTHING, 1, '1')] },
      },
    };
    const measured = measure(report, parse);
    expect(measured.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(measured.mutants).toBe(3);
    // A Stryker that mutated under an `as` would leave such a mutant: that `as` is measured.
    expect(measured.mutated).toBe(1);
    expect(measured.rows.filter((row) => row.file === 'src/a.ts').map((row) => row.line)).toEqual([1, 2, 3, 4, 5, 8, 9]);
    expect(measured.rows.filter((row) => row.file === 'src/b.ts').map((row) => row.line)).toEqual([1, 3, 4, 5, 8, 9]);
    expect(measured.rows.filter((row) => row.file === 'src/c.ts')).toEqual([]);
    expect(measured.rows[0]).toEqual({ file: 'src/a.ts', line: 1, sites: 3, text: '{ red: [31, 39], dim: [2, 22] } as const' });
  });

  it('takes a mutant for inside an `as` only where the whole of it is, to the column', () => {
    // The `as` of line 2 starts at `items[` and ends with `string`.
    const whole = mutantAt(SOURCE, 2, 'items[items.length - 1] as string');
    const before = mutantAt(SOURCE, 2, ' items[items.length - 1]');
    const after = mutantAt(SOURCE, 2, 'items.length - 1] as string;');
    const lines = (mutants: Report['files'][string]['mutants']): number[] => measure({ files: { 'src/a.ts': { source: SOURCE, mutants } } }, parse).rows.map((row) => row.line);
    expect(lines([whole])).toEqual([1, 3, 4, 5, 8, 9]);
    expect(lines([before])).toEqual([1, 2, 3, 4, 5, 8, 9]);
    expect(lines([after])).toEqual([1, 2, 3, 4, 5, 8, 9]);
    // The arrow that holds the `as` of line 3 is around it, not inside.
    expect(lines([mutantAt(SOURCE, 3, '(found: Item[]) => [...found].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Item')])).toEqual([1, 2, 3, 4, 5, 8, 9]);
  });
});

describe('the count that may stay', () => {
  const measured = (): ReturnType<typeof measure> => measure({ files: { 'src/a.ts': { source: SOURCE, mutants: [] }, 'src/c.ts': { source: NOTHING, mutants: [] } } }, parse);

  it('fails a file that has more sites under an `as` than is recorded for it, and says where each is', () => {
    expect(gate(measured(), {})).toEqual([
      [
        'src/a.ts has 16 site(s) under an `as`, which no mutant is made of, where 0 may stay:',
        '  src/a.ts:1  3 under  { red: [31, 39], dim: [2, 22] } as const',
        '  src/a.ts:2  1 under  items[items.length - 1] as string',
        '  src/a.ts:3  6 under  [...found].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Item',
        "  src/a.ts:4  3 under  (values['format'] ?? 'pretty') as Format",
        "  src/a.ts:5  1 under  'revision' as const",
        "  src/a.ts:8  1 under  { 'a-key': count } as Shape",
        '  src/a.ts:9  1 under  (rows[i - 1] as Row[])[0] as Row',
      ].join('\n'),
    ]);
    expect(gate(measured(), { 'src/a.ts': 15 })).toHaveLength(1);
  });

  it('passes a file at the count recorded for it', () => {
    expect(gate(measured(), { 'src/a.ts': 16 })).toEqual([]);
  });

  it('fails a record that is above the count, which would let the next site in unseen', () => {
    expect(gate(measured(), { 'src/a.ts': 17 })).toEqual(['src/a.ts has 16 site(s) under an `as`, where LEFT in scripts/mutation-unmeasured.mjs records 17: lower it']);
    expect(gate(measured(), { 'src/a.ts': 16, 'src/c.ts': 1 })).toEqual(['src/c.ts has 0 site(s) under an `as`, where LEFT in scripts/mutation-unmeasured.mjs records 1: lower it']);
  });

  it('says nothing of a file the report does not hold, as the core sweep holds no edge', () => {
    expect(gate(measured(), { 'src/a.ts': 16, 'src/cli.ts': 2 })).toEqual([]);
  });
});

describe('this repository', () => {
  // The sources that are this repository's own: the vendored spec-core is
  // mutated in spec-core, and measured there.
  const sources = readdirSync('src')
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/${name}`);

  it('has nothing a mutator reads under an `as`, beyond what LEFT records with its reason', async () => {
    expect(sources).toEqual(expect.arrayContaining(['src/cli.ts', 'src/config.ts', 'src/literal.ts']));
    const files = Object.fromEntries(sources.map((name) => [name, { source: readFileSync(name, 'utf8'), mutants: [] }]));
    expect(gate(measure({ files }, parse))).toEqual([]);
    expect(LEFT).toEqual({});
    // And the command says the same of them, as it does of a sweep's report.
    const said: string[] = [];
    expect(await main(['--sources', ...sources], (line) => said.push(line))).toBe(0);
    expect(said).toEqual([`${sources.length} source(s) as they stand`, '0 site(s) stand under 0 `as` expression(s) that no mutant is made of']);
  });

  it('is told when there is nothing to count, with exit 2 and never a count of nothing', async () => {
    const said: string[] = [];
    expect(await main(['reports/no-such-sweep/mutation.json'], (line) => said.push(line))).toBe(2);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^mutation-unmeasured: reports\/no-such-sweep\/mutation\.json could not be read \(ENOENT/);
    // A file that is no report, and has "files" all the same: this package's manifest.
    expect(await main(['package.json'], (line) => said.push(line))).toBe(2);
    expect(said[1]).toBe('mutation-unmeasured: package.json is no mutation report: it has no "files" that are sources with their mutants');
    expect(await main(['tsconfig.json'], (line) => said.push(line))).toBe(2);
    expect(said[2]).toBe('mutation-unmeasured: tsconfig.json is no mutation report: it has no "files" that are sources with their mutants');
    expect(await main(['--sources'], (line) => said.push(line))).toBe(2);
    expect(said[3]).toBe('mutation-unmeasured: --sources needs the files to read: node scripts/mutation-unmeasured.mjs --sources src/*.ts');
  });

  it('has the count taken after each sweep, of the report that sweep wrote', () => {
    const workflow = readFileSync('.github/workflows/mutation.yml', 'utf8');
    const reports = [strykerCore.jsonReporter?.fileName, stryker.jsonReporter?.fileName];
    expect(reports).toEqual(['reports/mutation-core/mutation.json', 'reports/mutation/mutation.json']);
    for (const report of reports) expect(workflow).toContain(`run: node scripts/mutation-unmeasured.mjs ${report}\n`);
  });

  it("keeps this file out of both sweeps, where the sources it reads are Stryker's copies", () => {
    expect(vitestCore.test?.exclude).toContain('tests/mutation-unmeasured.test.ts');
    expect(vitestMutation.test?.exclude).toContain('tests/mutation-unmeasured.test.ts');
  });
});
