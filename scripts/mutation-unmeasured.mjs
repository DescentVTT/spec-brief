/**
 * What a sweep leaves unmeasured because it stands under a TypeScript `as`.
 *
 * Stryker 10.0.0 makes no mutant of anything under an `as` expression:
 * `shouldSkip` in its babel transformer asks `isTypeNode`, whose list holds
 * `TSAsExpression`, and the whole subtree is passed over. A table written
 * `{ ... } as const`, the `i - 1` of `lines[i - 1] as string` and the
 * comparator of `[...xs].sort((a, b) => ...)[0] as T` are read by no mutator:
 * the report holds no mutant for them, and the score says nothing of them.
 * `satisfies` and `!` are not on that list. `TSEnumDeclaration` is, so an
 * enum's initialisers are counted here as what stands under an `as` is. On
 * 2026-10-12 this repository had 82 such sites under 47 `as` expressions, 32
 * of them in src/config.ts, by the count this script then made, and now has
 * none (ADR-0009, amended 2026-10-12).
 *
 * This reads each source as a sweep's report holds it, and counts under every
 * outermost `as` the places one of Stryker's mutators applies. A site is a
 * place a mutator applies, not a mutant: each makes one to three. The count
 * is held to the Stryker installed: over a source written with every kind of
 * site, `tests/mutation-unmeasured.test.ts` has Stryker's own instrumenter
 * make no mutant under a cast, and with the casts taken away mutate exactly
 * the places counted (ADR-0009, amended 2026-10-14). An `as` the report does
 * hold a mutant inside is counted as measured, so a Stryker that comes to
 * mutate there fails nothing here.
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
 * source or the parser could not be read, and nothing was counted.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

// From this script to the parser Stryker's `@babel/core` calls. npm may put
// another major of `@babel/parser` at the top of `node_modules` for another
// package, so the name alone is not asked for.
const TO_THE_PARSER = ['@stryker-mutator/core/package.json', '@stryker-mutator/instrumenter/package.json', '@babel/core', '@babel/parser'];

/**
 * The parser Stryker reads a source with. It is Stryker's own dependency and
 * deliberately not one of this package's: a copy pinned here could read a
 * source otherwise than the sweep did. Where it is not installed, which is
 * before `npm ci`, nothing can be counted, and that is said instead of a
 * count of nothing. A source it cannot read is a failure, not a source with
 * nothing in it: nothing is recovered from.
 */
export async function parser(from = import.meta.url) {
  const named = (step) => step.replace('/package.json', '');
  let at = from;
  for (const step of TO_THE_PARSER) {
    try {
      at = createRequire(at).resolve(step);
    } catch {
      throw new UnmeasuredError(`${named(step)} could not be found, on the way to the parser Stryker reads a source with (${TO_THE_PARSER.map(named).join(', then ')}); run "npm ci" first, and if Stryker no longer parses with Babel this script reads a source another way than a sweep does`);
    }
  }
  const { parse } = await import(pathToFileURL(at).href);
  return (/** @type {string} */ source) => parse(source, { sourceType: 'module', plugins: ['typescript'] });
}

// Each list is a mutator of @stryker-mutator/instrumenter 10.0.0
// (`dist/src/mutators`), by the name a report gives its mutants.

