import { describe, expect, it } from 'vitest';

import { namesAnEvent } from '../src/trigger.js';

/** A deferral's trigger names an event; a date or a time is not one. */

describe('the words for a time', () => {
  // Each one alone names no event: the vocabulary, written out, is what the
  // rule refuses.
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const vocabulary = [
    ...months,
    ...months.map((m) => m.slice(0, 3)),
    'Sept',
    ...weekdays,
    ...weekdays.map((d) => d.slice(0, 3)),
    ...['day', 'week', 'weekend', 'month', 'quarter', 'year', 'sprint'].flatMap((unit) => [unit, `${unit}s`]),
    ...['today', 'tomorrow', 'soon', 'later'],
    ...['a', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'few', 'couple'],
    ...['in', 'on', 'by', 'at', 'after', 'before', 'until', 'from', 'of', 'the', 'next', 'this', 'end', 'start', 'early', 'mid', 'late'],
  ];

  for (const word of vocabulary) {
    it(`"${word}" names no event`, () => {
      expect(namesAnEvent(word)).toBe(false);
    });
  }

  it('is no wider than that: a near word names one', () => {
    for (const word of ['Mo', 'Septem', 'quarterly', 'daily', 'noon', 'eventually', 'thirteen', 'over', 'every']) {
      expect(namesAnEvent(word), word).toBe(true);
    }
  });
});

describe('a trigger', () => {
  it('names an event when one word says what must happen', () => {
    for (const trigger of [
      'when the second tenant signs',
      'when p95 > 200 ms',
      'after the release',
      'when v2.0 ships',
      'once the migration lands',
      'when Q3 revenue passes the forecast',
      'the day the API is public',
      'post-launch',
      'Mayday',
      // A word with a number in it is a name, not a date.
      'v2',
      '4k',
      'q5',
      'rc1',
      '1stline',
    ]) {
      expect(namesAnEvent(trigger), trigger).toBe(true);
    }
  });

  it('names none when it is only a date or a time', () => {
    for (const trigger of [
      '2026-10-01',
      '2026-10',
      '2027',
      'Q3',
      'q3 2027',
      'next month',
      'Monday',
      'October',
      'Sept',
      'end of Q3',
      'in two weeks',
      'in 2 weeks',
      'mid-2027',
      'Oct. 15th',
      'after the next sprint',
      '10/01/2026',
      'tomorrow',
      'soon',
      'a few months',
      'early next year',
      '(later)',
      '((later))',
      'the 1st',
      '2nd',
      '3rd',
      '',
      '  --  ',
    ]) {
      expect(namesAnEvent(trigger), trigger).toBe(false);
    }
  });
});
