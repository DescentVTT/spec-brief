import { describe, expect, it } from 'vitest';

import {
  dirOf,
  isInside,
  isRelativeTarget,
  linesLinkingTo,
  normalisePath,
  relativePath,
  resolveFrom,
  rewriteLinks,
  splitTarget,
} from '../src/links.js';
import { scan } from '../src/markdown.js';

describe('paths', () => {
  it('knows a relative destination from everything else', () => {
    for (const t of ['a.md', './a.md', '../a.md', 'a b.md', 'dir/']) expect(isRelativeTarget(t), t).toBe(true);
    for (const t of ['', '#x', '/abs', '\\abs', 'https://x', 'mailto:a@b', 'C:x', 'data:x']) expect(isRelativeTarget(t), t).toBe(false);
  });

  it('splits a destination at its query or fragment', () => {
    expect(splitTarget('a.md#x')).toEqual({ path: 'a.md', suffix: '#x' });
    expect(splitTarget('a.md?v=1#x')).toEqual({ path: 'a.md', suffix: '?v=1#x' });
    expect(splitTarget('a.md')).toEqual({ path: 'a.md', suffix: '' });
  });

  it('normalises repository paths and refuses one that leaves the repository', () => {
    expect(normalisePath('./a//b/./c/../d\\e')).toBe('a/b/d/e');
    expect(normalisePath('')).toBe('');
    expect(() => normalisePath('a/../../x')).toThrow('outside the repository');
    expect(isInside('briefs/a.md', 'briefs/')).toBe(true);
    expect(isInside('briefs', 'briefs')).toBe(true);
    expect(isInside('briefsx/a.md', 'briefs')).toBe(false);
    expect(isInside('anything', '.')).toBe(true);
    expect(dirOf('a/b/c.md')).toBe('a/b');
    expect(dirOf('c.md')).toBe('');
  });

  it('resolves and relativises', () => {
    expect(resolveFrom('briefs', '../docs/a.md')).toBe('docs/a.md');
    expect(resolveFrom('briefs', './x/./y.md')).toBe('briefs/x/y.md');
    expect(resolveFrom('', '../x')).toBeNull();
    expect(relativePath('briefs/archive', 'docs/a.md')).toBe('../../docs/a.md');
    expect(relativePath('briefs', 'briefs/archive/x.md')).toBe('archive/x.md');
    expect(relativePath('a', 'a')).toBe('.');
    expect(relativePath('', 'x/y')).toBe('x/y');
  });
});

describe('rewriting', () => {
  const lines = (text: string) => text.split('\n');

  it('rewrites every relative link for the new directory, and leaves the rest', () => {
    const s = scan(lines('[a](../docs/a.md#s) [b](b.md) ![i](img.png)\n[c](https://x) [d](#top) [e](/abs)\n[ref]: ./sib.md\n`[f](code.md)`'));
    const result = rewriteLinks(s, 'briefs', 'briefs/archive', (p) => p);
    expect(result.lines).toEqual([
      '[a](../../docs/a.md#s) [b](../b.md) ![i](../img.png)',
      '[c](https://x) [d](#top) [e](/abs)',
      '[ref]: ../sib.md',
      '`[f](code.md)`',
    ]);
    expect(result.count).toBe(4);
  });

  it('points a link to the moving file at its new place, and keeps links that still resolve', () => {
    const s = scan(lines('[self](001_a.md#x) [other](002_b.md) [up](../README.md)'));
    const result = rewriteLinks(s, 'briefs', 'briefs', (p) => (p === 'briefs/001_a.md' ? 'briefs/archive/001_a.md' : p));
    expect(result.lines).toEqual(['[self](archive/001_a.md#x) [other](002_b.md) [up](../README.md)']);
    expect(result.count).toBe(1);
  });

  it('keeps a trailing slash, the encoding, and links that climb out of the repository', () => {
    const s = scan(lines('[d](docs/) [s](my%20file.md) [out](../../x.md) [bad](%E0%A4%A.md)'));
    const result = rewriteLinks(s, 'briefs', 'briefs/archive', (p) => p);
    expect(result.lines).toEqual(['[d](../docs/) [s](../my%20file.md) [out](../../x.md) [bad](../%25E0%25A4%25A.md)']);
  });

  it('writes a link to its own directory as "."', () => {
    const s = scan(lines('[here](../archive/)'));
    expect(rewriteLinks(s, 'briefs/archive', 'briefs', (p) => (p === 'briefs/archive' ? 'briefs' : p)).lines).toEqual(['[here](.)']);
  });

  it('rewrites several links on one line from the right, so columns stay true', () => {
    const s = scan(lines('[a](a.md)[b](b.md)'));
    expect(rewriteLinks(s, 'x', 'x/y', (p) => p).lines).toEqual(['[a](../a.md)[b](../b.md)']);
  });

  it('finds the lines that link to a file', () => {
    const s = scan(lines('[a](001_a.md)\n[b](./001_a.md#x) [c](001_a.md)\n[d](002.md)\n[e](#only)\n[f](https://x/001_a.md)'));
    expect(linesLinkingTo(s, 'briefs', 'briefs/001_a.md')).toEqual([0, 1]);
  });
});
