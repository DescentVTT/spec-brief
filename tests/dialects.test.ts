import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ConflictError, TransactionError } from '../src/apply.js';
import { BANNER_OPEN, idFromName, parseBrief } from '../src/brief.js';
import { collisionFindings, collisions } from '../src/collisions.js';
import { ConfigError, DEFAULT_CONFIG, initialConfig, resolveConfig } from '../src/config.js';
import { dependencyCycles, duplicateIds, findBriefs, idKey, resolveDependency } from '../src/corpus.js';
import { isNull, parseInline, readFrontMatter, renderScalar } from '../src/frontmatter.js';
import { globBase, intersectGlobs, matchGlob, parseGlob } from '../src/glob.js';
import { integrityOf } from '../src/integrity.js';
import { isRelativeTarget, relativePath, rewriteLinks, splitTarget } from '../src/links.js';
import { lint, sortFindings } from '../src/lint.js';
import { scan } from '../src/markdown.js';
import { matrixJson, prettyMatrix } from '../src/report.js';
import { renderNewBrief, nextId } from '../src/scaffold.js';
import { schedule } from '../src/schedule.js';
import { toJsonSchema, validate } from '../src/schema.js';
import { labelMatches, lineEnding, normaliseLabel, slugify } from '../src/text.js';
import { brief, config, corpusOf, goodBrief } from './helpers.js';

/**
 * The exact edges of each dialect: where a pattern is anchored, where a range
 * ends, which spelling is refused. Each assertion is a case the neighbouring
 * reading would get wrong.
 */

const matches = (pattern: string, path: string): boolean => {
  const parsed = parseGlob(pattern);
  if (!parsed.ok) throw new Error(parsed.error);
  return matchGlob(parsed.glob, path);
};
const glob = (pattern: string) => {
  const parsed = parseGlob(pattern);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.glob;
};
const lines = (text: string): string[] => text.split('\n');

describe('front matter', () => {
  it('opens and closes only on whole delimiter lines', () => {
    expect(readFrontMatter(['---x', 'a: 1', '---'])).toBeNull();
    expect(readFrontMatter(['---', 'a: 1', '---x', '---'])?.close).toBe(3);
    expect(readFrontMatter(['---', 'a: 1', 'x---', '---'])?.close).toBe(3);
    expect(readFrontMatter(['---', 'a: 1', '...x'])?.close).toBe(-1);
  });

  it('reads a key only at the start of a line, with a space or nothing after the colon', () => {
    const fm = readFrontMatter(['---', 'key:value', 'x a: 1', 'b:\tc', 'd:  e', '---']);
    expect(fm?.problems.map((p) => p.message)).toEqual(['not a "key: value" line', 'not a "key: value" line']);
    expect(fm?.entries.map((e) => [e.key, e.value])).toEqual([
      ['b', { kind: 'scalar', scalar: { text: 'c', quoted: false } }],
      ['d', { kind: 'scalar', scalar: { text: 'e', quoted: false } }],
    ]);
  });

  it('reads a sequence item only as a dash followed by a space', () => {
    const fm = readFrontMatter(['---', 'k:', '  -a', '---']);
    expect(fm?.entries[0]?.value).toEqual({ kind: 'unsupported', reason: 'the value continues on the next line; keep it on one line, or quote it' });
    const tab = readFrontMatter(['---', 'k:', '-\ta', '---']);
    expect(tab?.entries[0]?.value).toEqual({ kind: 'list', items: [{ text: 'a', quoted: false }] });
    const dashed = readFrontMatter(['---', 'k:', '---']);
    expect(dashed?.entries[0]?.end).toBe(2);
  });

  it('takes a following column-0 dash line into a block, and nothing past the closing delimiter', () => {
    const fm = readFrontMatter(['---', 'k:', '- a', '-', '---', '- after']);
    expect(fm?.close).toBe(4);
    expect(fm?.entries[0]?.value).toEqual({ kind: 'unsupported', reason: 'a list item is empty' });
  });

  it('keeps a hash with no space before it as part of a value, and a trailing comment after a space off it', () => {
    expect(parseInline('a#b #c')).toEqual({ kind: 'scalar', scalar: { text: 'a#b', quoted: false } });
    expect(parseInline('#x')).toEqual({ kind: 'scalar', scalar: { text: '#x', quoted: false } });
    expect(parseInline('"a"\t# c')).toEqual({ kind: 'scalar', scalar: { text: 'a', quoted: true } });
    expect(parseInline('-x')).toEqual({ kind: 'scalar', scalar: { text: '-x', quoted: false } });
    expect(parseInline('a:b')).toEqual({ kind: 'scalar', scalar: { text: 'a:b', quoted: false } });
    expect(parseInline('a :b')).toEqual({ kind: 'scalar', scalar: { text: 'a :b', quoted: false } });
  });

  it('reads escapes by their exact width, and refuses a code point past Unicode', () => {
    expect(parseInline('"\\x41B"')).toEqual({ kind: 'scalar', scalar: { text: 'AB', quoted: true } });
    expect(parseInline('"\\u0041"')).toEqual({ kind: 'scalar', scalar: { text: 'A', quoted: true } });
    expect(parseInline('"\\U0010FFFF"').kind).toBe('scalar');
    expect(parseInline('"\\U00110000"')).toEqual({ kind: 'unsupported', reason: '"\\U00110000" is not a character' });
    expect(parseInline('"\\x4G"')).toEqual({ kind: 'unsupported', reason: '"\\x" is not an escape this reader knows' });
    expect(parseInline('"\\xG4"')).toEqual({ kind: 'unsupported', reason: '"\\x" is not an escape this reader knows' });
    expect(parseInline('"\\"')).toEqual({ kind: 'unsupported', reason: 'a double-quoted value is never closed' });
  });

  it('reads the last item of an inline list up to the bracket', () => {
    expect(parseInline('[a,b]')).toEqual({ kind: 'list', items: [{ text: 'a', quoted: false }, { text: 'b', quoted: false }] });
    expect(parseInline('[ "a" ]')).toEqual({ kind: 'list', items: [{ text: 'a', quoted: true }] });
    expect(parseInline('[a ]')).toEqual({ kind: 'list', items: [{ text: 'a', quoted: false }] });
    expect(parseInline('["a"')).toEqual({ kind: 'unsupported', reason: 'an inline list is never closed; keep it on one line' });
  });

  it('quotes a word YAML 1.1 would read as a boolean, and only a whole word', () => {
    expect(renderScalar('offer')).toBe('offer');
    expect(renderScalar('nonsense')).toBe('nonsense');
    expect(renderScalar('ON')).toBe('"ON"');
    expect(isNull({ text: '~', quoted: false })).toBe(true);
  });
});

