import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { gate, LEFT, main, measure, type Parse, parser, type Report, unmeasured, type Unmeasured, UnmeasuredError } from '../scripts/mutation-unmeasured.mjs';
import strykerCore from '../stryker.core.config.mjs';
import stryker from '../stryker.config.mjs';
import vitestCore from '../vitest.core.config.js';
import vitestMutation from '../vitest.mutation.config.js';
import { instrumenter, type Made } from './instrumenter.js';

/**
 * What a sweep leaves unmeasured because it stands under a TypeScript `as`
 * (ADR-0009, amended 2026-10-12): Stryker makes no mutant there, so a score
 * says nothing of it, and `scripts/mutation-unmeasured.mjs` counts it.
 *
 * The count is held here three ways. To a source small enough to count by
 * hand. To the Stryker installed: over a source written with every kind of
 * site, its instrumenter makes no mutant under a cast, and with the casts
 * taken away it mutates exactly the places counted, so a count is of what
 * Stryker would do and not of this repository's reading of it (ADR-0009,
 * amended 2026-10-14). And this repository's own sources to the count the
 * script records as left. This file reads the sources as text, which in a
 * sweep's sandbox is Stryker's instrumented copy, and it can fail for no
 * mutant: it is in neither sweep's suite.
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

// Each cast stands between two comments, so that the same source can be read
// with its casts and with spaces where they were, every other character
// where it was: what Stryker makes of the second, at the places of the
// first, is what the casts kept it from.
const CAST = /\/\*<\*\/.*?\/\*>\*\//g;
const uncast = (source: string): string => source.replace(CAST, (cast) => ' '.repeat(cast.length));
const WRITTEN = [
  /*  1 */ 'const DIM = String.fromCharCode(27);',
  /*  2 */ "export const CODES = { dim: `${DIM}[2m`, off: '', pair: [2, -22] }/*<*/ as const/*>*/;",
  /*  3 */ 'export function heading(lines: readonly string[], at: number): string {',
  /*  4 */ '  const above = lines[at - 1]/*<*/ as string/*>*/;',
  /*  5 */ '  const named = above/*<*/ as string | undefined/*>*/;',
  /*  6 */ '  return (lines[at + 1] ?? named?.trimEnd())/*<*/ as string/*>*/;',
  /*  7 */ '}',
  /*  8 */ "export const first = (briefs: string[]) => briefs.filter((file) => file !== '' && !file.endsWith('.txt')).sort()[0]/*<*/ as string/*>*/;",
  /*  9 */ "export const held = { reason: 'revision' } satisfies Record<string, string>;",
  /* 10 */ 'export const last = (waves: number[]) => waves[waves.length - 1]!;',
  /* 11 */ "export const phase = 'live'/*<*/ as 'live' | 'archived'/*>*/;",
  /* 12 */ "export const plan = (() => { if (phase) { held.reason.trim(); } for (;;) { throw new Error('no plan'); } })/*<*/ as () => void/*>*/;",
  /* 13 */ "export const nested = [(CODES.pair[0] * 2)/*<*/ as number/*>*/, 'wave']/*<*/ as const/*>*/;",
  /* 14 */ 'export const quiet = (() => { held.reason.at(0); throw new Error(); })/*<*/ as () => void/*>*/;',
  /* 15 */ 'export const chosen = (phase ? 1 : 2)/*<*/ as number/*>*/;',
  /* 16 */ 'let open = 0;',
  /* 17 */ 'export const pattern = (open-- > 0 || (open -= 2) > 0 ? /^\\d{3}_/ : null)/*<*/ as RegExp | null/*>*/;',
  /* 18 */ "export const which = ((kind: string) => { switch (kind) { case 'a': return true; default: return false; } })/*<*/ as (kind: string) => boolean/*>*/;",
  /* 19 */ "export const looped = ((n: number) => { let i = 0; while (i < n) { i += 1; } do { i -= 1; } while (i > 0); return `${i}` + 'x'; })/*<*/ as (n: number) => string/*>*/;",
  /* 20 */ 'export const sized = (Array(3).length + new Array(2).length)/*<*/ as number/*>*/;',
  /* 21 */ 'export const called = ((f?: () => string) => f?.().toUpperCase())/*<*/ as (f?: () => string) => string | undefined/*>*/;',
  '',
].join('\n');

