// Pure rules for wellbeing check-ins. No HTTP, no SQL.
import { previousDate } from '../progress/business-time.js';
import type { CheckinDto, CheckinSummaryDto } from './wellbeing.schemas.js';

/** How far back a check-in may be filled in. */
export const BACKFILL_DAYS = 30;

/** Whether `day` is a day a check-in may be recorded for: today or up to 30 days ago. */
export function isRecordableDay(day: string, today: string): boolean {
  if (day > today) return false;
  let oldest = today;
  for (let i = 0; i < BACKFILL_DAYS; i++) oldest = previousDate(oldest);
  return day >= oldest;
}

/** The first day of the last `days` days, ending today. */
export function windowStart(today: string, days: number): string {
  let day = today;
  for (let i = 1; i < days; i++) day = previousDate(day);
  return day;
}

const mean = (values: readonly number[], digits = 0): number | null => {
  if (values.length === 0) return null;
  const factor = 10 ** digits;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * factor) / factor;
};

export function summariseCheckins(checkins: readonly CheckinDto[]): CheckinSummaryDto {
  const present = (pick: (c: CheckinDto) => number | null) => checkins.map(pick).filter((v): v is number => v !== null);
  return {
    days: checkins.length,
    averageMood: mean(checkins.map((c) => c.mood), 1),
    averageEnergy: mean(checkins.map((c) => c.energy), 1),
    averageSleepMinutes: mean(present((c) => c.sleepMinutes)),
    averageActiveMinutes: mean(present((c) => c.activeMinutes)),
  };
}
