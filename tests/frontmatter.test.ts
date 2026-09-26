import { describe, expect, it } from 'vitest';

import {
  editable,
  findEntry,
  isNull,
  keyName,
  parseInline,
  readFrontMatter,
  removeEntry,
  renderScalar,
  setEntry,
  setEntryKeepingComment,
  type YamlValue,
} from '../src/frontmatter.js';

function read(text: string) {
  const fm = readFrontMatter(text.split('\n'));
  if (fm === null) throw new Error('expected front matter');
  return fm;
}

function value(text: string, key = 'k'): YamlValue {
  const entry = findEntry(read(text), key);
  if (entry === undefined) throw new Error(`no ${key}`);
  return entry.value;
}

const scalar = (text: string, quoted = false): YamlValue => ({ kind: 'scalar', scalar: { text, quoted } });

describe('the block', () => {
  it('is absent unless the first line is a delimiter', () => {
    expect(readFrontMatter([])).toBeNull();
    expect(readFrontMatter(['# Title', '---'])).toBeNull();
    expect(readFrontMatter([' ---', 'a: 1', '---'])).toBeNull();
  });

  it('closes on --- or ..., with trailing spaces allowed', () => {
    expect(read('---\na: 1\n---').close).toBe(2);
    expect(read('--- \na: 1\n...  ').close).toBe(2);
  });

  it('reports a block that is never closed and reads nothing from it', () => {
    const fm = read('---\na: 1\nb: 2');
    expect(fm.close).toBe(-1);
    expect(fm.entries).toEqual([]);
    expect(fm.problems).toEqual([{ line: 0, message: 'the front matter opened on line 1 is never closed' }]);
  });

  it('skips blank and comment lines and records each entry with its lines', () => {
    const fm = read('---\n# a comment\n\nstatus: active\ndate: 2026-09-24\n---');
    expect(fm.entries.map((e) => [e.key, e.line, e.end])).toEqual([
      ['status', 3, 4],
      ['date', 4, 5],
    ]);
    expect(fm.problems).toEqual([]);
  });

  it('names keys case- and separator-insensitively', () => {
    expect(keyName('depends-on')).toBe('dependson');
    expect(keyName('Depends_On')).toBe('dependson');
    expect(findEntry(read('---\ndepends-on: [a]\n---'), 'dependsOn')?.key).toBe('depends-on');
    expect(findEntry(null, 'x')).toBeUndefined();
  });

  it('reports lines that are not entries, and duplicate keys', () => {
    const fm = read('---\njust text\n  indented\na: 1\nA: 2\n---');
    expect(fm.problems).toEqual([
      { line: 1, message: 'not a "key: value" line' },
      { line: 2, message: 'an indented line belongs to no key' },
      { line: 4, message: '"A" is declared twice (first on line 4)' },
    ]);
  });
});

