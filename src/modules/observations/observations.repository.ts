// Database access for observations and the review transaction. No business rules here.
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  DevelopmentArea,
  LearningBehaviourArea,
  ObservationArea,
  ObservationFrequency,
  ObservationLevel,
  ObservationStatus,
  ObservationWhen,
} from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';
import type { SortOrder } from '../../shared/pagination/index.js';

const PERSON = { select: { id: true, fullName: true } } as const;

// Everything any audience could need; each service mapper copies only its allow-list.
const SELECT = {
  id: true,
  schoolId: true,
  studentId: true,
  authorId: true,
  authorRole: true,
  area: true,
  description: true,
  observedWhen: true,
  frequency: true,
  level: true,
  learningBehaviourArea: true,
  status: true,
  reviewOutcome: true,
  developmentArea: true,
  teacherOnlyNote: true,
  reviewedAt: true,
  createdAt: true,
  student: PERSON,
  author: PERSON,
  reviewedBy: PERSON,
  assignments: { select: { activityId: true }, orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.ObservationSelect;

export type ObservationRecord = Prisma.ObservationGetPayload<{ select: typeof SELECT }>;

export interface NewObservation {
  readonly schoolId: string;
  readonly studentId: string;
  readonly authorId: string;
  readonly authorRole: 'parent' | 'teacher';
  readonly area: ObservationArea;
  readonly description: string;
  readonly observedWhen: ObservationWhen;
  readonly frequency: ObservationFrequency;
  readonly level: ObservationLevel | null;
  readonly learningBehaviourArea: LearningBehaviourArea | null;
}

export interface ObservationFilters {
  readonly authorId?: string | undefined;
  readonly status?: ObservationStatus | undefined;
  readonly level?: ObservationLevel | undefined;
  readonly authorRole?: 'parent' | 'teacher' | undefined;
  readonly schoolId?: string | undefined;
  readonly studentId?: string | undefined;
  readonly area?: ObservationArea | undefined;
}

export interface ReviewInput {
  readonly observationId: string;
  readonly reviewerId: string;
  readonly outcome: 'assigned' | 'no_action';
  readonly developmentArea: DevelopmentArea | null;
  readonly teacherOnlyNote: string | null;
  /** Empty for "no_action". */
  readonly activityIds: readonly string[];
}

export type ReviewResult = 'reviewed' | 'not_found' | 'already_reviewed' | 'invalid_activities';

export function createObservationsRepository(db: Db) {
  return {
    create(data: NewObservation): Promise<ObservationRecord> {
      return db.observation.create({ data, select: SELECT });
    },

    findById(id: string): Promise<ObservationRecord | null> {
      return db.observation.findUnique({ where: { id }, select: SELECT });
    },

    async list(
      filters: ObservationFilters,
      page: { skip: number; take: number; sortOrder: SortOrder },
    ): Promise<{ items: ObservationRecord[]; total: number }> {
      const where: Prisma.ObservationWhereInput = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value !== undefined),
      );
      const [items, total] = await db.$transaction([
        db.observation.findMany({
          where,
          orderBy: [{ createdAt: page.sortOrder }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
          select: SELECT,
        }),
        db.observation.count({ where }),
      ]);
      return { items, total };
    },

    /** The student's other observations, newest first. */
    history(studentId: string, excludeId: string, take: number): Promise<ObservationRecord[]> {
      return db.observation.findMany({
        where: { studentId, id: { not: excludeId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        select: SELECT,
      });
    },

    // The review is ONE transaction:
    //   0. lock the observation row (concurrent reviews queue up here; only one can win),
    //   1. select the activities (must exist and not be archived; locked so they can't be
    //      archived mid-review),
    //   2. create the recommended assignments,
    //   3. mark the observation reviewed.
    // Any failure rolls back all of it: no assignment without a review, no half-saved review.
    async review(r: ReviewInput): Promise<ReviewResult> {
      return db.$transaction(async (tx) => {
        const [observation] = await tx.$queryRaw<{ student_id: string; status: ObservationStatus }[]>`
          SELECT student_id, status FROM observations WHERE id = ${r.observationId}::uuid FOR UPDATE`;
        if (!observation) return 'not_found';
        if (observation.status !== 'pending') return 'already_reviewed';

        if (r.activityIds.length > 0) {
          const found = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM activities
            WHERE id = ANY(${r.activityIds}::uuid[]) AND archived_at IS NULL
            FOR SHARE`;
          if (found.length !== r.activityIds.length) return 'invalid_activities';

          await tx.assignment.createMany({
            data: r.activityIds.map((activityId) => ({
              activityId,
              studentId: observation.student_id,
              assignedById: r.reviewerId,
              source: 'recommended' as const,
              observationId: r.observationId,
            })),
          });
        }

        await tx.observation.update({
          where: { id: r.observationId },
          data: {
            status: 'reviewed',
            reviewOutcome: r.outcome,
            developmentArea: r.developmentArea,
            teacherOnlyNote: r.teacherOnlyNote,
            reviewedById: r.reviewerId,
            reviewedAt: new Date(),
          },
        });
        return 'reviewed';
      });
    },
  };
}

export type ObservationsRepository = ReturnType<typeof createObservationsRepository>;
