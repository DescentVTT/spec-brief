/**
 * The mutants a sweep left undetected that main's did not
 * (scripts/mutation-compare.mjs; ADR-0009, amended 2026-10-14).
 *
 * A pull request is read by this list, so what is held first is what the
 * list calls one mutant: a mutant that only moved is not on it, and another
 * mutant on the line of the old one is. Then that the run fails for no
 * mutant; that a comparison which was not made is said as that, and never as
 * a list with nothing on it; and which of main's sweeps a report is taken
 * from.
 *
 * This file writes to disk and starts a process, and no mutant is under
 * `scripts/`: it is in neither sweep's suite.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compare, CompareError, type Gh, type Location, logOf, main, mainsReport, type Mutant, notCompared, type Report, rowLine, summaryOf, textAt, undetectedOf } from '../scripts/mutation-compare.mjs';
import vitestCore from '../vitest.core.config.js';
import vitestMutation from '../vitest.mutation.config.js';
import { tempDir } from './helpers.js';
import { stepsOf, under, written } from './workflows.js';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'mutation-compare.mjs');

const WAITING = ['export function waiting(open: string[], wave: number): string {', "  if (open.length === 0) return 'ready';", "  return wave > 1 ? open.join(', ') : 'blocked';", '}'].join('\n');

/** Where `text` stands in `source`, the `nth` time, as a report says it: lines and columns from one, the end one past. */
function place(source: string, text: string, nth = 0): Location {
  let from = -1;
  for (let found = 0; found <= nth; found += 1) {
    from = source.indexOf(text, from + 1);
    if (from === -1) throw new Error(`${JSON.stringify(text)} is not in the source ${nth + 1} time(s)`);
  }
  const position = (offset: number): { line: number; column: number } => {
    const before = source.slice(0, offset).split('\n');
    return { line: before.length, column: (before.at(-1) ?? '').length + 1 };
  };
  return { start: position(from), end: position(from + text.length) };
}

const mutant = (source: string, text: string, mutatorName: string, replacement: string, status = 'Survived', nth = 0): Mutant => ({ mutatorName, replacement, status, location: place(source, text, nth) });

const report = (files: Record<string, readonly [string, Mutant[]]>): Report => ({
  schemaVersion: '1.0',
  files: Object.fromEntries(Object.entries(files).map(([name, [source, mutants]]) => [name, { language: 'typescript', source, mutants }])),
});

/** One file, `src/corpus.ts`, with these mutants. */
const one = (source: string, ...mutants: Mutant[]): Report => report({ 'src/corpus.ts': [source, mutants] });

const NONE_OPEN = mutant(WAITING, 'open.length === 0', 'ConditionalExpression', 'true');

describe('the text a mutant replaces', () => {
  it('is read from the source by line and column, each from one, up to the character its end names and not that one', () => {
    expect(textAt(WAITING, { start: { line: 2, column: 7 }, end: { line: 2, column: 24 } })).toBe('open.length === 0');
    expect(textAt(WAITING, place(WAITING, "', '"))).toBe("', '");
    // A place of no width is no text, wherever it is.
    expect(textAt(WAITING, { start: { line: 3, column: 10 }, end: { line: 3, column: 10 } })).toBe('');
  });

  it('runs over every line between its two ends, each whole but the first and the last', () => {
    expect(textAt(WAITING, { start: { line: 1, column: WAITING.indexOf('{') + 1 }, end: { line: 4, column: 2 } })).toBe(WAITING.slice(WAITING.indexOf('{')));
    expect(textAt(WAITING, { start: { line: 2, column: 3 }, end: { line: 3, column: 9 } })).toBe("if (open.length === 0) return 'ready';\n  return");
  });

  it('is nothing past the end of the source, for a report that points there, and no failure', () => {
    expect(textAt(WAITING, { start: { line: 9, column: 1 }, end: { line: 9, column: 5 } })).toBe('');
    expect(textAt(WAITING, { start: { line: 4, column: 1 }, end: { line: 9, column: 5 } })).toBe('}\n');
  });
});