describe('Markdown', () => {
  it('opens a fence only where the line starts with it, and closes it only with a bare fence', () => {
    expect(scan(lines('text ```\n# heading')).headings.map((h) => h.text)).toEqual(['heading']);
    expect(scan(lines('```\n``` x\n# in\n```\n# out')).headings.map((h) => h.text)).toEqual(['out']);
    expect(scan(lines('~~~\n```\n# in\n~~~\n# out')).headings.map((h) => h.text)).toEqual(['out']);
    expect(scan(lines('````\n```\n# in\n````\n# out')).headings.map((h) => h.text)).toEqual(['out']);
  });

  it('reads a heading only with a space or nothing after its marks', () => {
    expect(scan(lines('##\ttab')).headings.map((h) => h.text)).toEqual(['tab']);
    expect(scan(lines('#hash')).headings).toEqual([]);
    expect(scan(lines('x ## no')).headings).toEqual([]);
    expect(scan(lines('## Title ###  ')).headings[0]?.text).toBe('Title');
    expect(scan(lines('## C# #')).headings[0]?.text).toBe('C#');
    expect(scan(lines('## a#b')).headings[0]?.text).toBe('a#b');
    expect(scan(lines('## ##')).headings[0]?.text).toBe('');
  });

  it('reads a box only as a list marker, a space, and a box followed by a space or nothing', () => {
    const s = scan(lines('x - [ ] no\n10. [x] ten\n- [ ]  two spaces\n-  [ ] wide\n1234567890. [ ] too long\n5a. [ ] no'));
    expect(s.tasks.map((t) => [t.line, t.text])).toEqual([
      [1, 'ten'],
      [2, 'two spaces'],
      [3, 'wide'],
    ]);
  });

  it('ends an item at a numbered sibling and a quote, and not at a line that starts like one', () => {
    const s = scan(lines('- [ ] a\n12. next\n- [ ] b\n>quote\n- [ ] c\n5a. text\n- [ ] d\n  > nested quote'));
    expect(s.tasks.map((t) => [t.line, t.end])).toEqual([
      [0, 1],
      [2, 3],
      [4, 6],
      [6, 8],
    ]);
  });

  it('masks a comment closed at the start of a line, and one that opens a line and never closes to the end', () => {
    const s = scan(lines('<!--\n--> after\n<!-- a --> b\n<!-- never closed\n## hidden'));
    expect(s.prose.map((l) => l.trim())).toEqual(['', 'after', 'b', '', '']);
    expect(s.headings).toEqual([]);
  });

  it('reads a <!-- in the middle of a line with no --> after it as text, and what follows as Markdown', () => {
    // 0.1 masked from there to the end of the document, hiding every section below.
    const s = scan(lines('<!-- a --> b <!-- c\n## Tasks\n- [ ] d'));
    expect(s.prose.map((l) => l.trim())).toEqual(['b <!-- c', '## Tasks', '- [ ] d']);
    expect(s.headings.map((h) => h.text)).toEqual(['Tasks']);
    expect(s.tasks.map((t) => t.text)).toEqual(['d']);
  });

  it('keeps text after a code span, and an unmatched run as the start of text', () => {
    const s = scan(lines('``a`b`` and [x](y.md)\n` open [z](w.md)'));
    expect(s.links.map((l) => l.target)).toEqual(['y.md', 'w.md']);
    expect(s.prose[1]).toBe('` open [z](w.md)');
  });

  it('reads a definition only at the start of a line, and a title only in its forms', () => {
    const s = scan(lines('x [a]: b.md\n[b]: c.md\n[c]: d.md "t" extra\n[d]: e.md (t)\n[e]: <f g.md> "t"'));
    expect(s.links.map((l) => l.target)).toEqual(['c.md', 'e.md', 'f g.md']);
  });

  it('reads a link after an earlier one on the same line, and the second of two definitions', () => {
    const s = scan(lines('[a](b.md) [c](d.md) [e](f.md)'));
    expect(s.links.map((l) => [l.start, l.target])).toEqual([
      [4, 'b.md'],
      [14, 'd.md'],
      [24, 'f.md'],
    ]);
  });
});

