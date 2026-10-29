// Database access for attendance. No business rules.
import type { AttendanceStatus } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';

export interface AttendanceRow {
  studentId: string;
  day: Date;
  status: AttendanceStatus;
  updatedAt: Date;
  markedBy: { fullName: string };
}

export function createAttendanceRepository(db: Db) {
  return {
    between(studentIds: string[], from: Date, to: Date): Promise<AttendanceRow[]> {
      if (studentIds.length === 0) return Promise.resolve([]);
      return db.attendanceRecord.findMany({
        where: { studentId: { in: studentIds }, day: { gte: from, lte: to } },
        orderBy: [{ day: 'asc' }, { studentId: 'asc' }],
        select: { studentId: true, day: true, status: true, updatedAt: true, markedBy: { select: { fullName: true } } },
      });
    },

    /** One register, all or nothing. */
    async mark(day: Date, markedById: string, records: { studentId: string; status: AttendanceStatus }[]): Promise<void> {
      await db.$transaction(
        records.map(({ studentId, status }) =>
          db.attendanceRecord.upsert({
            where: { studentId_day: { studentId, day } },
            create: { studentId, day, status, markedById },
            update: { status, markedById },
          }),
        ),
      );
    },
  };
}

export type AttendanceRepository = ReturnType<typeof createAttendanceRepository>;
