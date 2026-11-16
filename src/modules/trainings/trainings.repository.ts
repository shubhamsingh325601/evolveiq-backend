// Database access for the Staff Training & Development Hub. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

const TRAINING = {
  id: true,
  schoolId: true,
  title: true,
  description: true,
  scheduledOn: true,
  requirement: true,
  credits: true,
  createdAt: true,
  updatedAt: true,
  school: { select: { name: true } },
  createdBy: { select: { fullName: true } },
} as const satisfies Prisma.TrainingSelect;
export type TrainingRecord = Prisma.TrainingGetPayload<{ select: typeof TRAINING }>;

export interface EnrolmentRecord {
  isComplete: boolean;
}

export function createTrainingsRepository(db: Db) {
  return {
    async list(where: Prisma.TrainingWhereInput, skip: number, take: number): Promise<{ items: TrainingRecord[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.training.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: TRAINING,
        }),
        db.training.count({ where }),
      ]);
      return { items, total };
    },

    find(id: string): Promise<TrainingRecord | null> {
      return db.training.findUnique({ where: { id }, select: TRAINING });
    },

    schoolExists(id: string): Promise<boolean> {
      return db.school.count({ where: { id } }).then((n) => n > 0);
    },

    create(data: Prisma.TrainingUncheckedCreateInput): Promise<TrainingRecord> {
      return db.training.create({ data, select: TRAINING });
    },

    update(id: string, data: Prisma.TrainingUncheckedUpdateInput): Promise<TrainingRecord> {
      return db.training.update({ where: { id }, data, select: TRAINING });
    },

    async remove(id: string): Promise<void> {
      await db.training.delete({ where: { id } });
    },

    /** The caller's own enrolment in each of `trainingIds`, keyed by training ID. */
    async myEnrolments(staffId: string, trainingIds: string[]): Promise<Map<string, EnrolmentRecord>> {
      if (trainingIds.length === 0) return new Map();
      const rows = await db.trainingEnrolment.findMany({
        where: { staffId, trainingId: { in: trainingIds } },
        select: { trainingId: true, isComplete: true },
      });
      return new Map(rows.map((r) => [r.trainingId, { isComplete: r.isComplete }]));
    },

    /** Unique violations (already enrolled) propagate to the caller. */
    enrol(trainingId: string, staffId: string, enrolledAt: Date): Promise<EnrolmentRecord> {
      return db.trainingEnrolment.create({ data: { trainingId, staffId, enrolledAt }, select: { isComplete: true } });
    },

    async markComplete(trainingId: string, staffId: string, completedAt: Date): Promise<EnrolmentRecord | null> {
      const { count } = await db.trainingEnrolment.updateMany({
        where: { trainingId, staffId },
        data: { isComplete: true, completedAt },
      });
      return count > 0 ? { isComplete: true } : null;
    },
  };
}

export type TrainingsRepository = ReturnType<typeof createTrainingsRepository>;
