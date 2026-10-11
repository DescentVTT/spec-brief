/**
 * What a sweep leaves unmeasured because it stands under a TypeScript `as`.
 *
 * Stryker 10.0.0 makes no mutant of anything under an `as` expression:
 * `shouldSkip` in its babel transformer asks `isTypeNode`, whose list holds
 * `TSAsExpression`, and the whole subtree is passed over. A table written
 * `{ ... } as const`, the `i - 1` of `lines[i - 1] as string` and the
 * comparator of `[...xs].sort((a, b) => ...)[0] as T` are read by no mutator:
 * the report holds no mutant for them, and the score says nothing of them.
 * `satisfies` and `!` are not on that list. On 2026-10-12 this repository had
 * 82 such sites under 47 `as` expressions, 32 of them in src/config.ts, and
 * now has none (ADR-0009, amended 2026-10-12).
 *
 * This reads each source as a sweep's report holds it, and counts under every
 * outermost `as` the nodes one of Stryker's mutators would have had a site
 * at. A site is a place a mutator applies, not a mutant: each makes one to
 * three. An `as` the report does hold a mutant inside is counted as measured,
 * so a Stryker that comes to mutate there fails nothing here.
 *
 *   node scripts/mutation-unmeasured.mjs [report]
 *   node scripts/mutation-unmeasured.mjs --sources <file>...
 *
 * The first reads a sweep's `mutation.json`, the full sweep's where none is
 * named, and is what the mutation workflow runs after each sweep. The second
 * reads sources as they stand, before any sweep has read them.
 *
 * Exit 0: no file has more sites under an `as` than `LEFT` records for it.
 * Exit 1: one has, or has fewer, and each is listed. Exit 2: the report, a
 * source or the parser could not be read.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The sites that stay under an `as`, by file as the report names it. A file
 * joins this only where no rewrite keeps the types the compiler sees, with a
 * comment at the code saying what stands under the `as` and why; the ways
 * out are a cast on a name, `!`, `satisfies`, an annotation, and `literal`
 * in src/literal.ts.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const LEFT = {};

const DEFAULT_REPORT = 'reports/mutation/mutation.json';

/** What went wrong before anything could be counted: exit 2, with its message alone. */
export class UnmeasuredError extends Error {}

/**
 * The parser Stryker reads a source with. It is Stryker's own dependency and
 * deliberately not one of this package's: a copy pinned here could read a
 * source otherwise than the sweep did. Where it is not installed, which is
 * before `npm ci`, nothing can be counted, and that is said instead of a
 * count of nothing.
 */
export async function parser() {
  try {
    const { parse } = await import('@babel/parser');
    return (/** @type {string} */ source) => parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true });
  } catch (error) {
    throw new UnmeasuredError(`@babel/parser could not be loaded (${error instanceof Error ? error.message : String(error)}); @stryker-mutator/core brings it, so run "npm ci" first`);
  }
}

// The methods Stryker's MethodExpression mutator replaces or removes.
const METHODS = new Set(['endsWith', 'startsWith', 'trim', 'trimEnd', 'trimStart', 'toUpperCase', 'toLowerCase', 'toLocaleUpperCase', 'toLocaleLowerCase', 'substring', 'substr', 'slice', 'charAt', 'some', 'every', 'min', 'max', 'sort', 'reverse', 'filter']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
const EQUALITY = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==']);

/** Whether one of Stryker's mutators has a site at this node. */
function site(node, parent, key) {
  switch (node.type) {
    case 'StringLiteral':
      // Not a property's name, a type written as a string or the module an import names.
      if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod' || parent.type === 'ClassProperty') && key === 'key') return false;
      if (parent.type === 'TSLiteralType' || parent.type === 'ImportExpression') return false;
      return !(parent.type === 'CallExpression' && (parent.callee.type === 'Import' || (parent.callee.type === 'Identifier' && (parent.callee.name === 'require' || parent.callee.name === 'Symbol'))));
    case 'TemplateLiteral':
    case 'BooleanLiteral':
    case 'ConditionalExpression':
    case 'LogicalExpression':
    case 'UpdateExpression':
    case 'ArrayExpression':
    case 'RegExpLiteral':
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ForStatement':
    case 'SwitchCase':
      return true;
    case 'ObjectExpression':
      return node.properties.length > 0;
    case 'BlockStatement':
      return node.body.length > 0;
    case 'ArrowFunctionExpression':
      return node.body.type !== 'BlockStatement';
    case 'BinaryExpression':
      return ARITHMETIC.has(node.operator) || EQUALITY.has(node.operator);
    case 'UnaryExpression':
      return node.operator === '!' || node.operator === '-' || node.operator === '+';
    case 'AssignmentExpression':
      return node.operator !== '=';
    case 'OptionalMemberExpression':
    case 'OptionalCallExpression':
      return node.optional === true;
    case 'CallExpression': {
      const callee = node.callee;
      return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee.property.type === 'Identifier' && METHODS.has(callee.property.name);
    }
    default:
      return false;
  }
}

const NOT_CHILDREN = new Set(['loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra']);

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_CHILDREN.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push([key, item]);
    } else if (value && typeof value.type === 'string') {
      out.push([key, value]);
    }
  }
  return out;
}

/** The expressions that only say a type and still hold what runs. */
const HOLDS_CODE = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);

function sitesUnder(node, parent, key) {
  // A type holds nothing a mutator reads.
  if (node.type.startsWith('TS') && !HOLDS_CODE.has(node.type)) return 0;
  let count = site(node, parent, key) ? 1 : 0;
  for (const [childKey, child] of children(node)) count += sitesUnder(child, node, childKey);
  return count;
}