describe('one mutant in two reports', () => {
  it('is the same where only its line moved, and is on neither list', () => {
    const moved = `// A comment.\n// And one more.\n\n${WAITING}`;
    const here = one(moved, mutant(moved, 'open.length === 0', 'ConditionalExpression', 'true'));
    expect(here.files['src/corpus.ts']?.mutants?.[0]?.location.start.line).toBe(5);
    expect(compare(one(WAITING, NONE_OPEN), here)).toMatchObject({ added: [], gone: [], new: 0, lost: 0 });
  });

  it('is new where another text stands in its place, which a comparison by line would call the same', () => {
    const edited = WAITING.split('open.length === 0').join('open.length <= 1');
    const here = one(edited, mutant(edited, 'open.length <= 1', 'ConditionalExpression', 'true'));
    // The same file, line, first column, mutator, replacement and verdict.
    expect(here.files['src/corpus.ts']?.mutants?.[0]?.location.start).toEqual(NONE_OPEN.location.start);
    const result = compare(one(WAITING, NONE_OPEN), here);
    expect(result).toMatchObject({ new: 1, lost: 1 });
    expect(result.added).toEqual([{ file: 'src/corpus.ts', mutator: 'ConditionalExpression', text: 'open.length <= 1', replacement: 'true', at: [{ line: 2, verdict: 'survived' }], count: 1 }]);
    expect(result.gone.map((row) => row.text)).toEqual(['open.length === 0']);
  });

  it.each(['Killed', 'Timeout'])("is new where main's sweep had it %s and every test passes under it here", (status) => {
    const result = compare(one(WAITING, { ...NONE_OPEN, status }), one(WAITING, NONE_OPEN));
    expect(result.added.map((row) => row.text)).toEqual(['open.length === 0']);
    expect(result).toMatchObject({ new: 1, lost: 0 });
  });

  it('is not new where it was undetected the other way: no test reached it there and every test passes here, or the reverse', () => {
    const unreached = { ...NONE_OPEN, status: 'NoCoverage' };
    expect(compare(one(WAITING, unreached), one(WAITING, NONE_OPEN))).toMatchObject({ new: 0, lost: 0 });
    expect(compare(one(WAITING, NONE_OPEN), one(WAITING, unreached))).toMatchObject({ new: 0, lost: 0 });
    // One that no test reaches is undetected as one every test passes under is, and is said as what it is.
    expect(compare(one(WAITING), one(WAITING, unreached)).added.map((row) => row.at)).toEqual([[{ line: 2, verdict: 'no test reaches it' }]]);
  });

  it('is gone, and not new, where a test kills it here', () => {
    const result = compare(one(WAITING, NONE_OPEN), one(WAITING, { ...NONE_OPEN, status: 'Killed' }));
    expect(result).toMatchObject({ new: 0, lost: 1, added: [] });
    expect(result.gone.map((row) => row.text)).toEqual(['open.length === 0']);
  });

  // The last two are no verdict of any Stryker: they are names every object answers to, and a table of verdicts kept in one is not to.
  it.each(['Ignored', 'CompileError', 'RuntimeError', 'Pending', 'toString', 'constructor'])('is on neither list while it is %s, which is no verdict of the tests', (status) => {
    const other = { ...NONE_OPEN, status };
    expect(compare(one(WAITING, other), one(WAITING, other))).toMatchObject({ new: 0, lost: 0 });
    expect(compare(one(WAITING), one(WAITING, other))).toMatchObject({ new: 0, lost: 0, here: { mutants: 1, survived: 0, unreached: 0 } });
    // And one that was so and survives now is new.
    expect(compare(one(WAITING, other), one(WAITING, NONE_OPEN))).toMatchObject({ new: 1, lost: 0 });
  });

  it('is another mutant under another mutator, with another replacement, or in another file', () => {
    const mains = one(WAITING, NONE_OPEN);
    expect(compare(mains, one(WAITING, { ...NONE_OPEN, mutatorName: 'EqualityOperator' }))).toMatchObject({ new: 1, lost: 1 });
    expect(compare(mains, one(WAITING, { ...NONE_OPEN, replacement: 'false' }))).toMatchObject({ new: 1, lost: 1 });
    expect(compare(mains, report({ 'src/schedule.ts': [WAITING, [NONE_OPEN]] }))).toMatchObject({ new: 1, lost: 1 });
  });

  it('is told from the others like it by how many there are, where one text is replaced by one thing more than once in a file', () => {
    const twice = "const own = read(manifest, 'utf8');\nconst theirs = read(other, 'utf8');\n";
    const first = mutant(twice, "'utf8'", 'StringLiteral', '""', 'Survived', 0);
    const second = mutant(twice, "'utf8'", 'StringLiteral', '""', 'NoCoverage', 1);
    const more = compare(one(twice, first), one(twice, first, second));
    expect(more).toMatchObject({ new: 1, lost: 0 });
    // Which of the two is the new one no report says, so both lines are given.
    expect(more.added).toEqual([{ file: 'src/corpus.ts', mutator: 'StringLiteral', text: "'utf8'", replacement: '""', at: [{ line: 1, verdict: 'survived' }, { line: 2, verdict: 'no test reaches it' }], count: 1 }]);
    expect(rowLine(more.added[0]!)).toBe('src/corpus.ts  StringLiteral  \'utf8\'  ->  ""  (survived and no test reaches it; 1 of the 2 alike, at lines 1 and 2)');
    expect(compare(one(twice, first, second), one(twice, second))).toMatchObject({ new: 0, lost: 1 });
    // In whatever order a report lists them.
    expect(compare(one(twice, first, second), one(twice, second, first))).toMatchObject({ new: 0, lost: 0 });
    const both = compare(one(twice), one(twice, second, first));
    expect(both).toMatchObject({ new: 2, added: [{ count: 2 }] });
    expect(rowLine(both.added[0]!)).toBe('src/corpus.ts  StringLiteral  \'utf8\'  ->  ""  (survived and no test reaches it; 2 alike, lines 1 and 2)');
    // And the other way about, both are gone: two mutants, on one row.
    expect(compare(one(twice, first, second), one(twice))).toMatchObject({ new: 0, lost: 2, gone: [{ count: 2 }] });
  });

  it('counts each report: its mutants, and those undetected of each kind', () => {
    const mains = one(WAITING, NONE_OPEN, { ...mutant(WAITING, "'ready'", 'StringLiteral', '""'), status: 'Killed' }, { ...mutant(WAITING, "', '", 'StringLiteral', '""'), status: 'Timeout' });
    const here = one(WAITING, NONE_OPEN, mutant(WAITING, "'ready'", 'StringLiteral', '""'), { ...mutant(WAITING, "', '", 'StringLiteral', '""'), status: 'NoCoverage' });
    const result = compare(mains, here);
    expect(result.main).toEqual({ mutants: 3, survived: 1, unreached: 0 });
    expect(result.here).toEqual({ mutants: 3, survived: 2, unreached: 1 });
    expect(result.added.map((row) => `${row.at[0]?.line} ${row.text}`)).toEqual(["2 'ready'", "3 ', '"]);
  });

  it('lists them as a reader goes through the files: by file, then by line, then by mutator and by replacement, in whatever order a report has them', () => {
    const body = WAITING.slice(WAITING.indexOf('{'));
    const here = report({
      'src/schedule.ts': [WAITING, [NONE_OPEN]],
      'src/corpus.ts': [
        WAITING,
        [
          mutant(WAITING, "', '", 'StringLiteral', '""'),
          // On the third line, under a mutator whose name comes before one of the second line.
          mutant(WAITING, 'wave > 1', 'ConditionalExpression', 'true'),
          mutant(WAITING, 'open.length === 0', 'EqualityOperator', 'open.length !== 0'),
          NONE_OPEN,
          mutant(WAITING, 'open.length === 0', 'ConditionalExpression', 'false'),
          mutant(WAITING, body, 'BlockStatement', '{}'),
        ],
      ],
    });
    expect(compare(one(WAITING), here).added.map((row) => `${row.file} ${row.at[0]?.line} ${row.mutator} ${row.replacement}`)).toEqual([
      'src/corpus.ts 1 BlockStatement {}',
      'src/corpus.ts 2 ConditionalExpression false',
      'src/corpus.ts 2 ConditionalExpression true',
      'src/corpus.ts 2 EqualityOperator open.length !== 0',
      'src/corpus.ts 3 ConditionalExpression true',
      'src/corpus.ts 3 StringLiteral ""',
      'src/schedule.ts 2 ConditionalExpression true',
    ]);
  });

  it('says which files only one of the two sweeps mutated, where every undetected mutant reads as new or as gone', () => {
    const mains = report({ 'src/corpus.ts': [WAITING, [NONE_OPEN]], 'src/old.ts': [WAITING, [NONE_OPEN]] });
    const here = report({ 'src/corpus.ts': [WAITING, [NONE_OPEN]], 'src/index.ts': [WAITING, [NONE_OPEN]], 'src/apply.ts': [WAITING, []] });
    expect(compare(mains, here)).toMatchObject({ onlyHere: ['src/apply.ts', 'src/index.ts'], onlyMain: ['src/old.ts'], new: 1, lost: 1 });
    expect(compare(mains, mains)).toMatchObject({ onlyHere: [], onlyMain: [] });
  });

  it('refuses what is no report, and a report that cannot say what an undetected mutant replaced', () => {
    expect(() => compare({}, one(WAITING, NONE_OPEN))).toThrow(new CompareError('main\'s report is no mutation report: it has no "files"'));
    expect(() => compare(one(WAITING, NONE_OPEN), null)).toThrow('this sweep\'s report is no mutation report: it has no "files"');
    // A package.json has "files" too, a list.
    expect(() => undetectedOf({ files: ['dist'] }, 'package.json')).toThrow('package.json is no mutation report: it has no "files"');
    const sourceless = { files: { 'src/corpus.ts': { mutants: [NONE_OPEN] } } };
    expect(() => compare(sourceless, one(WAITING, NONE_OPEN))).toThrow("main's report has no source for src/corpus.ts, so a mutant of it cannot be told by the text it replaces");
    const placeless = { files: { 'src/corpus.ts': { source: WAITING, mutants: [{ mutatorName: 'StringLiteral', replacement: '""', status: 'Survived' }] } } };
    expect(() => compare(one(WAITING), placeless)).toThrow(new CompareError("this sweep's report has a mutant of src/corpus.ts with no place in its source"));
    // A start and no end, and a line and no column: each is no place.
    for (const location of [{ start: { line: 2, column: 7 } }, { start: { line: 2 }, end: { line: 2, column: 24 } }, { start: { line: 2, column: 7 }, end: { column: 24 } }]) {
      const halfPlaced = { files: { 'src/corpus.ts': { source: WAITING, mutants: [{ ...NONE_OPEN, location }] } } };
      expect(() => compare(one(WAITING), halfPlaced), JSON.stringify(location)).toThrow(new CompareError("this sweep's report has a mutant of src/corpus.ts with no place in its source"));
    }
    // "files" that is nothing is no report either, and is refused as one, not met as a failure of this script.
    expect(() => undetectedOf({ files: null }, 'x.json')).toThrow(new CompareError('x.json is no mutation report: it has no "files"'));
  });

  it('takes a file with no source where every mutant of it was detected, and a file with no mutants', () => {
    const detected = { files: { 'src/corpus.ts': { mutants: [{ ...NONE_OPEN, status: 'Killed' }] }, 'src/types.ts': { source: 'export type Phase = string;\n' } } };
    expect(compare(detected, one(WAITING, NONE_OPEN))).toMatchObject({ new: 1, lost: 0, main: { mutants: 1, survived: 0, unreached: 0 } });
  });
});