describe('globs', () => {
  it('reads a literal as a file however it is spelt, and a trailing slash as a directory', () => {
    for (const literal of ['src/a.ts.d', '.github', 'src/a.', 'a.b/c', 'Makefile']) {
      expect(matches(literal, `${literal}/x`), literal).toBe(false);
      expect(matches(literal, literal), literal).toBe(true);
    }
    expect(matches('src/v1.x/', 'src/v1.x/a')).toBe(true);
  });

  it('refuses a backslash before a letter or a digit, or at the end, and reads it before anything else as an escape', () => {
    for (const bad of ['a\\b', 'a\\1', 'a\\']) expect(parseGlob(bad).ok, bad).toBe(false);
    expect(matches('a\\-b', 'a-b')).toBe(true);
    expect(matches('a\\.b', 'a.b')).toBe(true);
    expect(matches('a\\[b', 'a[b')).toBe(true);
  });

  it('strips every leading ./, drops . segments and empty ones', () => {
    expect(matches('././src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/./a.ts', 'src/a.ts')).toBe(true);
    expect(matches('src//a.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/a.ts', './src/./a.ts')).toBe(true);
    expect(matches('src/a.ts', 'src//a.ts')).toBe(true);
    expect(matches('x./a', 'x./a')).toBe(true);
  });

  it('keeps braces inside a class literal, whatever the class starts with', () => {
    expect(matches('x{a,[}]}', 'x}')).toBe(true);
    expect(matches('x{a,[}]}', 'xa')).toBe(true);
    expect(matches('x{a,[!}]}', 'xb')).toBe(true);
    expect(matches('x{a,[!}]}', 'x}')).toBe(false);
    expect(matches('x{a,[^}]}', 'x}')).toBe(false);
    expect(matches('x{a,[]}]}', 'x]')).toBe(true);
    expect(matches('x{a,[!]}]}', 'x]')).toBe(false);
    // A class cannot hold a slash: a match never crosses one.
    expect(parseGlob('x[/]{a,b}').ok).toBe(false);
  });

  it('counts nested braces when splitting alternatives, and allows exactly the limit', () => {
    expect(glob('{a,{b,c}}').literals.map((l) => l.path)).toEqual(['a', 'b', 'c']);
    expect(glob('{{a,b},c}').literals.map((l) => l.path)).toEqual(['a', 'b', 'c']);
    expect(glob('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}').literals).toHaveLength(256);
    expect(parseGlob('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}').ok).toBe(false);
    expect(parseGlob('{a,{b}').ok).toBe(false);
    expect(parseGlob('{a,[b}').ok).toBe(false);
    expect(glob('{a\\,b}').literals.map((l) => l.path)).toEqual(['a,b']);
  });

  it('reads classes with escapes, dashes and a first bracket', () => {
    expect(matches('[\\]]', ']')).toBe(true);
    expect(matches('[a\\-z]', '-')).toBe(true);
    expect(matches('[a\\-z]', 'm')).toBe(false);
    expect(matches('[a-]', 'b')).toBe(false);
    expect(matches('[-a]', '-')).toBe(true);
    expect(matches('[!]a]', 'b')).toBe(true);
    expect(matches('[!]a]', ']')).toBe(false);
    expect(matches('[^a]', 'a')).toBe(false);
    expect(parseGlob('[!]').ok).toBe(false);
    expect(parseGlob('[\\').ok).toBe(false);
  });

  it('never matches a path of no segments, and a class never matches the slash it cannot contain', () => {
    expect(matches('**', '')).toBe(false);
    expect(matches('**', '/')).toBe(false);
    expect(matches('*', '.')).toBe(false);
    expect(matches('a[!x]b', 'a/b')).toBe(false);
    expect(matches('a?b', 'a/b')).toBe(false);
  });

  it('decides intersections by exact characters, not by any character', () => {
    expect(intersectGlobs(glob('a/b'), glob('a/c'))).toBeNull();
    expect(intersectGlobs(glob('a/[bc]'), glob('a/[de]'))).toBeNull();
    expect(intersectGlobs(glob('a/x?'), glob('a/*y'))).toBe('a/xy');
    expect(intersectGlobs(glob('*.ts'), glob('a*'))).toBe('a.ts');
    expect(intersectGlobs(glob('**/b'), glob('a/**'))).toBe('a/b');
    expect(intersectGlobs(glob('a/**/c'), glob('a/b/**'))).toBe('a/b/c');
    expect(intersectGlobs(glob('x/{a,b}'), glob('x/b'))).toBe('x/b');
  });

  it('roots a glob in its literal directories', () => {
    expect(globBase(glob('src/*/x.ts'))).toBe('src');
    expect(globBase(glob('src/a*/b'))).toBe('src');
    expect(globBase(glob('{src,lib}/a.ts'))).toBe('src');
    expect(globBase(glob('src/lib'))).toBe('src');
    expect(globBase(glob('src/lib/'))).toBe('src/lib');
  });
});

describe('text', () => {
  it('keeps LF for a file whose first newline has no carriage return before it', () => {
    expect(lineEnding('\r\n')).toBe('\r\n');
    expect(lineEnding('a\r')).toBe('\n');
    expect(lineEnding('\n\r\n')).toBe('\n');
  });

  it('strips a leading number only at the start, in each spelling', () => {
    expect(normaliseLabel('12.3.4) Report')).toBe('report');
    expect(normaliseLabel('1 Report')).toBe('report');
    expect(normaliseLabel('10.2 Report')).toBe('report');
    expect(normaliseLabel('2.Report')).toBe('2.report');
    expect(normaliseLabel('Phase 1. Two')).toBe('phase 1. two');
    expect(normaliseLabel('x12. y')).toBe('x12. y');
    expect(normaliseLabel('Mission:  ')).toBe('mission');
    expect(normaliseLabel('a: b')).toBe('a: b');
  });

  it('matches a qualifier only after the name and a separator', () => {
    expect(labelMatches(': anything', '')).toBe(false);
    expect(labelMatches('Scope: x', 'Other')).toBe(false);
    expect(labelMatches('Reportly (draft)', 'Report')).toBe(false);
    expect(labelMatches('Report(draft)', 'Report')).toBe(true);
  });

  it('keeps inner hyphens of a slug and cuts at the last break', () => {
    expect(slugify('--a--b--')).toBe('a-b');
    expect(slugify('ab cd ef', 5)).toBe('ab-cd');
    expect(slugify('ab cd ef', 4)).toBe('ab');
    expect(slugify('abcdef', 3)).toBe('abc');
  });
});