// Line by line, the sites counted under each cast that has one.
const COUNTED: [number, number][] = [
  // The table, its template, its empty string, its list and the minus in it.
  [2, 5],
  // The subtraction in the index.
  [4, 1],
  // `??`, the addition, the optional chain and the `trimEnd`.
  [6, 4],
  // Three methods, the arrow, `&&`, `!==`, `!` and two strings.
  [8, 9],
  // The value, and nothing of the type beside it.
  [11, 1],
  // Three blocks, the test of the `if`, the `trim`, a `for` with no test and
  // the string. Neither statement: each would not be its own only mutant.
  [12, 7],
  // The list, the multiplication under the cast inside it, and the string.
  [13, 3],
  // The block, and the call and the throw, each a statement's only mutant.
  [14, 3],
  // `||`, `>` twice, `--`, `-=` and the pattern.
  [17, 6],
  // The block, both cases, the string one is for, `true` and `false`.
  [18, 6],
  // Three blocks, the two loops' tests, `+=` and `-=`, the template and the
  // string. Not the `+` between those two: Stryker leaves text joined.
  [19, 9],
  // The addition, and a list made with `Array` and with `new Array`.
  [20, 3],
  // The arrow, the optional call, and the method on what it returns.
  [21, 3],
];
const TOTAL = COUNTED.reduce((sum, [, sites]) => sum + sites, 0);

// What the source above does not write, one cast to a source, with the
// sites counted under it: most of them for what Stryker leaves alone.
const MORE: [string, number][] = [
  // A key written as a string is no site: the table and its value are.
  ["export const SECTIONS = { 'negative-scope': 'x' }/*<*/ as const/*>*/;", 2],
  // Nor is the name of a method written as one: the table and the body are.
  ["export const RUNS = { 'lint'() { return 1; } }/*<*/ as object/*>*/;", 2],
  // A type inside the expression is no site, whatever it is written with: the arrow is, and neither `true`.
  ['export const keep = ((flag: true): true | 2 => (flag ? flag : 2))/*<*/ as (flag: true) => true | 2/*>*/;', 1],
  // An arrow that already answers `undefined` has no mutant, and an empty table, list of nothing aside, has none.
  ['export const none = (() => undefined)/*<*/ as () => undefined/*>*/;', 0],
  ['export const empty = ({})/*<*/ as object/*>*/;', 0],
  // Nor has an arrow whose block is empty: there is nothing to take out of it.
  ['export const idle = (() => {})/*<*/ as () => void/*>*/;', 0],
  // Text joined to text is left alone, on either side of the `+` and through a chain of them: the arrow and the string are sites.
  ["export const joined = ((a: string, b: number) => a + 'x' + b)/*<*/ as (a: string, b: number) => string/*>*/;", 2],
  // A string appended with `+=` is left alone; the block and the string are sites.
  ["export const grown = ((s: string) => { s += 'x'; return s; })/*<*/ as (s: string) => string/*>*/;", 2],
  // A string assigned with `??=` is not left alone: the block, the assignment and the string.
  ["export const filled = ((s?: string) => { s ??= 'y'; return s; })/*<*/ as (s?: string) => string/*>*/;", 3],
  // `~` is a site and `typeof` is none, beside the arrow.
  ['export const flipped = ((n: number) => typeof ~n)/*<*/ as (n: number) => string/*>*/;', 2],
  // A `for` with a test is no site of its own: its test is, with both blocks, `++` and `-=`.
  ['export const counted = ((n: number) => { for (let i = 0; i < n; i++) { n -= 1; } })/*<*/ as (n: number) => void/*>*/;', 5],
  // A case that falls through is no site: the block, the case that does not, both strings and both answers.
  ["export const either = ((k: string) => { switch (k) { case 'a': case 'b': return true; } return false; })/*<*/ as (k: string) => boolean/*>*/;", 6],
  // In a chain only the link written `?.` is a site, beside the arrow.
  ['export const deep = ((o?: { b: { c: number } }) => o?.b.c)/*<*/ as (o?: { b: { c: number } }) => number | undefined/*>*/;', 2],
  // A throw of what was caught is no site, where a throw of a new error is: the block alone.
  ['export const again = ((e: Error) => { throw e; })/*<*/ as (e: Error) => never/*>*/;', 1],
  // A method called with `new` is no call Stryker takes away or swaps: the arrow alone.
  ['export const made = ((box: { slice: new () => object }) => new box.slice())/*<*/ as (box: { slice: new () => object }) => object/*>*/;', 1],
  // A module's name is no site, to `require`, to `import` or as what a symbol is called: the arrow and the list are.
  ["export const loaded = (() => [require('a'), Symbol('b'), import('c')])/*<*/ as () => unknown[]/*>*/;", 2],
  // What `satisfies`, `!` and an assertion in angle brackets hold is read, so under a cast it is counted.
  ['export const both = ({ on: [1] } satisfies object)/*<*/ as { on: number[] }/*>*/;', 2],
  ['export const sure = ((rows: number[][], i: number) => rows[i - 1]!)/*<*/ as (rows: number[][], i: number) => number[]/*>*/;', 2],
  ['export const angled = (<number>(open + 1))/*<*/ as unknown/*>*/;', 1],
];