describe('what a run writes', () => {
  const twice = "const own = read(manifest, 'utf8');\nconst theirs = read(other, 'utf8');\n";
  const mains = report({ 'src/corpus.ts': [WAITING, [NONE_OPEN]], 'src/plugins.ts': [twice, [mutant(twice, "'utf8'", 'StringLiteral', '""')]] });
  const here = report({
    'src/corpus.ts': [WAITING, [mutant(WAITING, "', '", 'StringLiteral', '""'), mutant(WAITING, WAITING.slice(WAITING.indexOf('{')), 'BlockStatement', '{}', 'NoCoverage')]],
    'src/plugins.ts': [twice, [mutant(twice, "'utf8'", 'StringLiteral', '""', 'Survived', 0), mutant(twice, "'utf8'", 'StringLiteral', '""', 'Survived', 1)]],
  });
  const ROWS = [
    "src/corpus.ts  BlockStatement  { if (open.length === 0) return 'ready'; return wave > 1 ? open.join(', ') : 'blocked'; }  ->  {}  (no test reaches it; line 1)",
    'src/corpus.ts  StringLiteral  \', \'  ->  ""  (survived; line 3)',
    'src/plugins.ts  StringLiteral  \'utf8\'  ->  ""  (survived; 1 of the 2 alike, at lines 1 and 2)',
  ];
  const GONE = 'src/corpus.ts  ConditionalExpression  open.length === 0  ->  true  (survived; line 2)';

  it('is, in the log, both counts and then each new mutant and each that is gone on a line of its own, by file, mutator, text and replacement', () => {
    expect(logOf(compare(mains, here), "main's sweep")).toBe(
      [
        'this sweep: 4 mutants, 4 undetected: 3 survived and 1 that no test reaches',
        "main's sweep: 2 mutants, 2 undetected: 2 survived and 0 that no test reaches",
        '',
        "new against main's: 3",
        ...ROWS.map((row) => `  ${row}`),
        '',
        "undetected in main's and not here: 1",
        `  ${GONE}`,
      ].join('\n'),
    );
  });

  it('is, in the summary, which sweep, the count, what it was set beside, the new ones in a block, and what a new one asks of the change', () => {
    const against = "main's newest sweep that passed and has its mutation-full, [run 7](https://github.com/o/r/actions/runs/7) of abcdef0, 2026-10-14";
    expect(summaryOf(compare(mains, here), 'mutation-full', against)).toBe(
      [
        '### mutation-full: undetected mutants new against main: 3',
        '',
        `Set beside ${against}: 2 undetected there, 4 here.`,
        '',
        '```text',
        ...ROWS,
        '```',
        '',
        'A mutant is its file, its mutator, the text it replaces and what replaces it, never its line, so one whose own text was edited is listed, and so is one of anything main took after the commit that report is of. The run is not failed for any of them: before the change merges, each is killed by a test, or said equivalent in a comment beside its code (CONTRIBUTING.md).',
        '',
        "1 mutant that main's sweep left undetected is detected or gone here; the job's log lists it.",
        '',
        '',
      ].join('\n'),
    );
  });

  it('says none where it compared and found none, with what it compared, and how many are gone where some are', () => {
    expect(summaryOf(compare(mains, mains), 'mutation-core', '`main.json`')).toBe('### mutation-core: undetected mutants new against main: none\n\nSet beside `main.json`: 2 undetected there, 2 here.\n\n');
    const fewer = summaryOf(compare(here, mains), 'mutation-core', '`main.json`');
    expect(fewer).toContain('### mutation-core: undetected mutants new against main: 1\n');
    expect(fewer).toContain("\n\n3 mutants that main's sweep left undetected are detected or gone here; the job's log lists them.\n\n");
  });

  it('says of the files only one sweep mutated why their mutants are listed, in the log and in the summary', () => {
    const result = compare(mains, { files: { ...here.files, 'src/index.ts': { source: WAITING, mutants: [NONE_OPEN] } } });
    expect(logOf(result, 'x').split('\n')[2]).toBe("mutated here and not in main's report, so everything undetected in it reads as new: src/index.ts");
    expect(summaryOf(result, 'mutation-full', 'x')).toContain("\n\nFiles mutated here and not in main's report, so everything undetected in it reads as new: src/index.ts.\n\n");
    const narrower = compare({ files: { ...mains.files, 'src/fs.ts': { source: WAITING, mutants: [] }, 'src/git.ts': { source: WAITING, mutants: [] } } }, mains);
    expect(logOf(narrower, 'x').split('\n')[2]).toBe("in main's report and not mutated here, so everything undetected in them reads as gone: src/fs.ts and src/git.ts");
    // One file is "it" and several are "them", on either side, and three are listed as words list three.
    const edge = { source: WAITING, mutants: [] };
    const both = compare({ files: { ...mains.files, 'src/old.ts': edge } }, { files: { ...mains.files, 'src/cli.ts': edge, 'src/engine.ts': edge, 'src/fs.ts': edge } });
    expect(logOf(both, 'x').split('\n').slice(2, 4)).toEqual([
      "mutated here and not in main's report, so everything undetected in them reads as new: src/cli.ts, src/engine.ts and src/fs.ts",
      "in main's report and not mutated here, so everything undetected in it reads as gone: src/old.ts",
    ]);
  });

  it('writes a count in the thousands as a person reads one', () => {
    const many = one(WAITING, NONE_OPEN, ...Array.from({ length: 7249 }, () => ({ ...NONE_OPEN, status: 'Killed' })));
    expect(logOf(compare(many, many), 'x').split('\n')[0]).toBe('this sweep: 7,250 mutants, 1 undetected: 1 survived and 0 that no test reaches');
  });

  it('says of a comparison that was not made that it was not made, and never that it found none', () => {
    const sentence = notCompared('main has no sweep that passed');
    expect(sentence).toBe('Not compared with main: main has no sweep that passed. This says nothing of new undetected mutants, neither that there are some nor that there are none; compare the two reports by hand, with this script.');
    expect(sentence).not.toMatch(/: none\b|new against main/);
  });

  it('shortens a long text to its two ends, and says a replacement that is nothing as that', () => {
    const long = `const WORDS = [${Array.from({ length: 30 }, (_, index) => `'word ${index}'`).join(', ')}];\nrun();\n`;
    const list = long.slice(long.indexOf('['), long.indexOf(']') + 1);
    const result = compare(one(long), one(long, mutant(long, list, 'ArrayDeclaration', '[]'), mutant(long, 'run();', 'CallExpression', ''), mutant(long, 'run', 'Identifier', ' \n ')));
    expect(result.added.map(rowLine)).toEqual([
      // Sixty-four characters of its start and twenty-four of its end.
      "src/corpus.ts  ArrayDeclaration  ['word 0', 'word 1', 'word 2', 'word 3', 'word 4', 'word 5', 'wo ... ', 'word 28', 'word 29']  ->  []  (survived; line 1)",
      'src/corpus.ts  CallExpression  run();  ->  (nothing)  (survived; line 2)',
      // And one that is only space, which a reader would see as nothing.
      'src/corpus.ts  Identifier  run  ->  (nothing)  (survived; line 2)',
    ]);
    // One of ninety-six characters is written whole.
    const whole = `'${'x'.repeat(94)}'`;
    const fits = `const A = ${whole};\n`;
    expect(rowLine(compare(one(fits), one(fits, mutant(fits, whole, 'StringLiteral', '""'))).added[0]!)).toContain(`  ${whole}  ->  `);
  });

  it('closes its block only where the block ends, whatever backticks a mutated text holds', () => {
    const source = 'const fence = "```";\nconst longer = "`````";\n';
    const three = compare(one(source), one(source, mutant(source, '"```"', 'StringLiteral', '""')));
    expect(summaryOf(three, 's', 'x')).toContain('\n\n````text\nsrc/corpus.ts  StringLiteral  "```"  ->  ""  (survived; line 1)\n````\n\n');
    const five = compare(one(source), one(source, mutant(source, '"```"', 'StringLiteral', '""'), mutant(source, '"`````"', 'StringLiteral', '""')));
    expect(summaryOf(five, 's', 'x')).toContain('\n\n``````text\nsrc/corpus.ts  StringLiteral  "```"  ->  ""  (survived; line 1)\nsrc/corpus.ts  StringLiteral  "`````"  ->  ""  (survived; line 2)\n``````\n\n');
  });

  it('starts no line of the log with a text of the source, which the runner would read as a command', () => {
    const source = 'function f() {\n::error::not a failure\n  ::add-mask::x\n}\n';
    const body = source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1);
    const result = compare(one(source), one(source, mutant(source, body, 'BlockStatement', '{}'), mutant(source, '::error::not a failure', 'StringLiteral', '::warning::x')));
    const lines = logOf(result, 'x').split('\n');
    expect(lines.filter((line) => line.includes('::error::'))).toEqual([
      '  src/corpus.ts  BlockStatement  { ::error::not a failure ::add-mask::x }  ->  {}  (survived; line 1)',
      '  src/corpus.ts  StringLiteral  ::error::not a failure  ->  ::warning::x  (survived; line 2)',
    ]);
    expect(lines.filter((line) => line.trimStart().startsWith('::'))).toEqual([]);
  });

  it('lists a hundred and fifty rows in a summary and says how many more the log has, which has every one', () => {
    const source = `${Array.from({ length: 152 }, (_, index) => `export const v${index} = 'value ${index}';`).join('\n')}\n`;
    const all = Array.from({ length: 152 }, (_, index) => mutant(source, `'value ${index}'`, 'StringLiteral', '""'));
    const result = compare(one(source), one(source, ...all));
    expect(result.new).toBe(152);
    const text = summaryOf(result, 's', 'x');
    expect(text.split('\n').filter((row) => row.startsWith('src/corpus.ts  '))).toHaveLength(150);
    expect(text).toContain("\n\n2 more rows are in the job's log.\n\n");
    expect(logOf(result, 'x').split('\n').filter((row) => row.startsWith('  src/corpus.ts  '))).toHaveLength(152);
    expect(summaryOf(compare(one(source), one(source, ...all.slice(0, 151))), 's', 'x')).toContain("\n\n1 more row is in the job's log.\n\n");
    expect(summaryOf(compare(one(source), one(source, ...all.slice(0, 150))), 's', 'x')).not.toContain('more row');
    // A step's summary may hold 1 MiB: a hundred and fifty rows of long texts, each shortened, are well under it.
    const wordy = `${Array.from({ length: 150 }, (_, index) => `export const v${index} = '${'word '.repeat(40)}${index}';`).join('\n')}\n`;
    const longest = Array.from({ length: 150 }, (_, index) => mutant(wordy, `'${'word '.repeat(40)}${index}'`, 'StringLiteral', `"${'other '.repeat(40)}${index}"`));
    expect(Buffer.byteLength(summaryOf(compare(one(wordy), one(wordy, ...longest)), 's', 'x'))).toBeLessThan(64 * 1024);
  });
});

