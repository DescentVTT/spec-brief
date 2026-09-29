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

/**
 * A number or an ordinal - `2026`, `15`, `15th` - or a quarter, `Q3`. A date is
 * its numbers: `2026-10-01` and `10/01/2026` are read a number at a time.
 */
const DATE = /^(?:q[1-4]|\d+(?:st|nd|rd|th)?)$/;

/**
 * Chinese is written without spaces, so a trigger in it is one run of Han
 * characters that says when or what: `下個月` (next month), `2026年10月`,
 * `月結完成後` (after the month-end close). A run says only when if taking out
 * the words and characters below leaves nothing, Traditional and Simplified
 * alike.
 *
 * The words come out first, since one may hold a character that alone says
 * nothing about time: `稍後` (later) is `稍` and `後`, and `稍` is not on the
 * list. A word whose every character is on the list, such as `之後`, needs no
 * entry of its own.
 */
const HAN_WHEN_WORDS: readonly string[] = [
  // A weekday, and the stretches: `星期一`, `禮拜三`, a quarter, a year, an hour, a minute.
  ...['星期', '禮拜', '礼拜', '季度', '年度', '小時', '小时', '分鐘', '分钟'],
  // Soon, later, one day, in the future, about.
  ...['近期', '稍後', '稍后', '以後', '以后', '將來', '将来', '未來', '未来', '改天', '馬上', '马上', '很快', '不久', '左右'],
];

/**
 * Characters that say when, and the ones that join them. `時`, `期` and `每`
 * are not among them: `到期時` (when it expires) and `每月結算完成時` are
 * events, and so is a trigger that starts with `當` (when).
 */
const HAN_WHEN_CHARACTERS = new Set([
  // Units: year, month, day, week, quarter, a ten-day stretch, the day of the month, noon.
  ...['年', '月', '日', '天', '週', '周', '季', '旬', '號', '号', '午'],
  // Where in one: its start, end, middle, half.
  ...['初', '底', '末', '中', '半'],
  // Which one: this, next, last, the one before or after, early, late, the nth.
  ...['今', '明', '去', '上', '下', '本', '這', '这', '次', '前', '後', '后', '早', '晚', '第', '個', '个'],
  // How many.
  ...['〇', '零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '百', '兩', '两', '幾', '几'],
  // The words that join them: at, in, until, of.
  ...['在', '於', '于', '到', '的', '之'],
]);

/** A run of Han characters, or of other letters and digits. */
const WORD = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;

/** A word is all Han or none of it, so one character says which. */
const HAN = /\p{Script=Han}/u;

/**
 * The words of a trigger, in lower case: runs of letters and digits, with Han
 * characters in runs of their own, so that `10月` is `10` and `月`. `mid-2027`
 * is two words, and punctuation none. Read in NFKC first, so that full-width
 * `Ｑ３` is `q3` and `２０２６` is `2026`.
 */
function words(text: string): readonly string[] {
  return text.normalize('NFKC').toLowerCase().match(WORD) ?? [];
}

/** Whether a run of Han characters says only when. */
function hanSaysWhen(run: string): boolean {
  let rest = run;
  for (const word of HAN_WHEN_WORDS) rest = rest.replaceAll(word, '');
  return [...rest].every((character) => HAN_WHEN_CHARACTERS.has(character));
}

function saysWhen(word: string): boolean {
  if (HAN.test(word)) return hanSaysWhen(word);
  return WHEN.has(word) || DATE.test(word);
}

/** Whether a trigger has a word that says what must happen, rather than only when. */
export function namesAnEvent(trigger: string): boolean {
  return words(trigger).some((word) => !saysWhen(word));
}
