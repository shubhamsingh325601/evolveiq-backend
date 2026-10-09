// Database access for the activity library, assignments and completions. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { ActivityType } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';
import { escapeLike, type SortOrder } from '../../shared/pagination/index.js';
import type { ActivitySortField } from './activities.schemas.js';

const ACTIVITY = {
  id: true,
  title: true,
  type: true,
  content: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { assignments: true } },
} as const satisfies Prisma.ActivitySelect;
export type ActivityRecord = Prisma.ActivityGetPayload<{ select: typeof ACTIVITY }>;

const ASSIGNMENT = {
  id: true,
  studentId: true,
  source: true,
  observationId: true,
  createdAt: true,
  activity: { select: { id: true, title: true, type: true, content: true } },
  assignedBy: { select: { id: true, fullName: true } },
  completion: { select: { id: true, response: true, completedAt: true } },
} as const satisfies Prisma.AssignmentSelect;
export type AssignmentRecord = Prisma.AssignmentGetPayload<{ select: typeof ASSIGNMENT }>;

export interface ListActivitiesParams {
  readonly skip: number;
  readonly take: number;
  readonly sortBy: ActivitySortField;
  readonly sortOrder: SortOrder;
  readonly isArchived: boolean;
  readonly type?: ActivityType | undefined;
  readonly titleContains?: string | undefined;
}

/** What an edit may write. `content` is stored without its `type` (that's a column). */
export interface ActivityChanges {
  readonly title?: string | undefined;
  readonly type?: ActivityType | undefined;
  readonly content?: Prisma.InputJsonObject | undefined;
}

const ORDER_BY: Readonly<Record<ActivitySortField, (o: SortOrder) => Prisma.ActivityOrderByWithRelationInput[]>> = {
  title: (o) => [{ title: o }, { id: 'asc' }],
  createdAt: (o) => [{ createdAt: o }, { id: 'asc' }],
};

export function createActivitiesRepository(db: Db) {
  return {
    // ---------- Library ----------
    createActivity(data: { title: string; type: ActivityType; content: Prisma.InputJsonObject; createdById: string }): Promise<ActivityRecord> {
      return db.activity.create({ data, select: ACTIVITY });
    },

    findActivity(id: string): Promise<ActivityRecord | null> {
      return db.activity.findUnique({ where: { id }, select: ACTIVITY });
    },

    async listActivities(p: ListActivitiesParams): Promise<{ items: ActivityRecord[]; total: number }> {
      const where: Prisma.ActivityWhereInput = {
        archivedAt: p.isArchived ? { not: null } : null,
        ...(p.type !== undefined && { type: p.type }),
        ...(p.titleContains && { title: { contains: escapeLike(p.titleContains), mode: 'insensitive' } }),
      };
      const [items, total] = await db.$transaction([
        db.activity.findMany({ where, orderBy: ORDER_BY[p.sortBy](p.sortOrder), skip: p.skip, take: p.take, select: ACTIVITY }),
        db.activity.count({ where }),
      ]);
      return { items, total };
    },

    // The activity row is locked FOR UPDATE for the whole edit, so no assignment can be
    // created in between "is it assigned?" and the write (inserting an assignment needs a
    // key-share lock on the activity, which waits for this one). `decide` gets the current
    // row and whether it has ever been assigned, and returns the changes or throws.
    async updateActivity(
      id: string,
      decide: (current: ActivityRecord, isAssigned: boolean) => ActivityChanges,
    ): Promise<ActivityRecord | null> {
      return db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM activities WHERE id = ${id}::uuid FOR UPDATE`;
        if (locked.length === 0) return null;
        const current = await tx.activity.findUniqueOrThrow({ where: { id }, select: ACTIVITY });
        const changes = decide(current, current._count.assignments > 0);
        return tx.activity.update({ where: { id }, data: { ...changes }, select: ACTIVITY });
      });
    },

    /** Idempotent: keeps the first archive time. Null when no activity has this id. */
    async archiveActivity(id: string): Promise<ActivityRecord | null> {
      const updated = await db.$executeRaw`
        UPDATE activities SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = ${id}::uuid`;
      return updated === 0 ? null : db.activity.findUnique({ where: { id }, select: ACTIVITY });
    },

    // ---------- Assignments ----------
    /**
     * A direct (teacher) assignment, only if the activity exists and is not archived — checked
     * in the same statement as the insert. Null otherwise.
     */
    async createDirectAssignment(a: { activityId: string; studentId: string; assignedById: string }): Promise<AssignmentRecord | null> {
      const rows = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO assignments (activity_id, student_id, assigned_by_id, source)
        SELECT id, ${a.studentId}::uuid, ${a.assignedById}::uuid, 'direct'
        FROM activities WHERE id = ${a.activityId}::uuid AND archived_at IS NULL
        RETURNING id`;
      const id = rows[0]?.id;
      return id ? db.assignment.findUnique({ where: { id }, select: ASSIGNMENT }) : null;
    },

    async listAssignments(
      studentId: string,
      p: { skip: number; take: number; isDone?: boolean | undefined },
    ): Promise<{ items: AssignmentRecord[]; total: number }> {
      const where: Prisma.AssignmentWhereInput = {
        studentId,
        ...(p.isDone !== undefined && { completion: p.isDone ? { isNot: null } : { is: null } }),
      };
      const [items, total] = await db.$transaction([
        db.assignment.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: p.skip, take: p.take, select: ASSIGNMENT }),
        db.assignment.count({ where }),
      ]);
      return { items, total };
    },

    /** The assignment only if it belongs to `studentId` (null otherwise, like a missing one). */
    findStudentAssignment(assignmentId: string, studentId: string): Promise<AssignmentRecord | null> {
      return db.assignment.findFirst({ where: { id: assignmentId, studentId }, select: ASSIGNMENT });
    },

    // ---------- Completions ----------
    /** Unique violation (already completed) propagates. */
    createCompletion(assignmentId: string, response: Prisma.InputJsonObject) {
      return db.activityCompletion.create({
        data: { assignmentId, response },
        select: { id: true, assignmentId: true, response: true, completedAt: true },
      });
    },
  };
}

export type ActivitiesRepository = ReturnType<typeof createActivitiesRepository>;
