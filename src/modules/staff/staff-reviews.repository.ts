// Database access for staff reviews. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

const REVIEW = {
  id: true,
  month: true,
  teaching: true,
  engagement: true,
  punctuality: true,
  teamwork: true,
  communication: true,
  comment: true,
  createdAt: true,
  updatedAt: true,
  staff: { select: { id: true, fullName: true } },
  reviewer: { select: { fullName: true } },
} as const satisfies Prisma.StaffReviewSelect;
export type StaffReviewRecord = Prisma.StaffReviewGetPayload<{ select: typeof REVIEW }>;

export interface StaffReviewData {
  teaching: number;
  engagement: number;
  punctuality: number;
  teamwork: number;
  communication: number;
  comment: string | null;
}

export function createStaffReviewsRepository(db: Db) {
  return {
    async list(where: Prisma.StaffReviewWhereInput, skip: number, take: number): Promise<{ items: StaffReviewRecord[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.staffReview.findMany({
          where,
          orderBy: [{ month: 'desc' }, { staff: { fullName: 'asc' } }, { id: 'asc' }],
          skip,
          take,
          select: REVIEW,
        }),
        db.staffReview.count({ where }),
      ]);
      return { items, total };
    },

    /** The teacher, if they are a teacher of `schoolId`. */
    findTeacher(staffId: string, schoolId: string): Promise<{ id: string } | null> {
      return db.user.findFirst({ where: { id: staffId, role: 'teacher', schoolId }, select: { id: true } });
    },

    upsert(key: { schoolId: string; staffId: string; reviewerId: string; month: Date }, data: StaffReviewData): Promise<StaffReviewRecord> {
      return db.staffReview.upsert({
        where: { staffId_month: { staffId: key.staffId, month: key.month } },
        create: { ...key, ...data },
        update: { ...data, reviewerId: key.reviewerId },
        select: REVIEW,
      });
    },

    async remove(staffId: string, month: Date, schoolId: string): Promise<boolean> {
      const { count } = await db.staffReview.deleteMany({ where: { staffId, month, schoolId } });
      return count > 0;
    },
  };
}

export type StaffReviewsRepository = ReturnType<typeof createStaffReviewsRepository>;