/** A run as GitHub lists one, as far as the script reads it. */
const sweep = (id: number, created: string, changes: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  head_branch: 'main',
  head_sha: `${String(id).padStart(7, '0')}${'a'.repeat(33)}`,
  event: 'push',
  conclusion: 'success',
  created_at: created,
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  ...changes,
});

/**
 * A `gh` that lists `runs` and hands over the artifact of each run in
 * `reports`; any other run has lost its artifact. It unpacks an artifact
 * into the directory it is given, or into `within` under it, as a file
 * named `named`.
 */
function github(runs: unknown, reports: Record<number, string> = {}, within = '.', named = 'mutation.json'): { gh: Gh; asked: string[][] } {
  const asked: string[][] = [];
  const gh: Gh = (args) => {
    asked.push(args);
    if (args[0] === 'api') {
      if (runs instanceof Error) throw runs;
      return JSON.stringify(runs);
    }
    const content = reports[Number(args[2])];
    if (content === undefined) throw Object.assign(new Error('Command failed: gh run download'), { stderr: 'no valid artifacts found to download\n' });
    const into = join(args[args.indexOf('--dir') + 1] ?? '', within);
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, named), content);
    return '';
  };
  return { gh, asked };
}

describe("main's report", () => {
  const fetch = (name: string, gh: Gh, own = '99', artifact = 'mutation-full'): ReturnType<typeof mainsReport> & { directory: string } => {
    const directory = tempDir(`compare-${name}`);
    return { ...mainsReport({ gh, repository: 'o/r', artifact, directory, own }), directory };
  };

  it("is that of main's newest sweep that passed, by when each was created and in whatever order GitHub lists them", () => {
    const { gh, asked } = github({ workflow_runs: [sweep(3, '2026-10-05T10:15:00Z'), sweep(8, '2026-10-12T10:33:00Z', { event: 'schedule' }), sweep(5, '2026-10-11T09:25:00Z', { event: 'workflow_dispatch' })] }, { 8: '{"files":{}}' });
    const found = fetch('newest', gh);
    expect(found).toEqual({ directory: found.directory, file: join(found.directory, '8', 'mutation.json'), run: '8', sha: `0000008${'a'.repeat(33)}`, created: '2026-10-12T10:33:00Z', url: 'https://github.com/o/r/actions/runs/8' });
    expect(readFileSync(join(found.directory, '8', 'mutation.json'), 'utf8')).toBe('{"files":{}}');
    // One question for the list, of this workflow's runs on main that passed, and one for the artifact, by its name.
    expect(asked).toEqual([
      ['api', 'repos/o/r/actions/workflows/mutation.yml/runs?branch=main&status=success&per_page=30'],
      ['run', 'download', '8', '--repo', 'o/r', '--name', 'mutation-full', '--dir', join(found.directory, '8')],
    ]);
  });

  it.each(['push', 'schedule', 'workflow_dispatch'])('is that of a sweep of main that a %s started', (event) => {
    const { gh } = github({ workflow_runs: [sweep(8, '2026-10-12T10:33:00Z', { event }), sweep(5, '2026-10-11T09:25:00Z', { event: 'pull_request' })] }, { 8: '{}', 5: '{}' });
    expect(fetch(`by-${event}`, gh)).toMatchObject({ run: '8' });
  });

  it('is of the sweep it is asked for, the core sweep by the name its job uploads its report under', () => {
    const { gh, asked } = github({ workflow_runs: [sweep(8, '2026-10-12T10:33:00Z')] }, { 8: '{}' });
    fetch('core', gh, '99', 'mutation-core');
    expect(asked[1]?.slice(5, 7)).toEqual(['--name', 'mutation-core']);
  });

  it("is never a pull request's from a branch named main, a sweep that did not pass, another branch's, this run's own, or a run no sweep of main starts by", () => {
    const { gh, asked } = github(
      {
        workflow_runs: [
          sweep(9, '2026-10-14T09:00:00Z', { event: 'pull_request' }),
          sweep(8, '2026-10-14T08:00:00Z', { conclusion: 'failure' }),
          sweep(7, '2026-10-14T07:00:00Z', { head_branch: 'ci/a-branch' }),
          sweep(6, '2026-10-14T06:00:00Z'),
          sweep(5, '2026-10-14T05:00:00Z', { event: 'pull_request_target' }),
          sweep(4, '2026-10-14T04:00:00Z'),
        ],
      },
      { 9: '{}', 8: '{}', 7: '{}', 6: '{}', 5: '{}', 4: '{}' },
    );
    expect(fetch('own', gh, '6')).toMatchObject({ run: '4' });
    expect(asked.filter((args) => args[0] === 'run').map((args) => args[2])).toEqual(['4']);
    // And run 6 is what another run is compared with.
    expect(fetch('other', github({ workflow_runs: [sweep(6, '2026-10-14T06:00:00Z'), sweep(4, '2026-10-14T04:00:00Z')] }, { 6: '{}', 4: '{}' }).gh)).toMatchObject({ run: '6' });
  });

  it('is that of the sweep before where the newest no longer has its artifact, or has one with no report in it', () => {
    const runs = { workflow_runs: [sweep(8, '2026-10-12T10:33:00Z'), sweep(5, '2026-10-11T09:25:00Z'), sweep(3, '2026-10-05T10:15:00Z')] };
    const { gh, asked } = github(runs, { 5: '{}', 3: '{}' });
    expect(fetch('before', gh)).toMatchObject({ run: '5', created: '2026-10-11T09:25:00Z' });
    expect(asked.filter((args) => args[0] === 'run').map((args) => args[2])).toEqual(['8', '5']);
    // The page alone, as a sweep that ended before it wrote its report would leave.
    const paged = fetch('page', github(runs, { 8: '<html>', 5: '<html>', 3: '<html>' }, '.', 'index.html').gh);
    expect(paged.reason).toBe("none of main's 3 newest sweeps that passed gave its mutation-full (run 8: its mutation-full holds no mutation.json; run 5: its mutation-full holds no mutation.json; run 3: its mutation-full holds no mutation.json)");
  });

  it('is found where the CLI unpacks one artifact: in the directory asked for, or in one of its name under it, and nowhere else', () => {
    const runs = { workflow_runs: [sweep(8, '2026-10-12T10:33:00Z')] };
    const flat = fetch('flat', github(runs, { 8: '{}' }).gh);
    expect(flat).toMatchObject({ run: '8', file: join(flat.directory, '8', 'mutation.json') });
    const nested = fetch('nested', github(runs, { 8: '{}' }, 'mutation-full').gh);
    expect(nested).toMatchObject({ run: '8', file: join(nested.directory, '8', 'mutation-full', 'mutation.json') });
    expect(fetch('elsewhere', github(runs, { 8: '{}' }, 'mutation-core').gh).reason).toBe("main's one sweep that passed did not give its mutation-full (run 8: its mutation-full holds no mutation.json)");
  });

  it('is none after five sweeps without one, with what GitHub said of each, and the sixth is not asked for', () => {
    const runs = Array.from({ length: 7 }, (_, index) => sweep(index + 1, `2026-10-0${index + 1}T05:00:00Z`));
    const { gh, asked } = github({ workflow_runs: runs });
    expect(fetch('none', gh).reason).toBe(`none of main's 5 newest sweeps that passed gave its mutation-full (${[7, 6, 5, 4, 3].map((id) => `run ${id}: no valid artifacts found to download`).join('; ')})`);
    expect(asked).toHaveLength(6);
  });

  it('is none where main has no sweep that passed, where GitHub does not list them, and where what it gives is no list', () => {
    expect(fetch('empty', github({ workflow_runs: [] }).gh).reason).toBe('main has no sweep that passed');
    expect(fetch('others', github({ workflow_runs: [sweep(9, '2026-10-14T09:00:00Z', { event: 'pull_request' })] }).gh).reason).toBe('main has no sweep that passed');
    const refused = Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Resource not accessible by integration (HTTP 403)\n{"message":"Resource not accessible by integration"}\n' });
    expect(fetch('refused', github(refused).gh).reason).toBe("GitHub gave no list of main's sweeps (gh: Resource not accessible by integration (HTTP 403))");
    expect(fetch('missing', github(Object.assign(new Error('spawnSync gh ENOENT'), { stderr: '' })).gh).reason).toBe("GitHub gave no list of main's sweeps (spawnSync gh ENOENT)");
    expect(fetch('shape', github({ message: 'Not Found' }).gh).reason).toBe("what GitHub gave for main's sweeps is no list of runs");
  });
});

