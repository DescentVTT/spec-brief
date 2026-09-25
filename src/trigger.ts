/**
 * Whether a deferral's trigger names an event or only a time.
 *
 * Deferred work comes back when something happens: "when the second tenant
 * signs", "when p95 exceeds 200 ms". A date is not that. It passes whether or
 * not the reason for the work has arrived, and a deferral that fires on a date
 * is a reminder to look again, which the deferral itself already is. So a
 * trigger made only of words that say when - a date, a quarter, a month or a
 * weekday, a stretch of time and the small words that join them - is refused,
 * and one word that says what is enough to pass.
 *
 * The lists are deliberately short. A trigger this reads as an event when it
 * is a time is a miss, and a miss costs less here than refusing a real event
 * for looking like a date.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Words that say when and nothing else. */
const WHEN = new Set([
  ...MONTHS,
  ...MONTHS.map((m) => m.slice(0, 3)),
  'sept',
  ...WEEKDAYS,
  ...WEEKDAYS.map((d) => d.slice(0, 3)),
  // A stretch of time.
  ...['day', 'week', 'weekend', 'month', 'quarter', 'year', 'sprint'].flatMap((unit) => [unit, `${unit}s`]),
  'today',
  'tomorrow',
  'soon',
  'later',
  // How many of them.
  ...['a', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'few', 'couple'],
  // The words that join them.
  ...['in', 'on', 'by', 'at', 'after', 'before', 'until', 'from', 'of', 'the', 'next', 'this', 'end', 'start', 'early', 'mid', 'late'],
]);

/** A date or part of one: `2026`, `2026-10`, `2026-10-01`; a quarter, `Q3`; a number or an ordinal, `15`, `15th`. */
const DATE = /^(?:\d{4}(?:-\d{2}){0,2}|q[1-4]|\d+(?:st|nd|rd|th)?)$/;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;]+/)
    .flatMap((word) => {
      const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      // An ISO date keeps its hyphens; "mid-2027" is two words.
      return DATE.test(bare) ? [bare] : bare.split(/[-/.]/);
    })
    .filter((word) => word !== '');
}

/** Whether a trigger has a word that says what must happen, rather than only when. */
export function namesAnEvent(trigger: string): boolean {
  return words(trigger).some((word) => !WHEN.has(word) && !DATE.test(word));
}
