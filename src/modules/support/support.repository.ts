// Database access for support plans. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { SupportCategory, SupportStatus } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';

const PLAN = {
  id: true,
  studentId: true,
  category: true,
  summary: true,
  strategies: true,
  status: true,
  reviewOn: true,
  closedAt: true,
  createdAt: true,
  createdBy: { select: { fullName: true } },
} as const satisfies Prisma.SupportPlanSelect;
export type SupportPlanRecord = Prisma.SupportPlanGetPayload<{ select: typeof PLAN }>;

export interface PlanChanges {
  readonly summary?: string | undefined;
  readonly strategies?: string | null | undefined;
  readonly status?: SupportStatus | undefined;
  readonly reviewOn?: Date | null | undefined;
  readonly closedAt?: Date | null | undefined;
}

export function createSupportRepository(db: Db) {
  return {
    create(data: {
      studentId: string;
      createdById: string;
      category: SupportCategory;
      summary: string;
      strategies: string | null;
      reviewOn: Date | null;
    }): Promise<SupportPlanRecord> {
      return db.supportPlan.create({ data, select: PLAN });
    },

    /** A student's plans, newest first (the service puts the open ones first). */
    forStudent(studentId: string): Promise<SupportPlanRecord[]> {
      return db.supportPlan.findMany({ where: { studentId }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: PLAN });
    },

    find(id: string): Promise<SupportPlanRecord | null> {
      return db.supportPlan.findUnique({ where: { id }, select: PLAN });
    },

    update(id: string, changes: PlanChanges): Promise<SupportPlanRecord> {
      const data: Prisma.SupportPlanUpdateInput = {
        ...(changes.summary !== undefined && { summary: changes.summary }),
        ...(changes.strategies !== undefined && { strategies: changes.strategies }),
        ...(changes.status !== undefined && { status: changes.status }),
        ...(changes.reviewOn !== undefined && { reviewOn: changes.reviewOn }),
        ...(changes.closedAt !== undefined && { closedAt: changes.closedAt }),
      };
      return db.supportPlan.update({ where: { id }, data, select: PLAN });
    },
  };
}

export type SupportRepository = ReturnType<typeof createSupportRepository>;
