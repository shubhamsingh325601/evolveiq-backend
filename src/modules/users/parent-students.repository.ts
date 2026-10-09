// Database access for parent ↔ student links. No business rules here.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

const SELECT = {
  createdAt: true,
  parent: { select: { id: true, fullName: true } },
  student: { select: { id: true, fullName: true } },
} as const satisfies Prisma.ParentStudentSelect;

export type ParentStudentRecord = Prisma.ParentStudentGetPayload<{ select: typeof SELECT }>;

export interface InsertLinkRow {
  is_student_valid: boolean;
  is_parent_valid: boolean;
  is_inserted: boolean;
}

export interface ListLinksParams {
  readonly skip: number;
  readonly take: number;
  /** Undefined = every school. */
  readonly schoolId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly studentId?: string | undefined;
}

export function createParentStudentsRepository(db: Db) {
  return {
    // ONE statement: the student must be a student (in `schoolId` when given), the parent an
    // active parent in the student's school; the primary key on student_id rejects a second
    // parent. users.school_id and users.role never change, so the check can't go stale.
    async insertLink(a: { studentId: string; parentId: string; schoolId: string | null }): Promise<InsertLinkRow> {
      const rows = await db.$queryRaw<InsertLinkRow[]>`
        WITH s AS (
          SELECT id, school_id FROM users
          WHERE id = ${a.studentId}::uuid AND role = 'student'
            AND (${a.schoolId}::uuid IS NULL OR school_id = ${a.schoolId}::uuid)
        ),
        p AS (
          SELECT id FROM users
          WHERE id = ${a.parentId}::uuid AND role = 'parent' AND is_active
            AND school_id = (SELECT school_id FROM s)
        ),
        ins AS (
          INSERT INTO parent_students (student_id, parent_id)
          SELECT s.id, p.id FROM s, p
          ON CONFLICT (student_id) DO NOTHING
          RETURNING student_id
        )
        SELECT EXISTS (SELECT 1 FROM s)   AS is_student_valid,
               EXISTS (SELECT 1 FROM p)   AS is_parent_valid,
               EXISTS (SELECT 1 FROM ins) AS is_inserted`;
      const row = rows[0];
      if (!row) throw new Error('insertLink returned no row');
      return row;
    },

    findLink(studentId: string): Promise<ParentStudentRecord | null> {
      return db.parentStudent.findUnique({ where: { studentId }, select: SELECT });
    },

    /** Deletes the link if the student is in `schoolId` (any school when null). Returns whether one was deleted. */
    async deleteLink(studentId: string, schoolId: string | null): Promise<boolean> {
      const { count } = await db.parentStudent.deleteMany({
        where: { studentId, ...(schoolId !== null && { student: { schoolId } }) },
      });
      return count > 0;
    },

    async list(p: ListLinksParams): Promise<{ items: ParentStudentRecord[]; total: number }> {
      const where: Prisma.ParentStudentWhereInput = {
        ...(p.schoolId !== undefined && { student: { schoolId: p.schoolId } }),
        ...(p.parentId !== undefined && { parentId: p.parentId }),
        ...(p.studentId !== undefined && { studentId: p.studentId }),
      };
      const [items, total] = await db.$transaction([
        db.parentStudent.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { studentId: 'asc' }],
          skip: p.skip,
          take: p.take,
          select: SELECT,
        }),
        db.parentStudent.count({ where }),
      ]);
      return { items, total };
    },
  };
}

export type ParentStudentsRepository = ReturnType<typeof createParentStudentsRepository>;
