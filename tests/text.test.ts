import { describe, expect, it } from 'vitest';

import {
  canonicalText,
  fillTemplate,
  joinLines,
  labelMatches,
  lineEnding,
  normaliseLabel,
  slugify,
  splitLines,
  stripBom,
  templateHoles,
} from '../src/text.js';

describe('lines', () => {
  it('splits on LF and CRLF, and a final newline adds no line', () => {
    expect(splitLines('a\nb\r\nc\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('')).toEqual(['']);
    expect(splitLines('\n')).toEqual(['']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('keeps the line ending a file already uses', () => {
    expect(lineEnding('a\r\nb')).toBe('\r\n');
    expect(lineEnding('a\nb\r\n')).toBe('\n');
    expect(lineEnding('no newline')).toBe('\n');
    expect(lineEnding('\nfirst line empty')).toBe('\n');
  });

  it('joins with a final newline, and nothing for no lines', () => {
    expect(joinLines(['a', 'b'], '\r\n')).toBe('a\r\nb\r\n');
    expect(joinLines([], '\n')).toBe('');
  });

  it('treats a byte-order mark and CRLF as storage, not content', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(stripBom(`${bom}x`)).toBe('x');
    expect(stripBom('x')).toBe('x');
    expect(canonicalText(`${bom}a\r\nb\r\n`)).toBe('a\nb\n');
  });
});

describe('section names', () => {
  it('compare equal across typography, numbering, emphasis, colons and case', () => {
    const curly = `Commander${String.fromCharCode(0x2019)}s Intent`;
    expect(normaliseLabel(`2. **${curly}:**`)).toBe("commander's intent");
    expect(normaliseLabel('  Not   `empowered`  ')).toBe('not empowered');
    expect(normaliseLabel('1.2) Report')).toBe('report');
    expect(normaliseLabel(`${String.fromCharCode(0x201c)}Quoted${String.fromCharCode(0x201d)}`)).toBe('"quoted"');
  });

  it('matches a name followed by a separator and a qualifier, and nothing longer', () => {
    expect(labelMatches('Invariants (must hold)', 'Invariants')).toBe(true);
    expect(labelMatches(`Deliverables ${String.fromCharCode(0x2014)} round two`, 'Deliverables')).toBe(true);
    expect(labelMatches(`Deliverables ${String.fromCharCode(0x2013)} two`, 'Deliverables')).toBe(true);
    expect(labelMatches('Mission: the short version', 'Mission')).toBe(true);
    expect(labelMatches('Report - final', 'Report')).toBe(true);
    expect(labelMatches('Reporting', 'Report')).toBe(false);
    expect(labelMatches('Report-final', 'Report')).toBe(false);
    expect(labelMatches('Missionary', 'Mission')).toBe(false);
    expect(labelMatches('Report', 'Reporting')).toBe(false);
    expect(labelMatches('Anything', '')).toBe(false);
    expect(labelMatches('Anything', '**')).toBe(false);
  });
});

describe('slugify', () => {
  it('keeps ASCII letters and digits and folds diacritics', () => {
    expect(slugify('Two injections: F-46!')).toBe('two-injections-f-46');
    expect(slugify(`Caf${String.fromCharCode(0xe9)} au lait`)).toBe('cafe-au-lait');
    expect(slugify('---')).toBe('');
  });

  it('cuts a long title at a word break', () => {
    expect(slugify('alpha beta gamma', 12)).toBe('alpha-beta');
    expect(slugify('alphabetagamma', 5)).toBe('alpha');
    expect(slugify('abc def', 7)).toBe('abc-def');
  });
});

describe('templates', () => {
  it('fills known holes and leaves unknown ones as written', () => {
    expect(fillTemplate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(fillTemplate('{a}{a}', { a: '1' })).toBe('11');
  });

  it('lists the holes a line uses', () => {
    expect(templateHoles('**Archived {date}** in {pr}.')).toEqual(['date', 'pr']);
    expect(templateHoles('none here, {not a hole}')).toEqual([]);
  });
});
