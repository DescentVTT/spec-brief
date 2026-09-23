import { describe, expect, it } from 'vitest';

import { hasContent, linksOf, scan, sectionsOf, titleOf } from '../src/markdown.js';

const lines = (text: string): string[] => text.split('\n');

describe('masking', () => {
  it('blanks fenced blocks in structure and keeps them as content', () => {
    const s = scan(lines('```ts\n## not a heading\n```\n## real'));
    expect(s.headings.map((h) => h.text)).toEqual(['real']);
    expect(s.masked[1]?.trim()).toBe('');
    expect(s.prose[1]).toBe('## not a heading');
  });

  it('closes a fence only with the same character, at least as long, and nothing after it', () => {
    const s = scan(lines('````\n```\n~~~~\n```` trailing\n````\n# after'));
    expect(s.headings.map((h) => h.line)).toEqual([5]);
    const tilde = scan(lines('~~~\n# in\n~~~~\n# out'));
    expect(tilde.headings.map((h) => h.text)).toEqual(['out']);
  });

  it('does not open a backtick fence whose info string holds a backtick', () => {
    const s = scan(lines('``` a`b\n# heading'));
    expect(s.headings.map((h) => h.text)).toEqual(['heading']);
  });

  it("opens a fence at any indentation, as a list item's fence is, and a heading at three spaces at most", () => {
    expect(scan(lines('   ```\n# in\n```\n# out')).headings.map((h) => h.text)).toEqual(['out']);
    expect(scan(lines('    ```\n# hidden\n    ```\n# visible')).headings.map((h) => h.text)).toEqual(['visible']);
    expect(scan(lines('   ## three')).headings.length).toBe(1);
    expect(scan(lines('    ## four')).headings.length).toBe(0);
  });

  it('keeps boxes and links in a fence inside a nested list item out of the structure', () => {
    const s = scan(lines('- [x] item\n  - nested\n\n    ```md\n    - [ ] write the thing\n    [x](../foo.md)\n    ```'));
    expect(s.tasks.map((t) => t.text)).toEqual(['item']);
    expect(linksOf(s)).toEqual([]);
  });

  it('blanks comments in both masks, across lines, and resumes after them', () => {
    const s = scan(lines('a <!-- hint\nstill hint\nend --> b\n<!-- ## not -->'));
    expect(s.prose).toEqual([`a${' '.repeat(10)}`, ' '.repeat(10), `${' '.repeat(8)}b`, ' '.repeat(15)]);
    expect(s.masked).toEqual(s.prose);
    expect(s.headings).toEqual([]);
  });

  it('does not treat a fence inside a comment as a fence', () => {
    const s = scan(lines('<!--\n```\n-->\n# heading'));
    expect(s.headings.map((h) => h.text)).toEqual(['heading']);
  });

  it('blanks code spans in structure only, matching runs of equal length', () => {
    const s = scan(lines('see `a ]( b` and ``x ` y`` end'));
    expect(s.masked[0]).toBe(`see ${' '.repeat(8)} and ${' '.repeat(9)} end`);
    expect(s.prose[0]).toBe('see `a ]( b` and ``x ` y`` end');
  });

  it('keeps an unmatched backtick run as text', () => {
    expect(scan(lines('a `` b ` c')).masked[0]).toBe('a `` b ` c');
  });

  it('keeps a comment opener inside a code span as code', () => {
    const s = scan(lines('`<!--` then\n# heading'));
    expect(s.headings.map((h) => h.text)).toEqual(['heading']);
  });

  it('blanks everything before the body start', () => {
    const s = scan(lines('---\n# fm\n---\n# body'), 3);
    expect(s.headings.map((h) => h.text)).toEqual(['body']);
    expect(s.prose[1]).toBe('    ');
  });
});