describe('links', () => {
  it('reads a scheme only at the start of a destination', () => {
    expect(isRelativeTarget('notes/a:b.md')).toBe(true);
    expect(isRelativeTarget('1http:x')).toBe(true);
    expect(splitTarget('?q')).toEqual({ path: '', suffix: '?q' });
    expect(splitTarget('a#b?c')).toEqual({ path: 'a', suffix: '#b?c' });
  });

  it('leaves a destination with no path, and keeps an unencoded one unencoded', () => {
    const s = scan(lines('[q](?x=1) [a](<a b.md>) [p](a(b).md)'));
    expect(rewriteLinks(s, 'x', 'x/y', (p) => p).lines).toEqual(['[q](?x=1) [a](<../a b.md>) [p](../a(b).md)']);
  });

  it('climbs out of a directory deeper than the target', () => {
    expect(relativePath('a/b/c', 'a/x')).toBe('../../x');
    expect(relativePath('a', 'a/b/c')).toBe('b/c');
  });
});

describe('the corpus', () => {
  it('orders briefs by path whatever order the files come in', () => {
    const corpus = corpusOf({ 'briefs/003_c.md': goodBrief(), 'briefs/001_a.md': goodBrief(), 'briefs/002_b.md': goodBrief() });
    expect(corpus.briefs.map((b) => b.id)).toEqual(['001', '002', '003']);
  });

  it('keys an id as a number only when it is all digits', () => {
    expect(idKey('12a')).toBe('12a');
    expect(idKey('007')).toBe('7');
    expect(findBriefs(corpusOf({ 'briefs/12a_x.md': goodBrief() }), '12a').map((b) => b.id)).toEqual(['12a']);
  });

  it('finds a brief by a path written with . and .. segments, and nothing outside the repository', () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief() });
    expect(findBriefs(corpus, 'briefs/./x/../001_a.md').map((b) => b.id)).toEqual(['001']);
    expect(findBriefs(corpus, '../outside.md')).toEqual([]);
  });

  it('prefers a live brief to an archived one of the same id, whichever sorts first', () => {
    const cfg = config({ briefs: 'zz', archive: 'aa' });
    const corpus = corpusOf({ 'aa/005_old.md': goodBrief({ status: 'archived' }), 'zz/005_new.md': goodBrief() }, cfg);
    expect(corpus.briefs[0]?.file).toBe('aa/005_old.md');
    expect(resolveDependency(corpus, '5')?.file).toBe('zz/005_new.md');
    const archivedOnly = corpusOf({ 'aa/006_x.md': goodBrief({ status: 'archived' }) }, cfg);
    expect(resolveDependency(archivedOnly, '6')?.file).toBe('aa/006_x.md');
  });

  it('lists only ids more than one brief claims', () => {
    const corpus = corpusOf({ 'briefs/001_a.md': goodBrief(), 'briefs/001_b.md': goodBrief(), 'briefs/002_c.md': goodBrief() });
    expect([...duplicateIds(corpus).keys()]).toEqual(['1']);
    const noId = corpusOf({ 'briefs/a.md': goodBrief(), 'briefs/b.md': goodBrief() }, config({ id: { source: 'frontmatter' }, files: '*.md' }));
    expect(duplicateIds(noId).size).toBe(0);
  });

  it('finds a cycle a cross edge to a finished component must not hide', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ dependsOn: '[002]' }),
      'briefs/002_b.md': goodBrief({ dependsOn: '[001]' }),
      'briefs/003_c.md': goodBrief({ dependsOn: '[001, 004]' }),
      'briefs/004_d.md': goodBrief({ dependsOn: '[003]' }),
    });
    expect(dependencyCycles(corpus).map((c) => c.map((b) => b.id))).toEqual([
      ['001', '002', '001'],
      ['003', '004', '003'],
    ]);
  });

  it('reports the shortest way round, found breadth first', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ dependsOn: '[002, 003]' }),
      'briefs/002_b.md': goodBrief({ dependsOn: '[004]' }),
      'briefs/003_c.md': goodBrief({ dependsOn: '[004]' }),
      'briefs/004_d.md': goodBrief({ dependsOn: '[001]' }),
    });
    expect(dependencyCycles(corpus).map((c) => c.map((b) => b.id))).toEqual([['001', '002', '004', '001']]);
  });

  it('leaves archived and unknown dependencies out of the graph', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ dependsOn: '[002, 999]' }),
      'briefs/archive/002_b.md': goodBrief({ status: 'archived', dependsOn: '[001]' }),
    });
    expect(dependencyCycles(corpus)).toEqual([]);
  });
});

