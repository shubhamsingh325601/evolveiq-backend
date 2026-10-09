// Business dates: the ONE place that decides which calendar day / month an instant belongs to.
//
// Timestamps are stored in UTC (timestamptz, UTC sessions — src/shared/db/prisma.ts). Days and
// months for streaks and monthly summaries are Asia/Kolkata days and months: an activity
// completed at 00:15 IST on 1 November (18:45 UTC on 31 October) counts for 1 November.
// Never use UTC midnight as a business boundary.
//
// Calendar dates are plain "YYYY-MM-DD" strings and months "YYYY-MM": no Date objects, so no
// accidental time-zone conversion.

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Asia/Kolkata calendar date ("YYYY-MM-DD") of an instant. */
export function businessDate(instant: Date): string {
  return DATE_FORMAT.format(instant); // en-CA formats as YYYY-MM-DD
}

/** The Asia/Kolkata calendar month ("YYYY-MM") of an instant. */
export function businessMonth(instant: Date): string {
  return businessDate(instant).slice(0, 7);
}

/** The calendar day before `date` ("YYYY-MM-DD"). Pure calendar arithmetic. */
export function previousDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** First day of `month` and of the month after it, as "YYYY-MM-DD". */
export function monthBounds(month: string): { first: string; nextFirst: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return {
    first: `${month}-01`,
    nextFirst: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
  };
}

/** "October 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * Current streak: consecutive calendar days, ending today, with at least one completion. All
 * seven days count. If today has no completion yet the streak still stands from yesterday
 * (it isn't broken until a whole day passes without one).
 */
export function currentStreak(completedDays: Iterable<string>, today: string): number {
  const days = new Set(completedDays);
  let day = days.has(today) ? today : previousDate(today);
  let streak = 0;
  while (days.has(day)) {
    streak += 1;
    day = previousDate(day);
  }
  return streak;
}

/** Longest run of consecutive calendar days in a set of days. */
export function longestRun(completedDays: Iterable<string>): number {
  const days = new Set(completedDays);
  let longest = 0;
  for (const day of days) {
    if (days.has(previousDate(day))) continue; // not the start of a run
    let length = 0;
    for (let d = day; days.has(d); d = nextDate(d)) length += 1;
    longest = Math.max(longest, length);
  }
  return longest;
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