describe('scalars', () => {
  it('reads plain values, keeping leading zeros and YAML 1.1 booleans as text', () => {
    expect(value('---\nk: 035\n---')).toEqual(scalar('035'));
    expect(value('---\nk: yes\n---')).toEqual(scalar('yes'));
    expect(value('---\nk: a value # comment\n---')).toEqual(scalar('a value'));
    expect(value('---\nk: a#b\n---')).toEqual(scalar('a#b'));
    expect(value('---\nk:    padded   \n---')).toEqual(scalar('padded'));
    expect(value('---\nk: http://x\n---')).toEqual(scalar('http://x'));
  });

  it('reads an empty value, and a comment-only value, as null', () => {
    const empty = value('---\nk:\n---');
    const comment = value('---\nk: # nothing\n---');
    expect(empty).toEqual(scalar(''));
    expect(comment).toEqual(scalar(''));
  });

  it('reads double-quoted values with their escapes', () => {
    expect(value('---\nk: "a \\"b\\" \\\\ \\/ \\t\\n"\n---')).toEqual(scalar('a "b" \\ / \t\n', true));
    expect(value('---\nk: "\\x41\\u00e9\\U0001F600"\n---')).toEqual(scalar(`A${String.fromCharCode(0xe9)}${String.fromCodePoint(0x1f600)}`, true));
    expect(value('---\nk: "\\0\\b\\f\\r"\n---')).toEqual(scalar('\0\b\f\r', true));
    expect(value('---\nk: "a: b" # fine\n---')).toEqual(scalar('a: b', true));
  });

  it('reads single-quoted values, where two quotes are one', () => {
    expect(value("---\nk: 'it''s'\n---")).toEqual(scalar("it's", true));
    expect(value("---\nk: ''\n---")).toEqual(scalar('', true));
  });

  it('refuses what it cannot read faithfully, and says why', () => {
    const reason = (text: string): string => {
      const v = parseInline(text);
      return v.kind === 'unsupported' ? v.reason : `read as ${v.kind}`;
    };
    expect(reason('"open')).toBe('a double-quoted value is never closed');
    expect(reason("'open")).toBe('a single-quoted value is never closed');
    expect(reason('"a" b')).toBe('text follows a closing quote');
    expect(reason('"a"#b')).toBe('text follows a closing quote');
    expect(reason('"\\q"')).toBe('"\\q" is not an escape this reader knows');
    expect(reason('"\\x4"')).toBe('"\\x" is not an escape this reader knows');
    expect(reason('"\\uZZZZ"')).toBe('"\\u" is not an escape this reader knows');
    expect(reason('"\\UFFFFFFFF"')).toBe('"\\UFFFFFFFF" is not a character');
    expect(reason('{a: 1}')).toBe('inline mappings are not supported');
    expect(reason('|')).toBe('block scalars are not supported; keep the value on one line');
    expect(reason('>-')).toBe('block scalars are not supported; keep the value on one line');
    expect(reason('&anchor x')).toBe('anchors, aliases and tags are not supported');
    expect(reason('*alias')).toBe('anchors, aliases and tags are not supported');
    expect(reason('!tag x')).toBe('anchors, aliases and tags are not supported');
    expect(reason('@x')).toBe('a plain value cannot start with "@"; quote it');
    expect(reason('`x`')).toBe('a plain value cannot start with "`"; quote it');
    expect(reason('Brief 035: the title')).toBe('a plain value cannot contain ": "; quote it');
    expect(reason('ends with:')).toBe('a plain value cannot contain ": "; quote it');
    expect(reason('- a')).toBe('a list must start on the line after its key');
    expect(reason('-')).toBe('a list must start on the line after its key');
    expect(reason('-1')).toBe('read as scalar');
  });

  it('knows null in the core schema, and a quoted null is text', () => {
    for (const text of ['', '~', 'null', 'Null', 'NULL']) expect(isNull({ text, quoted: false })).toBe(true);
    expect(isNull({ text: 'null', quoted: true })).toBe(false);
    expect(isNull({ text: 'nil', quoted: false })).toBe(false);
  });
});

