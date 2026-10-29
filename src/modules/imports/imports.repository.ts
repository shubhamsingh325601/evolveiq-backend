// Database access for imports. No business rules.
import type { Db } from '../../shared/db/prisma.js';

export interface NewAccount {
  role: 'student' | 'teacher' | 'parent';
  fullName: string;
  email: string | null;
  studentLoginId: string | null;
  secretHash: string;
  /** Lower-cased class names (students: at most one). */
  classKeys: string[];
  /** Students: the parent to link. */
  parentId: string | null;
  /** Parents: the children to link. */
  childIds: string[];
}

/** An import touches at most MAX_IMPORT_ROWS accounts; a slow database still gets a minute. */
const TRANSACTION = { maxWait: 10_000, timeout: 60_000 };

export function createImportsRepository(db: Db) {
  return {
    schoolExists(id: string): Promise<boolean> {
      return db.school.count({ where: { id } }).then((n) => n > 0);
    },

    classesOf(schoolId: string): Promise<{ id: string; name: string }[]> {
      return db.class.findMany({ where: { schoolId }, select: { id: true, name: true } });
    },

    async takenStudentIds(ids: string[]): Promise<Set<string>> {
      const rows = await db.user.findMany({ where: { studentLoginId: { in: ids } }, select: { studentLoginId: true } });
      return new Set(rows.flatMap((r) => (r.studentLoginId ? [r.studentLoginId] : [])));
    },

    async takenEmails(emails: string[]): Promise<Set<string>> {
      const rows = await db.user.findMany({ where: { email: { in: emails } }, select: { email: true } });
      return new Set(rows.flatMap((r) => (r.email ? [r.email] : [])));
    },

    /** Active parents of the school, by lower-case email. */
    async parentsByEmail(schoolId: string, emails: string[]): Promise<Map<string, string>> {
      const rows = await db.user.findMany({
        where: { role: 'parent', schoolId, isActive: true, email: { in: emails } },
        select: { id: true, email: true },
      });
      return new Map(rows.flatMap((r) => (r.email ? [[r.email, r.id] as const] : [])));
    },

    /** Students of the school, by student ID, with whether they already have a parent. */
    async studentsByLoginId(schoolId: string, ids: string[]): Promise<Map<string, { id: string; hasParent: boolean }>> {
      const rows = await db.user.findMany({
        where: { role: 'student', schoolId, studentLoginId: { in: ids } },
        select: { id: true, studentLoginId: true, parentLink: { select: { parentId: true } } },
      });
      return new Map(
        rows.flatMap((r) => (r.studentLoginId ? [[r.studentLoginId, { id: r.id, hasParent: r.parentLink !== null }] as const] : [])),
      );
    },

    /** Everything in one transaction: the new classes, the accounts, their class places and parent links. */
    async create(schoolId: string, newClassNames: string[], accounts: NewAccount[]): Promise<void> {
      await db.$transaction(async (tx) => {
        const classIdByKey = new Map(
          (await tx.class.findMany({ where: { schoolId }, select: { id: true, name: true } })).map((c) => [c.name.toLowerCase(), c.id]),
        );
        for (const name of newClassNames) {
          const created = await tx.class.create({ data: { schoolId, name }, select: { id: true } });
          classIdByKey.set(name.toLowerCase(), created.id);
        }
        for (const account of accounts) {
          const user = await tx.user.create({
            data: {
              role: account.role,
              schoolId,
              fullName: account.fullName,
              email: account.email,
              studentLoginId: account.studentLoginId,
              secretHash: account.secretHash,
            },
            select: { id: true },
          });
          const classIds = account.classKeys.flatMap((key) => {
            const id = classIdByKey.get(key);
            return id ? [id] : [];
          });
          if (account.role === 'student') {
            const [classId] = classIds;
            if (classId) await tx.classStudent.create({ data: { studentId: user.id, classId } });
            if (account.parentId) await tx.parentStudent.create({ data: { studentId: user.id, parentId: account.parentId } });
          } else if (account.role === 'teacher' && classIds.length > 0) {
            await tx.classTeacher.createMany({ data: classIds.map((classId) => ({ classId, teacherId: user.id })) });
          } else if (account.role === 'parent' && account.childIds.length > 0) {
            await tx.parentStudent.createMany({ data: account.childIds.map((studentId) => ({ studentId, parentId: user.id })) });
          }
        }
      }, TRANSACTION);
    },
  };
}

export type ImportsRepository = ReturnType<typeof createImportsRepository>;