function outermost(node, found) {
  if (node.type === 'TSAsExpression') {
    found.push(node);
    return;
  }
  for (const [, child] of children(node)) outermost(child, found);
}

/**
 * Every outermost `as` of a source with a site under it: the line it starts
 * on, the sites, its text on one line, and where it stands, for a report's
 * mutants to be set beside.
 */
export function unmeasured(source, parse) {
  const found = [];
  outermost(parse(source).program, found);
  return found
    .map((node) => ({
      line: node.loc.start.line,
      sites: sitesUnder(node.expression, node, 'expression'),
      text: source.slice(node.start, node.end).replace(/\s+/g, ' '),
      loc: { start: { line: node.loc.start.line, column: node.loc.start.column }, end: { line: node.loc.end.line, column: node.loc.end.column } },
    }))
    .filter((row) => row.sites > 0);
}

/** Whether a mutant of the report stands inside the expression. The report counts columns from one, the parser from zero. */
function inside(loc, mutant) {
  const { start, end } = mutant.location;
  const afterStart = start.line > loc.start.line || (start.line === loc.start.line && start.column - 1 >= loc.start.column);
  const beforeEnd = end.line < loc.end.line || (end.line === loc.end.line && end.column - 1 <= loc.end.column);
  return afterStart && beforeEnd;
}

/**
 * The same for every source a report holds: what stands under an `as` and
 * no mutant of the report is inside, and beside it what the report did
 * mutate there, which is nothing while Stryker passes over an `as`.
 */
export function measure(report, parse) {
  const rows = [];
  let mutants = 0;
  let mutated = 0;
  for (const [file, { source, mutants: made }] of Object.entries(report.files)) {
    mutants += made.length;
    for (const row of unmeasured(source, parse)) {
      const within = made.filter((mutant) => inside(row.loc, mutant)).length;
      if (within > 0) mutated += within;
      else rows.push({ file, line: row.line, sites: row.sites, text: row.text });
    }
  }
  return { files: Object.keys(report.files), mutants, mutated, rows };
}

/**
 * What the count has to say against the record, one line a file. More sites
 * than recorded is a site nobody measures; fewer is a record that has
 * outlived what it stood for, and would let the next one in unseen.
 */
export function gate(measured, left = LEFT) {
  const problems = [];
  for (const file of measured.files) {
    const rows = measured.rows.filter((row) => row.file === file);
    const sites = rows.reduce((sum, row) => sum + row.sites, 0);
    const allowed = left[file] ?? 0;
    if (sites > allowed) {
      const where = rows.map((row) => `  ${file}:${row.line}  ${row.sites} under  ${brief(row.text)}`).join('\n');
      problems.push(`${file} has ${sites} site(s) under an \`as\`, which no mutant is made of, where ${allowed} may stay:\n${where}`);
    } else if (sites < allowed) {
      problems.push(`${file} has ${sites} site(s) under an \`as\`, where LEFT in scripts/mutation-unmeasured.mjs records ${allowed}: lower it`);
    }
  }
  return problems;
}

function brief(text) {
  return text.length > 110 ? `${text.slice(0, 70)} ... ${text.slice(-30)}` : text;
}

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new UnmeasuredError(`${file} could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
}

function reportAt(file) {
  const text = read(file);
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    throw new UnmeasuredError(`${file} is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const files = report?.files;
  // A package.json has "files" too: a report's are sources, each with its mutants.
  const sources = typeof files === 'object' && files !== null && !Array.isArray(files) && Object.values(files).every((entry) => typeof entry?.source === 'string' && Array.isArray(entry.mutants));
  if (!sources) throw new UnmeasuredError(`${file} is no mutation report: it has no "files" that are sources with their mutants`);
  return report;
}

export async function main(argv, out = console.log) {
  let measured;
  let what;
  try {
    const parse = await parser();
    if (argv[0] === '--sources') {
      const names = argv.slice(1);
      if (names.length === 0) throw new UnmeasuredError('--sources needs the files to read: node scripts/mutation-unmeasured.mjs --sources src/*.ts');
      // Named as a report names a file, so that LEFT reads both alike.
      const files = Object.fromEntries(names.map((name) => [name.replaceAll('\\', '/'), { source: read(name), mutants: [] }]));
      measured = measure({ files }, parse);
      what = `${names.length} source(s) as they stand`;
    } else {
      const file = argv[0] ?? DEFAULT_REPORT;
      measured = measure(reportAt(file), parse);
      what = `${file}: ${measured.files.length} mutated file(s), ${measured.mutants} mutant(s)`;
    }
  } catch (error) {
    if (!(error instanceof UnmeasuredError)) throw error;
    out(`mutation-unmeasured: ${error.message}`);
    return 2;
  }
  const sites = measured.rows.reduce((sum, row) => sum + row.sites, 0);
  out(`${what}`);
  out(`${sites} site(s) stand under ${measured.rows.length} \`as\` expression(s) that no mutant is made of`);
  if (measured.mutated > 0) out(`${measured.mutated} mutant(s) of the report stand inside an \`as\`: this Stryker mutates there, and those are counted as measured`);
  const problems = gate(measured);
  for (const problem of problems) out(problem);
  if (problems.length > 0) {
    out('Take what a mutator reads out from under the `as`: a cast on a name, `!`, `satisfies`, an annotation, or `literal` (src/literal.ts). ADR-0009, amended 2026-10-12, has the reason.');
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