describe('lists', () => {
  it('reads inline lists, quoted items and a trailing comma', () => {
    expect(value('---\nk: [a, "b, c", \'d\']\n---')).toEqual({
      kind: 'list',
      items: [
        { text: 'a', quoted: false },
        { text: 'b, c', quoted: true },
        { text: 'd', quoted: true },
      ],
    });
    expect(value('---\nk: []\n---')).toEqual({ kind: 'list', items: [] });
    expect(value('---\nk: [ a , b, ]\n---')).toEqual({
      kind: 'list',
      items: [
        { text: 'a', quoted: false },
        { text: 'b', quoted: false },
      ],
    });
    expect(value('---\nk: [a] # c\n---')).toEqual({ kind: 'list', items: [{ text: 'a', quoted: false }] });
  });

  it('refuses inline lists it cannot read', () => {
    const reason = (text: string): string => {
      const v = parseInline(text);
      return v.kind === 'unsupported' ? v.reason : `read as ${v.kind}`;
    };
    expect(reason('[a, b')).toBe('an inline list is never closed; keep it on one line');
    expect(reason('[a,')).toBe('an inline list is never closed; keep it on one line');
    expect(reason('[a] b')).toBe('text follows the end of an inline list');
    expect(reason('[[a]]')).toBe('nested lists and mappings are not supported');
    expect(reason('[{a: 1}]')).toBe('nested lists and mappings are not supported');
    expect(reason('[a, , b]')).toBe('an inline list has an empty item');
    expect(reason('[, a]')).toBe('an inline list has an empty item');
    expect(reason('["a" "b"]')).toBe('inline list items must be separated by commas');
    expect(reason('["open]')).toBe('a double-quoted value is never closed');
    expect(reason('[a: b]')).toBe('"a: b" needs quoting inside an inline list');
    expect(reason('[a #b]')).toBe('"a #b" needs quoting inside an inline list');
    expect(reason('[a[b]')).toBe('"a[b" needs quoting inside an inline list');
  });

  it('reads block lists, indented or not, and quoted items', () => {
    const expected = { kind: 'list', items: [{ text: 'a', quoted: false }, { text: 'b c', quoted: true }] };
    expect(value('---\nk:\n  - a\n  - "b c"\n---')).toEqual(expected);
    expect(value('---\nk:\n- a\n- "b c"\nnext: 1\n---')).toEqual(expected);
    expect(value('---\nk:\n  - a # one\n\n  # between\n  - "b c"\n---')).toEqual(expected);
  });

  it('ends a block list at the next key, and records where it ends', () => {
    const fm = read('---\nk:\n  - a\n\nnext: 1\n---');
    expect(fm.entries.map((e) => [e.key, e.line, e.end])).toEqual([
      ['k', 1, 3],
      ['next', 4, 5],
    ]);
  });

  it('refuses block values it cannot read', () => {
    const reason = (text: string): string => {
      const v = value(text);
      return v.kind === 'unsupported' ? v.reason : `read as ${v.kind}`;
    };
    expect(reason('---\nk:\n  sub: 1\n---')).toBe('nested mappings are not supported; flatten the key');
    expect(reason('---\nk:\n  folded text\n---')).toBe('the value continues on the next line; keep it on one line, or quote it');
    expect(reason('---\nk: first\n  second\n---')).toBe('the value continues on the next line; keep it on one line, or quote it');
    // Quoting it, as the advice above says, would turn the list into a string.
    expect(reason('---\nk:\n  [src/**]\n---')).toBe('an inline list starts on the line after its key; write it after the colon');
    expect(reason('---\nk:\n  - a\n    - b\n---')).toBe('a list item is continued or nested; keep each item on one line');
    expect(reason('---\nk:\n  - a\n  more\n---')).toBe('a list item is continued or nested; keep each item on one line');
    expect(reason('---\nk:\n  -\n---')).toBe('a list item is empty');
    expect(reason('---\nk:\n  - # only a comment\n---')).toBe('a list item is empty');
    expect(reason('---\nk:\n  - [a]\n---')).toBe('nested lists are not supported');
    expect(reason('---\nk:\n  - {a: 1}\n---')).toBe('inline mappings are not supported');
  });
});

describe('rendering', () => {
  it('writes plain words plain and anything ambiguous quoted', () => {
    expect(renderScalar('archived')).toBe('archived');
    expect(renderScalar('sha256-abc/+')).toBe('sha256-abc/+');
    expect(renderScalar('Two words')).toBe('Two words');
    expect(renderScalar('035')).toBe('"035"');
    expect(renderScalar('yes')).toBe('"yes"');
    expect(renderScalar('Null')).toBe('"Null"');
    expect(renderScalar('~')).toBe('"~"');
    expect(renderScalar('a: b')).toBe('"a: b"');
    expect(renderScalar('trailing ')).toBe('"trailing "');
    expect(renderScalar('')).toBe('""');
    expect(renderScalar('-x')).toBe('"-x"');
  });

  it('round-trips what it renders', () => {
    for (const text of ['archived', '035', 'yes', 'a: b', 'say "hi"', "it's", 'tab\there', 'x #y']) {
      expect(parseInline(renderScalar(text))).toEqual(expect.objectContaining({ kind: 'scalar', scalar: expect.objectContaining({ text }) }));
    }
  });
});