describe('collisions', () => {
  it('asks the tree whether a literal path is a directory, and reads it as a file otherwise', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[build]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["**/x"]' }),
    });
    expect(collisions(corpus).waves[0]?.collisions).toEqual([]);
    expect(collisions(corpus, { repoFiles: null }).waves[0]?.collisions).toEqual([]);
    expect(collisions(corpus, { repoFiles: ['build'] }).waves[0]?.collisions).toEqual([]);
    const tree = collisions(corpus, { repoFiles: ['build/y'] });
    expect(tree.waves[0]?.collisions.flatMap((c) => c.overlaps.map((o) => o.witness))).toEqual(['build/x']);
  });

  it('leaves deferred briefs out of every wave, and lists them', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/**]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', status: 'deferred', trigger: 'when x', affectedFiles: '[src/**]' }),
      'briefs/003_c.md': goodBrief({ status: 'deferred', trigger: 'when y' }),
    });
    for (const report of [collisions(corpus), collisions(corpus, { all: true })]) {
      expect(report.waves.map((w) => w.briefs.map((b) => b.id))).toEqual([['001']]);
      expect(report.deferred.map((b) => b.id)).toEqual(['002', '003']);
      expect(report.unscheduled).toEqual([]);
      expect(matrixJson(report)['deferred']).toEqual(['002', '003']);
    }
    expect(prettyMatrix(collisions(corpus), { color: false }).split('\n').slice(-1)).toEqual(['deferred: 002, 003']);
    expect(prettyMatrix(collisions(corpus), { color: true }).split('\n').slice(-1)).toEqual([`${String.fromCharCode(27)}[2mdeferred: 002, 003${String.fromCharCode(27)}[22m`]);
    const only = corpusOf({ 'briefs/002_b.md': goodBrief({ status: 'deferred', trigger: 'when x' }) });
    expect(prettyMatrix(collisions(only), { color: false })).toBe('deferred: 002');
  });

  it('leaves out a brief that waits on deferred work, as schedule places it nowhere, and says what it waits on', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/**]' }),
      'briefs/002_b.md': goodBrief({ status: 'deferred', trigger: 'when x', affectedFiles: '[lib/**]' }),
      // Waits on 002, and in its declared wave would collide with 001.
      'briefs/003_c.md': goodBrief({ wave: '1', dependsOn: '[2]', affectedFiles: '[src/auth/**]' }),
      // Waits through 003, and declares no wave: waiting, not unscheduled.
      'briefs/004_d.md': goodBrief({ dependsOn: '[1, 3]', affectedFiles: '[src/auth/x.ts]' }),
    });
    const s = schedule(corpus);
    expect(s.placements.map((p) => [p.brief.id, p.declared, p.proposed])).toEqual([['001', 1, 1]]);
    for (const report of [collisions(corpus), collisions(corpus, { all: true })]) {
      expect(report.waves.map((w) => w.briefs.map((b) => b.id))).toEqual([['001']]);
      expect(report.waiting.map((w) => [w.brief.id, w.waitsOn.id])).toEqual([
        ['003', '002'],
        ['004', '003'],
      ]);
      expect(report.waiting.map((w) => w.brief)).toEqual(s.unplaced.map((u) => u.brief));
      expect(report.unscheduled).toEqual([]);
      expect(collisionFindings(corpus, report)).toEqual([]);
      expect(matrixJson(report)['waiting']).toEqual([
        { id: '003', file: 'briefs/003_c.md', waitsOn: '002' },
        { id: '004', file: 'briefs/004_d.md', waitsOn: '003' },
      ]);
    }
    expect(prettyMatrix(collisions(corpus), { color: false }).split('\n').slice(-3)).toEqual([
      'waits: 003 on 002, which is deferred',
      'waits: 004 on 003, which waits on deferred work',
      'deferred: 002',
    ]);
  });

  it('names a file as the witness, never the directory a trailing globstar is under', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[docs/adr/**]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[docs/adr/**]' }),
    });
    expect(collisions(corpus).waves[0]?.collisions[0]?.overlaps).toEqual([{ patterns: ['docs/adr/**', 'docs/adr/**'], witness: 'docs/adr/x' }]);
  });

  it('counts no collision on a file either brief protects', () => {
    const pair = (b: string) =>
      corpusOf({
        'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/**]', protectedFiles: '[src/db/schema.ts]' }),
        'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: b }),
      });
    expect(collisions(pair('[src/db/schema.ts]')).waves[0]?.collisions).toEqual([]);
    expect(collisions(pair('[src/db/*.ts]')).waves[0]?.collisions.map((c) => c.overlaps[0]?.witness)).toEqual(['src/db/.ts']);
  });

  it('shows a pair it could not decide as undecided, in the terminal and in JSON', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[src/**]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["**/*.ts", "**/*.md"]' }),
    });
    const report = collisions(corpus, { budget: 1 });
    expect(report.waves[0]?.collisions).toEqual([]);
    expect(report.waves[0]?.shared).toEqual([]);
    expect(prettyMatrix(report, { color: false }).split('\n')).toEqual([
      'wave 1 · 2 briefs',
      '       001  002',
      '  001    ·    ?',
      '  002    ?    ·',
      '  ? 001 "src/**" and 002 "**/*.ts": undecided within the search\'s budget',
      '    001 "src/**" and 002 "**/*.md": undecided within the search\'s budget',
    ]);
    expect(matrixJson(report).waves).toEqual([
      {
        wave: 1,
        briefs: ['001', '002'],
        collisions: [],
        undecided: [{ a: '001', b: '002', patterns: [['src/**', '**/*.ts'], ['src/**', '**/*.md']] }],
        sharedDirectories: [],
        unscoped: [],
      },
    ]);
    // Undecided is neither: with the budget it needs, the pair collides.
    expect(collisions(corpus).waves[0]?.collisions).toHaveLength(1);
    expect(collisions(corpus, { budget: 1 }).waves[0]?.undecided).toHaveLength(1);
    expect(collisionFindings(corpus, report).map((f) => [f.rule, f.brief, f.file])).toEqual([['collision-undecided', '002', 'briefs/002_b.md']]);
    const esc = String.fromCharCode(27);
    const painted = prettyMatrix(report, { color: true });
    expect(painted).toContain(`  001    ·    ${esc}[33m?${esc}[39m`);
    expect(painted).toContain(`  ${esc}[33m?${esc}[39m 001 "src/**" and 002 "**/*.ts": undecided`);
    const quiet = corpusOf(Object.fromEntries(corpus.briefs.map((b) => [b.file, b.text])), config({ rules: { 'collision-undecided': 'off' } }));
    expect(collisionFindings(quiet, report)).toEqual([]);
  });

  it('reports no shared directory at the root, and several in order, as one pair', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '["**/a.ts", y/1.ts, x/1.ts]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '["**/b.ts", y/2.ts, x/2.ts]' }),
    });
    expect(collisions(corpus).waves[0]?.shared.map((s) => s.directories)).toEqual([['x', 'y']]);
  });

  it('orders waves by number, and reports no unscoped brief alone in its wave', () => {
    const corpus = corpusOf({
      'briefs/001_a.md': goodBrief({ wave: '10' }),
      'briefs/002_b.md': goodBrief({ wave: '9' }),
      'briefs/003_c.md': goodBrief({ wave: '2' }),
    });
    const report = collisions(corpus);
    expect(report.waves.map((w) => w.wave)).toEqual([2, 9, 10]);
    expect(report.waves.flatMap((w) => w.unscoped)).toEqual([]);
  });

  it('carries the brief each finding is about, and says nothing about a rule switched off', () => {
    const files = {
      'briefs/001_a.md': goodBrief({ wave: '1', affectedFiles: '[a/x.ts]' }),
      'briefs/002_b.md': goodBrief({ wave: '1', affectedFiles: '[a/x.ts]' }),
      'briefs/003_c.md': goodBrief({ wave: '1', affectedFiles: '[a/y.ts]' }),
      'briefs/004_d.md': goodBrief({ wave: '1' }),
    };
    const loud = corpusOf(files, config({ rules: { 'shared-directory': 'note' } }));
    expect(collisionFindings(loud, collisions(loud)).map((f) => [f.rule, f.brief])).toEqual([
      ['collision', '002'],
      ['shared-directory', '003'],
      ['shared-directory', '003'],
      ['unscoped', '004'],
    ]);
    const quiet = corpusOf(files, config({ rules: { collision: 'off', unscoped: 'off' } }));
    expect(collisionFindings(quiet, collisions(quiet))).toEqual([]);
  });
});

