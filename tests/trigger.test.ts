import { describe, expect, it } from 'vitest';

import { namesAnEvent } from '../src/trigger.js';

/** A deferral's trigger names an event; a date or a time is not one. */

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
      '',
      '  --  ',
    ]) {
      expect(namesAnEvent(trigger), trigger).toBe(false);
    }
  });
});