// The instrumenter counts lines and columns from zero, as the parser's `loc` counts columns, and its lines from one.
const under = ({ location: { start, end } }: Made, { loc }: Unmeasured): boolean =>
  (start.line + 1 > loc.start.line || (start.line + 1 === loc.start.line && start.column >= loc.start.column)) && (end.line + 1 < loc.end.line || (end.line + 1 === loc.end.line && end.column <= loc.end.column));
const placeOf = ({ location: { start, end } }: Made): string => `${start.line}:${start.column}-${end.line}:${end.column}`;

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
      // The copy, the sort, its comparator, the comparison and the minus. Not the choice
      // between -1 and 1: Stryker holds its test true or false, at the comparison.
      { line: 3, sites: 5, text: '[...found].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Item' },
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

  it('is counted site by site in a source of every kind of site, and not for a name, `satisfies`, `!` or a choice between two numbers', () => {
    const rows = unmeasured(WRITTEN, parse);
    expect(rows.map(({ line, sites }) => [line, sites])).toEqual(COUNTED);
    // Lines 5, 9, 10 and 15 have nothing a mutator applies to under a cast, and with the casts gone no line has a cast.
    for (const line of [5, 9, 10, 15]) expect(rows.map((row) => row.line)).not.toContain(line);
    expect(unmeasured(uncast(WRITTEN), parse)).toEqual([]);
    expect(rows[0]).toEqual({ line: 2, sites: 5, text: "{ dim: `${DIM}[2m`, off: '', pair: [2, -22] }/*<*/ as const", loc: { start: { line: 2, column: 21 }, end: { line: 2, column: 80 } } });
  });

  it("is counted for an enum's initialisers, which Stryker passes over as it passes over an `as`", () => {
    const rows = unmeasured("export enum Phase { Live = 'live', Kept = 1 + 2, Gone }\nexport const one = [1];\n", parse);
    // The string and the addition: a member with no initialiser has nothing, and the list below stands under neither.
    expect(rows.map(({ line, sites, text }) => ({ line, sites, text }))).toEqual([{ line: 1, sites: 2, text: "enum Phase { Live = 'live', Kept = 1 + 2, Gone }" }]);
    expect(unmeasured('export enum Wave { First, Second }\n', parse)).toEqual([]);
  });

  it('is counted for a pattern Stryker would make nothing of, and so errs towards saying that something is unread', () => {
    expect(unmeasured('export const found = /b/.exec(process.title) as RegExpExecArray;', parse).map(({ sites, text }) => ({ sites, text }))).toEqual([{ sites: 1, text: '/b/.exec(process.title) as RegExpExecArray' }]);
  });

  it('is said on one line where the expression is written over several, at the line it starts on', () => {
    const table = ['const first = 1;', 'const CODES = {', '  red: [31, 39],', '} as const;', ''].join('\n');
    expect(unmeasured(table, parse).map(({ line, sites, text }) => ({ line, sites, text }))).toEqual([{ line: 2, sites: 2, text: '{ red: [31, 39], } as const' }]);
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

describe('the count, held to the Stryker installed', () => {
  it('is of places Stryker makes no mutant at', async () => {
    const made = await (await instrumenter())('src/written.ts', WRITTEN);
    // Were this to fail, Stryker reads under a cast now, and the script, its
    // step in the workflow and `LEFT` have nothing left to say.
    for (const row of unmeasured(WRITTEN, parse)) expect(made.filter((mutant) => under(mutant, row)).map(placeOf), `line ${row.line}`).toEqual([]);
    expect(made.length).toBeGreaterThan(0);
  });

  it('is of exactly the places Stryker mutates once the casts are taken away', async () => {
    const instrument = await instrumenter();
    const written = await instrument('src/written.ts', WRITTEN);
    const freed = await instrument('src/written.ts', uncast(WRITTEN));
    const rows = unmeasured(WRITTEN, parse);

    for (const row of rows) {
      const places = new Set(freed.filter((mutant) => under(mutant, row)).map(placeOf));
      expect([row.line, places.size], [...places].join(' ')).toEqual([row.line, row.sites]);
    }
    // Every mutant the casts had kept from being made is at one of those
    // places: none was behind a cast the script counted nothing under.
    const behind = freed.filter((mutant) => rows.some((row) => under(mutant, row)));
    expect(freed.length - written.length).toBe(behind.length);
    // A site is a place and not a mutant: Stryker makes more than one of some.
    expect(behind.length).toBeGreaterThan(TOTAL);
  });

  it('is of the places Stryker mutates where it leaves something alone: a key, a type, text joined to text, a case that falls through', async () => {
    const instrument = await instrumenter();
    for (const [source, sites] of MORE) {
      const rows = unmeasured(source, parse);
      const freed = await instrument('src/more.ts', uncast(source));
      if (sites === 0) {
        // Nothing counted, and with the cast gone Stryker makes nothing of the whole line.
        expect(rows, source).toEqual([]);
        expect(freed.map(placeOf), source).toEqual([]);
        continue;
      }
      expect(rows.map((row) => row.sites), source).toEqual([sites]);
      const [row] = rows;
      expect((await instrument('src/more.ts', source)).filter((mutant) => under(mutant, row!)), source).toEqual([]);
      const places = new Set(freed.filter((mutant) => under(mutant, row!)).map(placeOf));
      expect(places.size, `${source}: ${[...places].join(' ')}`).toBe(sites);
      // And Stryker mutates nothing of the line outside the cast.
      expect(freed.filter((mutant) => !under(mutant, row!)).map(placeOf), source).toEqual([]);
    }
  });
});

describe('the count that may stay', () => {
  const measured = (): ReturnType<typeof measure> => measure({ files: { 'src/a.ts': { source: SOURCE, mutants: [] }, 'src/c.ts': { source: NOTHING, mutants: [] } } }, parse);

  it('fails a file that has more sites under an `as` than is recorded for it, and says where each is', () => {
    expect(gate(measured(), {})).toEqual([
      [
        'src/a.ts has 15 site(s) under an `as`, which no mutant is made of, where 0 may stay:',
        '  src/a.ts:1  3 under  { red: [31, 39], dim: [2, 22] } as const',
        '  src/a.ts:2  1 under  items[items.length - 1] as string',
        '  src/a.ts:3  5 under  [...found].sort((a, b) => (a.file < b.file ? -1 : 1))[0] as Item',
        "  src/a.ts:4  3 under  (values['format'] ?? 'pretty') as Format",
        "  src/a.ts:5  1 under  'revision' as const",
        "  src/a.ts:8  1 under  { 'a-key': count } as Shape",
        '  src/a.ts:9  1 under  (rows[i - 1] as Row[])[0] as Row',
      ].join('\n'),
    ]);
    expect(gate(measured(), { 'src/a.ts': 14 })).toHaveLength(1);
  });

  it('passes a file at the count recorded for it', () => {
    expect(gate(measured(), { 'src/a.ts': 15 })).toEqual([]);
  });

  it('fails a record that is above the count, which would let the next site in unseen', () => {
    expect(gate(measured(), { 'src/a.ts': 16 })).toEqual(['src/a.ts has 15 site(s) under an `as`, where LEFT in scripts/mutation-unmeasured.mjs records 16: lower it']);
    expect(gate(measured(), { 'src/a.ts': 15, 'src/c.ts': 1 })).toEqual(['src/c.ts has 0 site(s) under an `as`, where LEFT in scripts/mutation-unmeasured.mjs records 1: lower it']);
  });

  it('says nothing of a file the report does not hold, as the core sweep holds no edge', () => {
    expect(gate(measured(), { 'src/a.ts': 15, 'src/cli.ts': 2 })).toEqual([]);
  });

  it('shortens a long expression to its two ends where it says where one is', () => {
    const table = `export const T = { ${Array.from({ length: 30 }, (_, at) => `k${at}: [${at}]`).join(', ')} } as const;`;
    const [problem] = gate(measure({ files: { 'src/t.ts': { source: table, mutants: [] } } }, parse), {});
    const [, where] = (problem ?? '').split('\n');
    // Seventy characters of its start and thirty of its end.
    expect(where).toBe('  src/t.ts:1  31 under  { k0: [0], k1: [1], k2: [2], k3: [3], k4: [4], k5: [5], k6: [6], k7: [ ... 28: [28], k29: [29] } as const');
  });
});

describe('what cannot be counted', () => {
  it('is a source Stryker could not have parsed, refused by name where skipping it would count none', () => {
    const report = (): Report => ({ files: { 'src/c.ts': { source: NOTHING, mutants: [] }, 'src/broken.ts': { source: 'export const = ;', mutants: [] } } });
    expect(() => measure(report(), parse)).toThrow(UnmeasuredError);
    expect(() => measure(report(), parse)).toThrow(/^src\/broken\.ts could not be parsed, so what stands under an `as` in it was not counted \(/);
    // A source the parser could make a tree of all the same, a name declared twice, is refused too: Stryker asks for no
    // such tree, so no sweep reads that source, and a count of it would be of what nothing mutates.
    const twice = ['const a = 1;', 'const a = 2;', 'const CODES = { red: [31] } as const;', ''].join('\n');
    expect(() => unmeasured(twice, parse)).toThrow("Identifier 'a' has already been declared");
    expect(() => measure({ files: { 'src/twice.ts': { source: twice, mutants: [] } } }, parse)).toThrow(/^src\/twice\.ts could not be parsed, /);
  });

  it('is anything, where the parser Stryker brings is not installed: the count is refused, and says what was looked for', async () => {
    const elsewhere = pathToFileURL(path.join(path.parse(process.cwd()).root, 'nowhere', 'scripts', 'mutation-unmeasured.mjs')).href;
    await expect(parser(elsewhere)).rejects.toThrow(UnmeasuredError);
    await expect(parser(elsewhere)).rejects.toThrow(
      '@stryker-mutator/core could not be found, on the way to the parser Stryker reads a source with (@stryker-mutator/core, then @stryker-mutator/instrumenter, then @babel/core, then @babel/parser); run "npm ci" first',
    );
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
    // A source that is no TypeScript, by its name: this package's README.
    expect(await main(['--sources', 'README.md'], (line) => said.push(line))).toBe(2);
    expect(said[4]).toMatch(/^mutation-unmeasured: README\.md could not be parsed, so what stands under an `as` in it was not counted \(/);
    expect(said).toHaveLength(5);
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
