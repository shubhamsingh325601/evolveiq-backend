// Database access for classes and class membership. No business rules here.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';
import { escapeLike, type SortOrder } from '../../shared/pagination/index.js';
import type { ClassSortField } from './classes.schemas.js';

const SELECT = { id: true, schoolId: true, name: true, createdAt: true, updatedAt: true } as const satisfies Prisma.ClassSelect;
export type ClassRecord = Prisma.ClassGetPayload<{ select: typeof SELECT }>;

const MEMBER = { id: true, fullName: true } as const;
export interface Member {
  id: string;
  fullName: string;
}

export interface ListClassesParams {
  readonly skip: number;
  readonly take: number;
  readonly sortBy: ClassSortField;
  readonly sortOrder: SortOrder;
  readonly schoolId: string;
  /** Only classes this teacher is assigned to. */
  readonly teacherId?: string | undefined;
  readonly nameContains?: string | undefined;
}

export interface AddMemberRow {
  is_class_found: boolean;
  is_member_found: boolean;
  is_inserted: boolean;
  /** Class membership the student already had (students only; null if none / not checked). */
  current_class_id: string | null;
}

const ORDER_BY: Readonly<Record<ClassSortField, (o: SortOrder) => Prisma.ClassOrderByWithRelationInput[]>> = {
  name: (o) => [{ name: o }, { id: 'asc' }],
  createdAt: (o) => [{ createdAt: o }, { id: 'asc' }],
};

export function createClassesRepository(db: Db) {
  return {
    /** Unique violations (duplicate name in the school) propagate. */
    create(schoolId: string, name: string): Promise<ClassRecord> {
      return db.class.create({ data: { schoolId, name }, select: SELECT });
    },

    /** The class if it is in `schoolId` and, when given, `teacherId` is assigned to it. */
    findInSchool(classId: string, schoolId: string, teacherId?: string): Promise<ClassRecord | null> {
      return db.class.findFirst({
        where: { id: classId, schoolId, ...(teacherId !== undefined && { teachers: { some: { teacherId } } }) },
        select: SELECT,
      });
    },

    /** Returns null when the class is not in `schoolId`. Unique violations propagate. */
    async rename(classId: string, schoolId: string, name: string): Promise<ClassRecord | null> {
      const { count } = await db.class.updateMany({ where: { id: classId, schoolId }, data: { name } });
      return count === 0 ? null : db.class.findUnique({ where: { id: classId }, select: SELECT });
    },

    async list(p: ListClassesParams): Promise<{ items: ClassRecord[]; total: number }> {
      const where: Prisma.ClassWhereInput = {
        schoolId: p.schoolId,
        ...(p.teacherId !== undefined && { teachers: { some: { teacherId: p.teacherId } } }),
        ...(p.nameContains && { name: { contains: escapeLike(p.nameContains), mode: 'insensitive' } }),
      };
      const [items, total] = await db.$transaction([
        db.class.findMany({ where, orderBy: ORDER_BY[p.sortBy](p.sortOrder), skip: p.skip, take: p.take, select: SELECT }),
        db.class.count({ where }),
      ]);
      return { items, total };
    },

    async members(classId: string): Promise<{ teachers: Member[]; students: Member[] }> {
      const [teachers, students] = await db.$transaction([
        db.user.findMany({ where: { teacherOf: { some: { classId } } }, orderBy: [{ fullName: 'asc' }, { id: 'asc' }], select: MEMBER }),
        db.user.findMany({ where: { classLink: { classId } }, orderBy: [{ fullName: 'asc' }, { id: 'asc' }], select: MEMBER }),
      ]);
      return { teachers, students };
    },

    // ONE statement: the class and the teacher must both be in `schoolId`; assigning twice
    // is a no-op (primary key (class_id, teacher_id)).
    async addTeacher(a: { classId: string; teacherId: string; schoolId: string }): Promise<AddMemberRow> {
      const rows = await db.$queryRaw<AddMemberRow[]>`
        WITH c AS (SELECT id FROM classes WHERE id = ${a.classId}::uuid AND school_id = ${a.schoolId}::uuid),
        t AS (
          SELECT id FROM users
          WHERE id = ${a.teacherId}::uuid AND role = 'teacher' AND school_id = ${a.schoolId}::uuid
        ),
        ins AS (
          INSERT INTO class_teachers (class_id, teacher_id)
          SELECT c.id, t.id FROM c, t
          ON CONFLICT (class_id, teacher_id) DO NOTHING
          RETURNING class_id
        )
        SELECT EXISTS (SELECT 1 FROM c) AS is_class_found, EXISTS (SELECT 1 FROM t) AS is_member_found,
               EXISTS (SELECT 1 FROM ins) AS is_inserted, NULL::uuid AS current_class_id`;
      const row = rows[0];
      if (!row) throw new Error('addTeacher returned no row');
      return row;
    },

    // ONE statement: the class and the student must both be in `schoolId`. A student is in
    // at most one class (primary key student_id): if they already are, nothing is inserted
    // and current_class_id says where.
    async addStudent(a: { classId: string; studentId: string; schoolId: string }): Promise<AddMemberRow> {
      const rows = await db.$queryRaw<AddMemberRow[]>`
        WITH c AS (SELECT id FROM classes WHERE id = ${a.classId}::uuid AND school_id = ${a.schoolId}::uuid),
        s AS (
          SELECT id FROM users
          WHERE id = ${a.studentId}::uuid AND role = 'student' AND school_id = ${a.schoolId}::uuid
        ),
        ins AS (
          INSERT INTO class_students (student_id, class_id)
          SELECT s.id, c.id FROM s, c
          ON CONFLICT (student_id) DO NOTHING
          RETURNING class_id
        )
        SELECT EXISTS (SELECT 1 FROM c) AS is_class_found, EXISTS (SELECT 1 FROM s) AS is_member_found,
               EXISTS (SELECT 1 FROM ins) AS is_inserted,
               (SELECT class_id FROM class_students WHERE student_id = ${a.studentId}::uuid) AS current_class_id`;
      const row = rows[0];
      if (!row) throw new Error('addStudent returned no row');
      return row;
    },

    /** Removes the assignment if the class is in `schoolId`. Returns whether one was removed. */
    async removeTeacher(a: { classId: string; teacherId: string; schoolId: string }): Promise<boolean> {
      const { count } = await db.classTeacher.deleteMany({
        where: { classId: a.classId, teacherId: a.teacherId, class: { schoolId: a.schoolId } },
      });
      return count > 0;
    },

    /** Removes the membership if the class is in `schoolId`. Returns whether one was removed. */
    async removeStudent(a: { classId: string; studentId: string; schoolId: string }): Promise<boolean> {
      const { count } = await db.classStudent.deleteMany({
        where: { classId: a.classId, studentId: a.studentId, class: { schoolId: a.schoolId } },
      });
      return count > 0;
    },

    /**
     * Deletes the class if it is in `schoolId`, with its teacher assignments and student places
     * (the students stay at the school, in no class). Returns whether one was deleted.
     */
    async remove(classId: string, schoolId: string): Promise<boolean> {
      return db.$transaction(async (tx) => {
        const found = await tx.class.findFirst({ where: { id: classId, schoolId }, select: { id: true } });
        if (!found) return false;
        await tx.classTeacher.deleteMany({ where: { classId } });
        await tx.classStudent.deleteMany({ where: { classId } });
        await tx.class.delete({ where: { id: classId } });
        return true;
      });
    },
  };
}

export type ClassesRepository = ReturnType<typeof createClassesRepository>;