// ArithmeticOperator
const ARITHMETIC = new Set(['+', '-', '*', '/', '%']);
// EqualityOperator, and with `&&` and `||` what ConditionalExpression holds true or false
const EQUALITY = new Set(['<', '<=', '>', '>=', '==', '!=', '===', '!==']);
const BOOLEAN = new Set([...EQUALITY, '&&', '||']);
// LogicalOperator
const LOGICAL = new Set(['&&', '||', '??']);
// AssignmentOperator, which leaves a string's `+=` alone
const ASSIGNMENT = new Set(['+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '&&=', '||=', '??=']);
const ASSIGNS_ANYTHING = new Set(['&&=', '||=', '??=']);
// UnaryOperator
const UNARY = new Set(['+', '-', '~']);
// MethodExpression: a method taken away, or swapped for its opposite.
const METHODS = new Set([
  ...['charAt', 'filter', 'reverse', 'slice', 'sort', 'substr', 'substring', 'trim'],
  ...['endsWith', 'startsWith', 'every', 'some', 'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase'],
  ...['trimEnd', 'trimStart', 'min', 'max', 'setDate', 'setTime', 'setFullYear', 'setMonth', 'setHours', 'setMinutes'],
  ...['setSeconds', 'setMilliseconds', 'setUTCDate', 'setUTCFullYear', 'setUTCMonth', 'setUTCHours', 'setUTCMinutes'],
  ...['setUTCSeconds', 'setUTCMilliseconds'],
]);

const isText = (node) => node.type === 'StringLiteral' || node.type === 'TemplateLiteral';
const calls = (node, name) => node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name;

// StringLiteral leaves a string alone where an empty one would change the
// program's shape and not what it does: a key, a module's name, a directive.
function stringIsRead(parent, key) {
  if (parent === undefined) return true;
  if (/^(?:Import|Export)|^TSExternalModuleReference$|^JSXAttribute$|^ExpressionStatement$|^TSLiteralType$|^ObjectMethod$/.test(parent.type)) return false;
  if ((parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && key === 'key') return false;
  return !(calls(parent, 'require') || calls(parent, 'Symbol') || (parent.type === 'CallExpression' && parent.callee.type === 'Import'));
}

/**
 * Whether one of Stryker's mutators applies to this node.
 *
 * `quiet` is whether nothing beneath it is a site: the mutator that takes a
 * statement away does so only where that would be the statement's one
 * mutant. A regular expression counts though Stryker makes nothing of a
 * pattern with no class, quantifier, anchor or group to change, and a
 * constructor's block counts though Stryker leaves some alone: both err
 * towards saying that something is unread.
 */
function site(node, parent, key, quiet) {
  // ConditionalExpression: the test of a loop or an `if`, whatever it is.
  if (key === 'test' && /^(?:If|For|While|DoWhile)Statement$/.test(parent?.type ?? '')) return true;
  switch (node.type) {
    case 'StringLiteral':
      return stringIsRead(parent, key);
    case 'TemplateLiteral':
    case 'BooleanLiteral':
    case 'ArrayExpression':
    case 'UpdateExpression':
      return true;
    case 'RegExpLiteral':
      return node.pattern.length > 0;
    case 'ObjectExpression':
      return node.properties.length > 0;
    case 'BlockStatement':
      return node.body.length > 0;
    case 'ArrowFunctionExpression':
      return node.body.type !== 'BlockStatement' && !(node.body.type === 'Identifier' && node.body.name === 'undefined');
    case 'BinaryExpression': {
      if (BOOLEAN.has(node.operator)) return true;
      // An addition with a string on either side joins text, and is left alone.
      const left = node.left.type === 'BinaryExpression' ? node.left.right : node.left;
      return ARITHMETIC.has(node.operator) && !isText(node.right) && !isText(left);
    }
    case 'LogicalExpression':
      return LOGICAL.has(node.operator);
    case 'UnaryExpression':
      return node.prefix && (node.operator === '!' || UNARY.has(node.operator));
    case 'AssignmentExpression':
      return ASSIGNMENT.has(node.operator) && (ASSIGNS_ANYTHING.has(node.operator) || !isText(node.right));
    case 'ForStatement':
      return node.test === null || node.test === undefined;
    case 'SwitchCase':
      return node.consequent.length > 0;
    case 'OptionalMemberExpression':
      return node.optional === true;
    case 'OptionalCallExpression':
    case 'CallExpression':
    case 'NewExpression': {
      if (node.type === 'OptionalCallExpression' && node.optional === true) return true;
      const { callee } = node;
      // ArrayDeclaration: `Array(3)` and `new Array(3)`.
      if (node.type !== 'OptionalCallExpression' && callee.type === 'Identifier' && callee.name === 'Array') return true;
      if (node.type === 'NewExpression') return false;
      return (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && callee.property.type === 'Identifier' && METHODS.has(callee.property.name);
    }
    case 'ExpressionStatement':
      return quiet && node.expression.type === 'CallExpression' && node.expression.callee.type !== 'Super';
    case 'ThrowStatement':
      return quiet && node.argument.type === 'NewExpression';
    default:
      return false;
  }
}

const NOT_CHILDREN = new Set(['loc', 'start', 'end', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'extra']);

function children(node) {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_CHILDREN.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && typeof item === 'object' && typeof item.type === 'string') out.push([key, item]);
    }
  }
  return out;
}

// What of TypeScript's own syntax holds something a program runs: the
// wrappers around an expression, and an enum down to its initialisers. Every
// other `TS` node is a type, and a type holds nothing a mutator reads.
const HOLDS_CODE = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSEnumDeclaration', 'TSEnumBody']);

function sitesUnder(node, parent, key) {
  if (node.type === 'TSEnumMember') return node.initializer ? sitesUnder(node.initializer, node, 'initializer') : 0;
  if (node.type.startsWith('TS') && !HOLDS_CODE.has(node.type)) return 0;
  let beneath = 0;
  for (const [childKey, child] of children(node)) beneath += sitesUnder(child, node, childKey);
  return beneath + (site(node, parent, key, beneath === 0) ? 1 : 0);
}

// The outermost only: Stryker stops at the first it meets, and one inside it is under it.
function outermost(node, found) {
  if (node.type === 'TSAsExpression' || node.type === 'TSEnumDeclaration') {
    found.push(node);
    return;
  }
  for (const [, child] of children(node)) outermost(child, found);
}

/**
 * Every outermost `as` of a source, and every enum, with a site under it:
 * the line it starts on, the sites, its text on one line, and where it
 * stands, for a report's mutants to be set beside.
 */
export function unmeasured(source, parse) {
  const found = [];
  outermost(parse(source).program, found);
  return found
    .map((node) => ({
      line: node.loc.start.line,
      // From the cast or the enum itself, which is no site: what it holds is read, and the type beside it is not.
      sites: sitesUnder(node, undefined, undefined),
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
 * mutate there, which is nothing while Stryker passes over an `as`. A source
 * the parser cannot read is refused by name: skipped, it would count as a
 * source with nothing under an `as`.
 */
export function measure(report, parse) {
  const rows = [];
  let mutants = 0;
  let mutated = 0;
  for (const [file, { source, mutants: made }] of Object.entries(report.files)) {
    mutants += made.length;
    let found;
    try {
      found = unmeasured(source, parse);
    } catch (error) {
      throw new UnmeasuredError(`${file} could not be parsed, so what stands under an \`as\` in it was not counted (${error instanceof Error ? error.message : String(error)})`);
    }
    for (const row of found) {
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
