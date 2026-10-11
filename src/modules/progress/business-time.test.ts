// Business dates in Asia/Kolkata (UTC+05:30): day and month boundaries, streak rules.
import { describe, expect, test } from 'vitest';
import { businessDate, businessMonth, currentStreak, longestRun, monthBounds, monthLabel, previousDate } from './business-time.js';

describe('businessDate — IST day boundaries', () => {
  test.each([
    // IST midnight is 18:30 UTC the previous day.
    ['2026-10-06T18:29:59.999Z', '2026-10-06'], // 23:59:59.999 IST on the 6th
    ['2026-10-06T18:30:00.000Z', '2026-10-07'], // 00:00 IST on the 7th
    ['2026-10-07T00:00:00.000Z', '2026-10-07'], // UTC midnight is 05:30 IST — mid-day, no boundary
    ['2026-10-07T18:29:00.000Z', '2026-10-07'],
    ['2026-12-31T18:30:00.000Z', '2027-01-01'], // new year arrives at 18:30 UTC
  ])('%s → %s', (instant, date) => {
    expect(businessDate(new Date(instant))).toBe(date);
  });
});

describe('businessMonth — IST month boundaries', () => {
  test.each([
    ['2026-10-31T18:29:59.999Z', '2026-10'], // 23:59 IST on 31 Oct
    ['2026-10-31T18:30:00.000Z', '2026-11'], // 00:00 IST on 1 Nov, still 31 Oct in UTC
    ['2026-02-28T18:30:00.000Z', '2026-03'],
    ['2028-02-28T18:30:00.000Z', '2028-02'], // leap year: 29 Feb
  ])('%s → %s', (instant, month) => {
    expect(businessMonth(new Date(instant))).toBe(month);
  });
});

describe('calendar arithmetic', () => {
  test.each([
    ['2026-10-07', '2026-10-06'],
    ['2026-10-01', '2026-09-30'],
    ['2026-01-01', '2025-12-31'],
    ['2028-03-01', '2028-02-29'],
    ['2026-03-01', '2026-02-28'],
  ])('previousDate(%s) = %s', (date, previous) => {
    expect(previousDate(date)).toBe(previous);
  });

  test('monthBounds', () => {
    expect(monthBounds('2026-10')).toEqual({ first: '2026-10-01', nextFirst: '2026-11-01' });
    expect(monthBounds('2026-12')).toEqual({ first: '2026-12-01', nextFirst: '2027-01-01' });
  });

  test('monthLabel', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2027-01')).toBe('January 2027');
  });
});

describe('currentStreak', () => {
  const today = '2026-10-07';

  test('no completions → 0', () => {
    expect(currentStreak([], today)).toBe(0);
  });

  test('only today → 1', () => {
    expect(currentStreak(['2026-10-07'], today)).toBe(1);
  });

  test('consecutive days ending today', () => {
    expect(currentStreak(['2026-10-07', '2026-10-06', '2026-10-05'], today)).toBe(3);
  });

  test('today not completed yet → counts from yesterday', () => {
    expect(currentStreak(['2026-10-06', '2026-10-05', '2026-10-04'], today)).toBe(3);
  });

  test('a missed day breaks it', () => {
    expect(currentStreak(['2026-10-07', '2026-10-05', '2026-10-04'], today)).toBe(1);
    expect(currentStreak(['2026-10-06', '2026-10-04'], today)).toBe(1);
  });

  test('nothing today or yesterday → 0, however long the old streak was', () => {
    expect(currentStreak(['2026-10-05', '2026-10-04', '2026-10-03'], today)).toBe(0);
  });

  test('all seven days count (weekends included) and month boundaries are crossed', () => {
    // 2026-10-03 is a Saturday, 10-04 a Sunday.
    expect(currentStreak(['2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01', '2026-09-30'], today)).toBe(8);
  });

  test('duplicates and order do not matter; future days are ignored', () => {
    expect(currentStreak(['2026-10-05', '2026-10-07', '2026-10-06', '2026-10-07', '2026-10-09'], today)).toBe(3);
  });

  test('crosses a year boundary', () => {
    expect(currentStreak(['2027-01-01', '2026-12-31', '2026-12-30'], '2027-01-01')).toBe(3);
  });
});

describe('longestRun', () => {
  test.each([
    [[], 0],
    [['2026-10-01'], 1],
    [['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06'], 3],
    [['2026-10-06', '2026-10-01', '2026-10-05', '2026-10-02'], 2],
    [['2026-09-30', '2026-10-01'], 2],
  ])('%j → %i', (days, expected) => {
    expect(longestRun(days)).toBe(expected);
  });
});