describe('configuration', () => {
  it('has the defaults the README documents', () => {
    const section = (name: string, extra: Record<string, unknown> = {}) => ({ name, aliases: [], mustContain: [], checklist: false, optional: false, ...extra });
    expect(DEFAULT_CONFIG).toEqual({
      briefs: 'briefs',
      archive: 'briefs/archive',
      files: '[0-9]*.md',
      exclude: [],
      template: null,
      id: { source: 'filename', separator: '_', digits: 3 },
      status: { field: 'status', draft: 'draft', active: 'active', deferred: 'deferred', archived: 'archived' },
      sections: [
        section('Intent', { aliases: ["Commander's Intent", 'Mission', 'Objective'], hint: 'The state of the tree when this round is done, and why it matters. One paragraph.' }),
        section('Negative Scope', {
          aliases: ['Out of Scope', 'Non-Goals', 'Not in Scope', 'What this round is NOT', 'What this brief does NOT do'],
          hint: 'What this round must not do, even where it would look helpful.',
        }),
        section('Not Empowered', { aliases: ['Non-Empowerment', 'Non-Empowerment List'], optional: true, hint: 'Files, interfaces and decisions this round may not change.' }),
        section('Invariants', { aliases: ['Invariant Checklist', 'Definition of Done'], checklist: true, hint: 'Checks that must hold before the round is called done, each one a task item.' }),
      ],
      sectionOrder: false,
      types: {
        feature: [section('Acceptance Criteria', { checklist: true, hint: 'What a reviewer checks to accept the result, each one a task item.' })],
        defect: [section('The Defect, Measured', { aliases: ['Reproduction'], hint: 'How to reproduce the defect, and the measurement that shows it.' })],
        refactor: [],
        chore: [],
      },
      placeholders: ['TBD', 'TBA', 'TODO', 'FIXME', 'XXX', '???', '...', '\u2026'],
      fields: [],
      archiving: {
        tasks: 'all',
        dispositions: ['**Delegated', '**Accepted debt', '**Rejected'],
        banner: [
          '**Archived {date}.**',
          '{summary}',
          'Merged in pull request {pr}.',
          'Recorded at commit `{commit}`: {diffstat}.',
          '{links}',
          'The body below describes the tree before execution and is not maintained.',
        ],
        rewriteLinks: true,
        freeze: true,
        base: null,
      },
      rules: {},
      plugins: [],
    });
  });

  it('writes out for init every section with its aliases, its switches and its hint', () => {
    expect(initialConfig('b', 'b/done')).toEqual({
      $schema: './node_modules/@descent-vtt/spec-brief/schema.json',
      briefs: 'b',
      archive: 'b/done',
      files: '[0-9]*.md',
      id: { source: 'filename', separator: '_', digits: 3 },
      status: { field: 'status', draft: 'draft', active: 'active', deferred: 'deferred', archived: 'archived' },
      sections: [
        { name: 'Intent', aliases: ["Commander's Intent", 'Mission', 'Objective'], hint: 'The state of the tree when this round is done, and why it matters. One paragraph.' },
        {
          name: 'Negative Scope',
          aliases: ['Out of Scope', 'Non-Goals', 'Not in Scope', 'What this round is NOT', 'What this brief does NOT do'],
          hint: 'What this round must not do, even where it would look helpful.',
        },
        { name: 'Not Empowered', aliases: ['Non-Empowerment', 'Non-Empowerment List'], optional: true, hint: 'Files, interfaces and decisions this round may not change.' },
        { name: 'Invariants', aliases: ['Invariant Checklist', 'Definition of Done'], checklist: true, hint: 'Checks that must hold before the round is called done, each one a task item.' },
      ],
      types: {
        feature: { sections: [{ name: 'Acceptance Criteria', checklist: true, hint: 'What a reviewer checks to accept the result, each one a task item.' }] },
        defect: { sections: [{ name: 'The Defect, Measured', aliases: ['Reproduction'], hint: 'How to reproduce the defect, and the measurement that shows it.' }] },
        refactor: { sections: [] },
        chore: { sections: [] },
      },
      archiving: { tasks: 'all', dispositions: ['**Delegated', '**Accepted debt', '**Rejected'], banner: DEFAULT_CONFIG.archiving.banner, base: null },
    });
  });

  it('names the file, and each problem, in the error', () => {
    const error = (() => {
      try {
        resolveConfig({ briefs: 1, archive: 2 });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error('no error');
    })();
    expect(error.name).toBe('ConfigError');
    expect(error.message).toBe('configuration: "briefs" must be a string; "archive" must be a string');
  });

  it('compares directories as the repository resolves them, and refuses one outside it', () => {
    const problems = (raw: unknown): readonly string[] => {
      try {
        resolveConfig(raw);
        return [];
      } catch (e) {
        return (e as ConfigError).problems;
      }
    };
    expect(problems({ briefs: 'b', archive: 'b/./' })).toEqual(['"briefs" and "archive" must be different directories']);
    expect(problems({ briefs: 'b', archive: 'x/../b' })).toEqual(['"briefs" and "archive" must be different directories']);
    expect(problems({ briefs: '../b' })).toEqual([
      '"briefs" must be a directory inside the repository, not "../b"',
      '"archive" must be a directory inside the repository, not "../b/archive"',
    ]);
    expect(problems({ archive: '../../x' })).toEqual(['"archive" must be a directory inside the repository, not "../../x"']);
    expect(problems({ status: { draft: 'Done', active: 'done' } })).toEqual(['the status words must differ: "Done" is the word for draft and active; give one of them another word']);
    expect(problems({ archiving: { banner: ['{nope}'] } })).toEqual([
      '"archiving.banner" uses {nope}; the placeholders are {date}, {summary}, {pr}, {commit}, {diffstat}, {links}, {id}, {title}, {author}',
    ]);
  });
});

describe('the schema language', () => {
  it('holds a null to nullable strings only, and a number to integers only', () => {
    expect(validate({ type: 'string' }, null)).toEqual(['the configuration must be a string']);
    expect(validate({ type: 'boolean' }, 1)).toEqual(['the configuration must be true or false']);
    expect(validate({ type: 'integer' }, 'x')).toEqual(['the configuration must be an integer']);
    expect(validate({ type: 'map', values: { type: 'string' } }, [])).toEqual(['the configuration must be an object']);
  });

  it('holds each bound exactly', () => {
    expect(validate({ type: 'integer', minimum: 1 }, 1)).toEqual([]);
    expect(validate({ type: 'integer', maximum: 3 }, 3)).toEqual([]);
    expect(validate({ type: 'string', minLength: 2 }, 'ab')).toEqual([]);
    expect(validate({ type: 'string', minLength: 2 }, 'a')).toEqual(['the configuration must not be empty']);
    expect(validate({ type: 'string', enum: ['a'] }, 'a')).toEqual([]);
  });

  it('suggests a key an edit away at every position', () => {
    expect(validate({ type: 'object', properties: { briefs: { type: 'string' } } }, { briefx: 'a' })).toEqual([
      '"briefx" is not a known key; did you mean "briefs"?',
    ]);
    expect(validate({ type: 'object', properties: { briefs: { type: 'string' } } }, { xriefs: 'a' })).toEqual([
      '"xriefs" is not a known key; did you mean "briefs"?',
    ]);
  });

  it('leaves out of JSON Schema what the description leaves out', () => {
    expect(toJsonSchema({ type: 'string' })).toEqual({ type: 'string' });
    expect(toJsonSchema({ type: 'integer' })).toEqual({ type: 'integer' });
    expect(toJsonSchema({ type: 'boolean', description: 'd' })).toEqual({ description: 'd', type: 'boolean' });
  });
});

describe('briefs', () => {
  it('reads the id before the separator, and the whole stem without one', () => {
    expect(idFromName('035_the-thing.md', '_')).toBe('035');
    expect(idFromName('B-12.MD', '_')).toBe('B-12');
    expect(idFromName('x.md.md', '_')).toBe('x.md');
    expect(idFromName('_x.md', '_')).toBe('_x');
  });

  it('reads status words by the configured field, and archived ones from location alone when there is none', () => {
    const cfg = config({ status: { field: 'state', draft: null, active: 'open', archived: 'closed' } });
    expect(parseBrief('briefs/001_a.md', '---\nstate: OPEN\n---\n', cfg, 'live').status).toBe('active');
    expect(parseBrief('briefs/001_a.md', '---\nstate: draft\n---\n', cfg, 'live').status).toBeNull();
    expect(parseBrief('briefs/001_a.md', '---\nstate: closed\n---\n', cfg, 'archived').status).toBe('archived');
    const located = config({ status: { field: null } });
    expect(parseBrief('briefs/001_a.md', '---\nstatus: x\n---\n', located, 'archived').status).toBe('archived');
    expect(parseBrief('briefs/001_a.md', '---\nstatus: x\n---\n', located, 'live').status).toBe('active');
    expect(parseBrief('briefs/001_a.md', '---\nstatus: x\n---\n', located, 'live').statusWord).toBeNull();
  });

  it('reads a wave only as unquoted digits, and reports the rest at their line', () => {
    expect(brief('---\nwave: 12\n---\n').wave).toBe(12);
    for (const text of ['1a', 'a1', '1.5', '-1', '1234567890']) {
      const b = brief(`---\nstatus: active\nwave: ${text}\n---\n`);
      expect(b.wave, text).toBeNull();
      expect(b.problems, text).toEqual([{ field: 'wave', line: 2, message: `"wave" must be a whole number, not "${text}"` }]);
    }
    expect(brief('---\nwave:\n---\n').problems).toEqual([]);
  });

  it('reads lists with every item trimmed, and refuses an empty one', () => {
    expect(brief('---\ndependsOn:\n  - " a "\n  - b\n---\n').dependsOn).toEqual(['a', 'b']);
    expect(brief('---\ndependsOn: [" "]\n---\n').problems.map((p) => p.message)).toEqual(['"dependsOn" must not contain an empty item']);
    expect(brief('---\ndependsOn: [~]\n---\n').problems.map((p) => p.message)).toEqual(['"dependsOn" must not contain an empty item']);
    expect(brief('---\naffectedFiles: "src/**"\n---\n').affectedFiles).toEqual(['src/**']);
    expect(brief('---\nprotectedFiles: {a}\n---\n').problems.map((p) => p.field)).toEqual(['protectedFiles']);
  });

  it('reads the title from the front matter first, and an empty heading as none', () => {
    expect(brief('---\ntitle: From front matter\n---\n# From heading\n').title).toBe('From front matter');
    expect(brief('# \n').title).toBeNull();
    expect(brief('## Not a title\n').title).toBeNull();
  });

  it('reads a trimmed id, and no id from a blank one', () => {
    const cfg = config({ id: { source: 'frontmatter' }, files: '*.md' });
    expect(parseBrief('b/x.md', '---\nid: " B-1 "\n---\n', cfg, 'live').id).toBe('B-1');
    expect(parseBrief('b/x.md', '---\nid: " "\n---\n', cfg, 'live').id).toBeNull();
  });

  it('reads a banner only below the front matter, from its first marker to the next closing one', () => {
    const b = brief(`---\nstatus: archived\n---\n${BANNER_OPEN}\n> a\n<!-- /spec-brief:banner -->\n\n<!-- /spec-brief:banner -->\n`);
    expect(b.banner).toEqual({ start: 3, end: 6 });
    expect(brief(`${BANNER_OPEN}\n<!-- /spec-brief:banner -->\n`).banner).toEqual({ start: 0, end: 2 });
    expect(brief(`---\nx: ${BANNER_OPEN}\n---\n`).banner).toBeNull();
    expect(brief(`<!-- /spec-brief:banner -->\n${BANNER_OPEN}\n`).banner).toBeNull();
    expect(brief(`  ${BANNER_OPEN}  \n  <!-- /spec-brief:banner -->\n`).banner).toEqual({ start: 0, end: 2 });
  });

  it('starts the body after a closed front matter, and at the top when it is never closed', () => {
    expect(brief('---\na: 1\n---\n# T\n').bodyStart).toBe(3);
    expect(brief('---\na: 1\n# T\n').bodyStart).toBe(0);
  });
});

describe('scaffolding', () => {
  it('allocates only after all-digit ids', () => {
    expect(nextId(corpusOf({ 'briefs/5a_x.md': goodBrief(), 'briefs/3_y.md': goodBrief() }))).toBe('004');
  });

  it('writes a hint for each default section, and the fields it was given', () => {
    const text = renderNewBrief(DEFAULT_CONFIG, { id: '1', title: 'T', date: '2026-09-24', type: 'feature', wave: 0, dependsOn: ['a'] }, null);
    expect(text).toContain('<!-- The state of the tree when this round is done, and why it matters. One paragraph. -->');
    expect(text).toContain('<!-- What this round must not do, even where it would look helpful. -->');
    expect(text).toContain('<!-- Files, interfaces and decisions this round may not change. -->');
    expect(text).toContain('<!-- Checks that must hold before the round is called done, each one a task item. -->');
    expect(text).toContain('<!-- What a reviewer checks to accept the result, each one a task item. -->');
    expect(text).toContain('type: feature\nwave: 0\ndependsOn: ["a"]\n');
    const bare = renderNewBrief(DEFAULT_CONFIG, { id: '1', title: 'T', date: '2026-09-24' }, null);
    expect(bare).not.toContain('type:');
    expect(bare).not.toContain('wave:');
    expect(bare).not.toContain('dependsOn');
    expect(bare).not.toContain('Acceptance Criteria');
    expect(renderNewBrief(DEFAULT_CONFIG, { id: '1', title: 'T', date: '2026-09-24', dependsOn: [] }, null)).not.toContain('dependsOn');
  });

  it('fills a template with the fields it was given', () => {
    const text = renderNewBrief(DEFAULT_CONFIG, { id: '7', title: 'T', date: 'd', type: 'chore', wave: 3 }, '{id}/{title}/{date}/{type}/{wave}/{status}');
    expect(text).toBe('7/T/d/chore/3/draft');
  });
});

describe('lint', () => {
  it('refuses a misspelt rule before it runs anything', async () => {
    await expect(lint(corpusOf({}, config({ rules: { nope: 'off' } })))).rejects.toThrow('"rules.nope" names no rule');
  });

  it('keeps a finding at the severity its rule chose when it chose none', async () => {
    const found = await lint(corpusOf({ 'briefs/001_a.md': goodBrief({ owner: 'x' }) }));
    expect(found.map((f) => f.severity)).toEqual(['warning']);
  });

  it('orders by file, then line, then rule, then message', () => {
    const f = (file: string, line: number, rule: string, message: string) => ({ file, line, rule, message, severity: 'error' as const });
    const input = [f('a', 1, 'z', 'b'), f('a', 1, 'z', 'a'), f('a', 1, 'y', 'c'), f('b', 1, 'a', 'a'), f('a', 2, 'a', 'a')];
    expect(sortFindings(input).map((x) => `${x.file}${x.line}${x.rule}${x.message}`)).toEqual(['a1yc', 'a1za', 'a1zb', 'a2aa', 'b1aa']);
    expect(sortFindings([...input].reverse()).map((x) => `${x.file}${x.line}${x.rule}${x.message}`)).toEqual(['a1yc', 'a1za', 'a1zb', 'a2aa', 'b1aa']);
  });
});

describe('the transaction and the freeze', () => {
  it('names its errors', () => {
    expect(new ConflictError('x').name).toBe('ConflictError');
    expect(new TransactionError(new Error('e'), true, []).name).toBe('TransactionError');
    expect(new TransactionError(new Error('e'), false, ['a: b', 'c: d']).message).toBe(
      'e; the rollback also failed (a: b; c: d), so check these files by hand',
    );
  });

  it('hashes every line but its own, joined by LF with a final LF', () => {
    const text = '---\nstatus: archived\nintegrity: sha256-x\n---\n\n# T\n';
    const expected = createHash('sha256').update('---\nstatus: archived\n---\n\n# T\n', 'utf8').digest('hex');
    expect(integrityOf(text)).toBe(`sha256-${expected}`);
    expect(integrityOf('# T')).toBe(`sha256-${createHash('sha256').update('# T\n', 'utf8').digest('hex')}`);
  });
});