describe('headings and sections', () => {
  it('reads ATX headings, dropping a closing sequence', () => {
    const s = scan(lines('# Title #\n## Two ##  \n###\n#### Four #not\n#nospace'));
    expect(s.headings).toEqual([
      { line: 0, level: 1, text: 'Title' },
      { line: 1, level: 2, text: 'Two' },
      { line: 2, level: 3, text: '' },
      { line: 3, level: 4, text: 'Four #not' },
    ]);
  });

  it('keeps inline code in a heading text', () => {
    expect(scan(lines('## The `x` rule')).headings[0]?.text).toBe('The `x` rule');
  });

  it('runs a section to the next heading at its level or above', () => {
    const s = scan(lines('# T\n## A\ntext\n### A.1\nmore\n## B\n# Next\n## C'));
    expect(sectionsOf(s).map((x) => [x.heading.text, x.heading.line, x.end])).toEqual([
      ['A', 1, 5],
      ['A.1', 3, 5],
      ['B', 5, 6],
      ['C', 7, 8],
    ]);
  });

  it('finds the title as the first level-one heading', () => {
    expect(titleOf(scan(lines('## a\n# b\n# c')))?.text).toBe('b');
    expect(titleOf(scan(lines('## a')))).toBeUndefined();
  });

  it('knows content from blank lines', () => {
    expect(hasContent('  x ')).toBe(true);
    expect(hasContent(' \t ')).toBe(false);
  });
});

describe('task items', () => {
  it('reads boxes on bullet and ordered items, ticked in either case', () => {
    const s = scan(lines('- [ ] one\n* [x] two\n+ [X] three\n1. [ ] four\n2) [x] five\n- [ ]\n- [] no\n-[ ] no\n- [ ]no'));
    expect(s.tasks.map((t) => [t.line, t.checked, t.text])).toEqual([
      [0, false, 'one'],
      [1, true, 'two'],
      [2, true, 'three'],
      [3, false, 'four'],
      [4, true, 'five'],
      [5, false, ''],
    ]);
  });

  it('ignores boxes in code and comments', () => {
    const s = scan(lines('```\n- [ ] in code\n```\n<!-- - [ ] in comment -->\n`- [ ] span`'));
    expect(s.tasks).toEqual([]);
  });

  it('extends an item over indented lines and blank lines between them', () => {
    const s = scan(lines('- [ ] a\n  note\n\n  more\n- [ ] b\ntext'));
    expect(s.tasks.map((t) => [t.line, t.end])).toEqual([
      [0, 4],
      [4, 6],
    ]);
  });

  it('extends an item over a lazy continuation line, but not after a blank line', () => {
    const s = scan(lines('- [ ] a\n**Rejected** because\n\nafter'));
    expect(s.tasks[0]?.end).toBe(2);
  });

  it('stops an item at a sibling, a heading, a fence or a quote', () => {
    const s = scan(lines('- [ ] a\n- b\n\n- [ ] c\n## H\n- [ ] d\n```\nx\n```\n- [ ] e\n> quote'));
    expect(s.tasks.map((t) => [t.line, t.end])).toEqual([
      [0, 1],
      [3, 4],
      [5, 6],
      [9, 10],
    ]);
  });

  it('keeps a nested item inside its parent', () => {
    const s = scan(lines('- [ ] parent\n  - [x] child\nafter\n\nout'));
    expect(s.tasks.map((t) => [t.line, t.end])).toEqual([
      [0, 3],
      [1, 3],
    ]);
  });
});

describe('links', () => {
  it('finds inline links, images and reference definitions with their columns', () => {
    const s = scan(lines('[a](x.md) and ![i](img/p.png "title")\n[ref]: ../y.md\n  [r2]:   <z w.md>'));
    expect(linksOf(s)).toEqual([
      { line: 0, start: 4, end: 8, target: 'x.md' },
      { line: 0, start: 19, end: 28, target: 'img/p.png' },
      { line: 1, start: 7, end: 14, target: '../y.md' },
      { line: 2, start: 11, end: 17, target: 'z w.md' },
    ]);
  });

  it('balances parentheses in a destination and stops at the closing one', () => {
    const s = scan(lines('[w](a_(b).md) and [e]()'));
    expect(linksOf(s).map((l) => l.target)).toEqual(['a_(b).md']);
  });

  it('skips spaces before a destination, and an unclosed angle bracket', () => {
    const s = scan(lines('[a]( spaced.md) [b](<open'));
    expect(linksOf(s).map((l) => l.target)).toEqual(['spaced.md']);
  });

  it('ignores links in code and comments', () => {
    const s = scan(lines('`[a](x.md)`\n<!-- [b](y.md) -->\n```\n[c](z.md)\n```'));
    expect(linksOf(s)).toEqual([]);
  });

  it('reads an empty definition as no link', () => {
    expect(linksOf(scan(lines('[ref]:')))).toEqual([]);
  });
});