describe('the script', () => {
  const directory = tempDir('compare-script');
  const twice = "const own = read(manifest, 'utf8');\nconst theirs = read(other, 'utf8');\n";
  const save = (name: string, content: unknown): string => {
    const file = join(directory, name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const mains = save('main/mutation.json', report({ 'src/corpus.ts': [WAITING, [NONE_OPEN]], 'src/plugins.ts': [twice, []] }));
  const here = save('mutation-full/mutation.json', report({ 'src/corpus.ts': [WAITING, [NONE_OPEN, mutant(WAITING, "', '", 'StringLiteral', '""')]], 'src/plugins.ts': [twice, [mutant(twice, "'utf8'", 'StringLiteral', '""')]] }));

  /** The script as a person runs it: its exit code and what it printed. */
  const run = (args: readonly string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: directory, env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (error) {
      const failed = error as { status: number; stdout: string; stderr: string };
      return { code: failed.status, out: `${failed.stdout}${failed.stderr}` };
    }
  };

  /** The script called on reports named by hand, outside a job: its exit code and each thing it said. Every process started is seconds on a loaded machine. */
  const byHand = (argv: readonly string[]): { code: number; out: string[] } => {
    const out: string[] = [];
    const code = main(argv, { env: {}, gh: () => '', log: (text) => out.push(text), fail: (text) => out.push(text) });
    return { code, out };
  };

  /** The script as a job runs it, with a `gh` that answers as `runs` and `reports` say. */
  const inJob = (name: string, argv: readonly string[], runs: unknown, reports: Record<number, string>, actions = true): { code: number; out: string; summary: string; asked: string[][] } => {
    const out: string[] = [];
    const summary = join(directory, `${name}.md`);
    const { gh, asked } = github(runs, reports);
    const env = { GITHUB_ACTIONS: actions ? 'true' : '', GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '99' };
    const code = main(argv, { env, gh, directory: join(directory, name), log: (text) => out.push(text), fail: (text) => out.push(text) });
    let written = '';
    try {
      written = readFileSync(summary, 'utf8');
    } catch {
      // Nothing was written to it.
    }
    return { code, out: out.join('\n'), summary: written, asked };
  };
  const listed = { workflow_runs: [sweep(8, '2026-10-12T10:33:00Z')] };

  it("exits 0 with the new ones named, for two reports on disk, main's first, and fails for none of them", () => {
    const { code, out } = run([mains, here]);
    expect(out).toContain('\nnew against main\'s: 2\n  src/corpus.ts  StringLiteral  \', \'  ->  ""  (survived; line 3)\n  src/plugins.ts  StringLiteral  \'utf8\'  ->  ""  (survived; line 1)\n');
    // Which sweep it is, where a person names two files, is the directory the report is in.
    expect(out).toContain(`\nmutation-full: 2 undetected mutants are new against ${mains}. The run is not failed for them: `);
    expect(code).toBe(0);
    const same = byHand([here, here]);
    expect(same.out.join('\n')).toContain("\nnew against main's: 0\n");
    expect(same.out.join('\n')).not.toContain('The run is not failed');
    expect(same.code).toBe(0);
  });

  it("fetches main's report where a job asks, and says in the summary which sweep it set this one beside", () => {
    const got = inJob('fetched', ['--main', 'mutation-full', here], listed, { 8: readFileSync(mains, 'utf8') });
    expect(got.code).toBe(0);
    expect(got.out).toContain("\nmain's newest sweep that passed and has its mutation-full, run 8 of 0000008, 2026-10-12: 1 mutant, 1 undetected: 1 survived and 0 that no test reaches\n");
    expect(got.out).toContain("\n::notice::mutation-full: 2 undetected mutants are new against main's newest sweep that passed and has its mutation-full, run 8 of 0000008, 2026-10-12. The run is not failed for them: ");
    expect(got.summary).toMatch(/^### mutation-full: undetected mutants new against main: 2\n\nSet beside main's newest sweep that passed and has its mutation-full, \[run 8\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/8\) of 0000008, 2026-10-12: 1 undetected there, 3 here\.\n\n```text\nsrc\/corpus\.ts {2}StringLiteral /);
    expect(got.asked.map((args) => args.slice(0, 2).join(' '))).toEqual(['api repos/o/r/actions/workflows/mutation.yml/runs?branch=main&status=success&per_page=30', 'run download']);
    // One new is said as one.
    const single = inJob('single', ['--main', 'mutation-full', here], listed, { 8: JSON.stringify(report({ 'src/corpus.ts': [WAITING, [NONE_OPEN, mutant(WAITING, "', '", 'StringLiteral', '""')]], 'src/plugins.ts': [twice, []] })) });
    expect(single.out).toContain('\n::notice::mutation-full: 1 undetected mutant is new against ');
    expect(single.out).toContain('. The run is not failed for it: ');
  });

  it('exits 0 and says that nothing was compared, as a warning and in the summary, where main has no report to fetch', () => {
    const got = inJob('nothing', ['--main', 'mutation-core', here], { workflow_runs: [] }, {});
    expect(got.code).toBe(0);
    const sentence = 'Not compared with main: main has no sweep that passed. This says nothing of new undetected mutants, neither that there are some nor that there are none; compare the two reports by hand, with this script.';
    expect(got.out).toBe(`::warning::${sentence}`);
    expect(got.summary).toBe(`### mutation-core: undetected mutants new against main: not compared\n\n${sentence}\n\n`);
    // Outside a job the sentence is the same, with nothing before it for a runner to read.
    expect(inJob('nothing-here', ['--main', 'mutation-core', here], { workflow_runs: [] }, {}, false).out).toBe(sentence);
  });

  it('says the same where the artifact is gone, and where the report fetched is none or cannot be read through', () => {
    const gone = inJob('gone', ['--main', 'mutation-full', here], listed, {});
    expect(gone.summary).toContain("### mutation-full: undetected mutants new against main: not compared\n\nNot compared with main: main's one sweep that passed did not give its mutation-full (run 8: no valid artifacts found to download). ");
    const broken = inJob('broken', ['--main', 'mutation-full', here], listed, { 8: '{' });
    expect(broken.summary).toMatch(/^### mutation-full: undetected mutants new against main: not compared\n\nNot compared with main: the mutation-full of run 8 cannot be used \(.*mutation\.json could not be read as a mutation report \(/);
    const empty = inJob('empty', ['--main', 'mutation-full', here], listed, { 8: '{}' });
    expect(empty.summary).toContain('the mutation-full of run 8 cannot be used (main\'s report is no mutation report: it has no "files")');
    const placeless = inJob('placeless', ['--main', 'mutation-full', here], listed, { 8: JSON.stringify({ files: { 'src/corpus.ts': { source: WAITING, mutants: [{ mutatorName: 'StringLiteral', replacement: '""', status: 'Survived' }] } } }) });
    expect(placeless.summary).toContain("the mutation-full of run 8 cannot be used (main's report has a mutant of src/corpus.ts with no place in its source)");
    for (const got of [gone, broken, empty, placeless]) {
      expect(got.code).toBe(0);
      expect(got.out).toMatch(/^::warning::Not compared with main: /);
      expect(got.summary).not.toContain('new against main: none');
      expect(got.summary).not.toContain('src/corpus.ts  ');
    }
  });

  it("exits 2 where this sweep's own report cannot be read, before GitHub is asked anything", () => {
    const missing = inJob('unread', ['--main', 'mutation-full', join(directory, 'missing.json')], listed, { 8: readFileSync(mains, 'utf8') });
    expect(missing.code).toBe(2);
    expect(missing.out).toMatch(/^::error::mutation-compare: .*missing\.json could not be read as a mutation report \(ENOENT/);
    expect(missing.asked).toEqual([]);
    expect(missing.summary).toBe('');
    expect(inJob('unfiled', ['--main', 'mutation-full', save('empty.json', '{}')], { workflow_runs: [] }, {})).toMatchObject({ code: 2, out: '::error::mutation-compare: this sweep\'s report is no mutation report: it has no "files"', asked: [] });
  });

  it('exits 2 for a report named by hand that cannot be read, and for anything but two reports, or --main with an artifact and one', () => {
    expect(byHand([join(directory, 'missing.json'), here])).toMatchObject({ code: 2 });
    expect(byHand([save('broken.json', '{'), here])).toMatchObject({ code: 2 });
    expect(byHand([save('unfiled.json', '{}'), here])).toEqual({ code: 2, out: ['mutation-compare: main\'s report is no mutation report: it has no "files"'] });
    const usage = "usage: node scripts/mutation-compare.mjs <main's mutation.json> <this sweep's mutation.json>\n       node scripts/mutation-compare.mjs --main <artifact> <this sweep's mutation.json>";
    for (const argv of [[], [here], [mains, here, here], ['--main'], ['--main', here], ['--main', 'mutation-full'], ['--main', 'mutation-full', here, here], ['--main', '--main', here], ['--other', here], [mains, '--main'], ['', here], [mains, '']]) {
      expect(byHand(argv), argv.join(' ')).toEqual({ code: 2, out: [usage] });
    }
    // And through the door a person comes in by.
    expect(run([here])).toEqual({ code: 2, out: `${usage}\n` });
  });
});

describe('this repository', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/mutation.yml'), 'utf8');
  const lines = written(workflow);
  const jobs = under(lines, 'jobs');
  const SWEEPS = [
    { job: 'core', artifact: 'mutation-core', report: 'reports/mutation-core/mutation.json', config: 'stryker.core.config.mjs' },
    { job: 'full', artifact: 'mutation-full', report: 'reports/mutation/mutation.json', config: 'stryker.config.mjs' },
  ];

  it.each(SWEEPS)("has the $job sweep's job set its report beside main's, after the sweep and the count, where the score failed too, and never where there is no report", ({ job, artifact, report: file, config }) => {
    const steps = stepsOf(under(jobs, job));
    const counted = steps.findIndex((step) => step.includes(`run: node scripts/mutation-unmeasured.mjs ${file}`));
    const named = steps.findIndex((step) => step.includes(`run: node scripts/mutation-compare.mjs --main ${artifact} ${file}`));
    expect(counted).toBeGreaterThan(steps.findIndex((step) => step.some((line) => /^run: npm run test:mutation/.test(line))));
    expect(named).toBe(counted + 1);
    expect(steps[named]).toEqual([
      'name: Name the undetected mutants that are new against main',
      // Not where the run was cancelled, and not where the sweep ended before it wrote a report.
      `if: \${{ !cancelled() && hashFiles('${file}') != '' }}`,
      'env:',
      '  GH_TOKEN: ${{ github.token }}',
      `run: node scripts/mutation-compare.mjs --main ${artifact} ${file}`,
    ]);
    // The report is the one that sweep's configuration writes.
    expect(readFileSync(join(ROOT, config), 'utf8')).toContain(`jsonReporter: { fileName: '${file}' }`);
    // And the upload after it takes the report where the score failed, under the name the next run fetches it by.
    const upload = steps[named + 1] ?? [];
    expect(upload[0]).toMatch(/^uses: actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.slice(1)).toEqual(['if: always()', 'with:', `  name: ${artifact}`, `  path: ${file.slice(0, file.lastIndexOf('/') + 1)}`, '  if-no-files-found: ignore']);
  });

  it("fetches main's report to where no sweep's upload takes it", () => {
    // `main()` fetches under reports/main/, which git ignores with the rest of reports/.
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("directory = path.join('reports', 'main')");
    for (const { report: file } of SWEEPS) expect(file.startsWith('reports/main/')).toBe(false);
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n')).toContain('reports/');
    // The workflow it lists the runs of is the one that runs it.
    expect(source).toContain("const WORKFLOW = 'mutation.yml';");
  });

  it("lets each sweep's job read Actions, which fetching another run's artifact takes, and gives no job anything it could write with", () => {
    const granted = [...workflow.matchAll(/^( *)permissions:\n((?:\1 +\S.*\n)+)/gm)].map((match) => `${(match[1] ?? '').length}: ${(match[2] ?? '').trim().split(/\n\s*/).join(', ')}`);
    // The workflow's own, then each job's: a job that names its permissions has no other.
    expect(granted).toEqual(['0: contents: read', '4: contents: read, actions: read', '4: contents: read, actions: read']);
    for (const { job } of SWEEPS) expect(under(under(jobs, job), 'permissions')).toEqual(['contents: read', 'actions: read']);
    expect(workflow).not.toMatch(/:\s*write\b|write-all|secrets\./);
    // The token goes to the one step that asks GitHub something, through its environment.
    expect(lines.filter((line) => line.includes('github.token'))).toEqual(['          GH_TOKEN: ${{ github.token }}', '          GH_TOKEN: ${{ github.token }}']);
  });

  it('keeps this file out of both sweeps: it writes to disk, and no mutant is under scripts/', () => {
    expect(vitestCore.test?.exclude).toContain('tests/mutation-compare.test.ts');
    expect(vitestMutation.test?.exclude).toContain('tests/mutation-compare.test.ts');
  });
});