describe('editing', () => {
  const lines = ['---', 'status: proposed', 'deps:', '  - a', '  - b', 'date: 2026-09-24', '---', '', '# T'];

  it('replaces an entry in place, keeping its key spelling and every other line', () => {
    const fm = readFrontMatter(lines);
    expect(setEntry(lines, fm, 'STATUS', 'archived')).toEqual([
      '---',
      'status: archived',
      'deps:',
      '  - a',
      '  - b',
      'date: 2026-09-24',
      '---',
      '',
      '# T',
    ]);
    expect(setEntry(lines, fm, 'deps', '[c]')).toEqual(['---', 'status: proposed', 'deps: [c]', 'date: 2026-09-24', '---', '', '# T']);
  });

  it('appends a new entry before the closing delimiter', () => {
    expect(setEntry(lines, readFrontMatter(lines), 'integrity', 'x').slice(5, 8)).toEqual(['date: 2026-09-24', 'integrity: x', '---']);
  });

  it('adds a block to a file without one, and refuses an unclosed one', () => {
    expect(setEntry(['# T'], null, 'status', 'active')).toEqual(['---', 'status: active', '---', '# T']);
    const unclosed = ['---', 'a: 1'];
    expect(() => setEntry(unclosed, readFrontMatter(unclosed), 'b', '2')).toThrow('never closed');
  });

  it('keeps a comment after a single-line value when asked to, and nothing else', () => {
    const commented = ['---', 'status: proposed # the word we use', 'deps:', '  - a # first', 'wave: 2  # after the review', 'empty: # none yet', 'hash: 2#x', 'quoted: "x" # q', '---'];
    const fm = readFrontMatter(commented);
    const set = (key: string, value: string): string | undefined => setEntryKeepingComment(commented, fm, key, value).find((l) => l.startsWith(`${key}:`));
    expect(set('wave', '3')).toBe('wave: 3  # after the review');
    expect(set('status', 'archived')).toBe('status: archived # the word we use');
    expect(set('empty', '1')).toBe('empty: 1 # none yet');
    expect(set('quoted', 'y')).toBe('quoted: y # q');
    // A "#" with no space before it is part of the value, not a comment.
    expect(set('hash', '3')).toBe('hash: 3');
    // A block value is rewritten whole, as setEntry does, and a key that is new has no comment to keep.
    expect(setEntryKeepingComment(commented, fm, 'deps', '[b]')).toEqual(setEntry(commented, fm, 'deps', '[b]'));
    expect(setEntryKeepingComment(commented, fm, 'new', '1')).toEqual(setEntry(commented, fm, 'new', '1'));
    expect(setEntryKeepingComment(['# T'], null, 'wave', '1')).toEqual(['---', 'wave: 1', '---', '# T']);
  });

  it('removes an entry with its value lines, and a missing key changes nothing', () => {
    expect(removeEntry(lines, readFrontMatter(lines), 'deps')).toEqual(['---', 'status: proposed', 'date: 2026-09-24', '---', '', '# T']);
    expect(removeEntry(lines, readFrontMatter(lines), 'absent')).toEqual(lines);
    expect(removeEntry(['# T'], null, 'x')).toEqual(['# T']);
  });
});

describe('what spec-brief reads with spec-core\'s reader', () => {
  it('recognises TOML front matter, reads nothing from it, and says so', () => {
    const fm = readFrontMatter(['+++', 'status = "active"', '+++', '', '# T']);
    expect(fm).toEqual({ kind: 'toml', close: 2, entries: [], problems: [{ line: 0, message: 'TOML front matter is not read; write YAML between "---" lines' }] });
  });

  it('writes only into YAML front matter that is closed', () => {
    expect(editable(read('---\na: 1\n---'))).toBe(true);
    expect(editable(read('---\na: 1'))).toBe(false);
    expect(editable(read('+++\na = 1\n+++'))).toBe(false);
  });

  it('keeps the lines of a brief whose line holds a carriage return that ends nothing', () => {
    const lines = ['---', 'a: 1\rb', 'c: 2', '---'];
    const fm = readFrontMatter(lines);
    expect(fm?.entries.map((e) => [e.key, e.line])).toEqual([
      ['a', 1],
      ['c', 2],
    ]);
    expect(setEntry(lines, fm, 'c', '3')).toEqual(['---', 'a: 1\rb', 'c: 3', '---']);
  });
});
