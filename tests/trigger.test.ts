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

describe('the words for a time, in Chinese', () => {
  // Written out, Traditional and Simplified, as the English vocabulary is:
  // each alone names no event.
  const words = [
    ...['星期', '禮拜', '礼拜', '季度', '年度', '小時', '小时', '分鐘', '分钟'],
    ...['近期', '稍後', '稍后', '以後', '以后', '將來', '将来', '未來', '未来', '改天', '馬上', '马上', '很快', '不久', '左右'],
  ];
  const characters = [
    ...['年', '月', '日', '天', '週', '周', '季', '旬', '號', '号', '午'],
    ...['初', '底', '末', '中', '半'],
    ...['今', '明', '去', '上', '下', '本', '這', '这', '次', '前', '後', '后', '早', '晚', '第', '個', '个'],
    ...['〇', '零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '百', '兩', '两', '幾', '几'],
    ...['在', '於', '于', '到', '的', '之'],
  ];

  for (const word of [...words, ...characters]) {
    it(`"${word}" names no event`, () => {
      expect(namesAnEvent(word)).toBe(false);
    });
  }

  it('takes a word out before its characters, and is no wider than the lists', () => {
    // `稍後` is later; `稍` alone is not a time, so reading `後` first would leave it.
    expect(namesAnEvent('稍後')).toBe(false);
    // `時` and `期` stay events, so a trigger on an expiry passes; `每` and `當`
    // are every and when, which the English list leaves out too.
    for (const word of ['稍', '時', '期', '每', '當', '到期時', '每月結算完成時', '度']) {
      expect(namesAnEvent(word), word).toBe(true);
    }
  });
});

describe('a trigger written in Chinese', () => {
  it('names none when it is only a date or a time', () => {
    for (const trigger of [
      '下個月',
      '下个月',
      '下週',
      '下周',
      '下季',
      '明年',
      '年底',
      '月底',
      '第三季',
      '10月',
      '十月',
      '2026年10月',
      '二〇二六年十月',
      '10月15號',
      '兩週後',
      '两周后',
      '稍後',
      '稍后',
      '近期',
      // A word written twice is taken out twice.
      '星期一到星期五',
      // A number beside Han characters is a word of its own.
      'Q3之後',
      // Full-width letters and digits are read as the ASCII they stand for.
      'Ｑ３',
      '２０２６年１０月',
      '２０２６－１０',
    ]) {
      expect(namesAnEvent(trigger), trigger).toBe(false);
    }
  });

  it('names an event when a word says what must happen', () => {
    for (const trigger of [
      '當第二個租戶簽約時',
      '当第二个租户签约时',
      'p95 超過 200 ms 時',
      'v2.0 上線後',
      '月結完成後',
      '年度稽核通過後',
      '當 Q3 營收超過預估時',
      'ｖ２ 上線後',
    ]) {
      expect(namesAnEvent(trigger), trigger).toBe(true);
    }
  });

  it('reads a holiday as an event: a miss the rule accepts, as it accepts "noon"', () => {
    expect(namesAnEvent('過年後')).toBe(true);
    expect(namesAnEvent('春節後')).toBe(true);
  });
});
