// Database access for consent and wellbeing check-ins. No business rules.
import type { ConsentPurpose } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';

export interface ConsentRecord {
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly decidedAt: Date;
}

export interface CheckinRecord {
  readonly day: Date;
  readonly mood: number;
  readonly energy: number;
  readonly sleepMinutes: number | null;
  readonly activeMinutes: number | null;
}

export interface CheckinValues {
  readonly mood: number;
  readonly energy: number;
  readonly sleepMinutes: number | null;
  readonly activeMinutes: number | null;
}

const CHECKIN = { day: true, mood: true, energy: true, sleepMinutes: true, activeMinutes: true } as const;

/** A "YYYY-MM-DD" string as the UTC midnight Postgres stores a `date` as. */
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

export function createWellbeingRepository(db: Db) {
  return {
    consents(studentId: string): Promise<ConsentRecord[]> {
      return db.consent.findMany({
        where: { studentId },
        select: { purpose: true, granted: true, decidedAt: true },
      });
    },

    setConsent(studentId: string, purpose: ConsentPurpose, granted: boolean, decidedById: string): Promise<ConsentRecord> {
      const now = new Date();
      return db.consent.upsert({
        where: { studentId_purpose: { studentId, purpose } },
        create: { studentId, purpose, granted, decidedById, decidedAt: now },
        update: { granted, decidedById, decidedAt: now },
        select: { purpose: true, granted: true, decidedAt: true },
      });
    },

    /** Records the day, replacing an earlier check-in for the same day. */
    saveCheckin(studentId: string, recordedById: string, day: string, values: CheckinValues): Promise<CheckinRecord> {
      return db.wellnessCheckin.upsert({
        where: { studentId_day: { studentId, day: asDate(day) } },
        create: { studentId, recordedById, day: asDate(day), ...values },
        update: { recordedById, ...values },
        select: CHECKIN,
      });
    },

    /** Check-ins from `since` (inclusive) on, oldest first. */
    checkins(studentId: string, since: string): Promise<CheckinRecord[]> {
      return db.wellnessCheckin.findMany({
        where: { studentId, day: { gte: asDate(since) } },
        orderBy: { day: 'asc' },
        select: CHECKIN,
      });
    },
  };
}

export type WellbeingRepository = ReturnType<typeof createWellbeingRepository>;
