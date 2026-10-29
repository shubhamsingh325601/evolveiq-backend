// Database access for health profiles. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { HealthCondition } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';

const PROFILE = {
  studentId: true,
  conditions: true,
  bloodGroup: true,
  allergies: true,
  medications: true,
  careNotes: true,
  emergencyName: true,
  emergencyRelation: true,
  emergencyPhone: true,
  updatedAt: true,
  updatedBy: { select: { fullName: true, role: true } },
} as const satisfies Prisma.HealthProfileSelect;
export type HealthProfileRecord = Prisma.HealthProfileGetPayload<{ select: typeof PROFILE }>;

export interface HealthProfileData {
  conditions: HealthCondition[];
  bloodGroup: string | null;
  allergies: string | null;
  medications: string | null;
  careNotes: string | null;
  emergencyName: string | null;
  emergencyRelation: string | null;
  emergencyPhone: string | null;
  updatedById: string;
}

export function createHealthRepository(db: Db) {
  return {
    find(studentId: string): Promise<HealthProfileRecord | null> {
      return db.healthProfile.findUnique({ where: { studentId }, select: PROFILE });
    },

    upsert(studentId: string, data: HealthProfileData): Promise<HealthProfileRecord> {
      return db.healthProfile.upsert({ where: { studentId }, create: { studentId, ...data }, update: data, select: PROFILE });
    },

    /** The recorded profiles of a class's current students, by student name. */
    forClass(classId: string): Promise<HealthProfileRecord[]> {
      return db.healthProfile.findMany({
        where: { student: { classLink: { classId } } },
        orderBy: [{ student: { fullName: 'asc' } }, { studentId: 'asc' }],
        select: PROFILE,
      });
    },
  };
}

export type HealthRepository = ReturnType<typeof createHealthRepository>;
