// Row-level access to one class — the class-shaped twin of users/student-scope.ts:
//
//   School Admin  every class of their own school
//   Teacher       the classes they are assigned to (class_teachers)
//   Anyone else   none
//
// A class outside the scope is reported exactly like a missing one.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';
import { Role, type Actor } from '../../shared/rbac/index.js';

export function classScope(actor: Actor): Prisma.ClassWhereInput {
  if (actor.schoolId === null) return { id: { in: [] } };
  if (actor.role === Role.SchoolAdmin) return { schoolId: actor.schoolId };
  if (actor.role === Role.Teacher) return { schoolId: actor.schoolId, teachers: { some: { teacherId: actor.userId } } };
  return { id: { in: [] } };
}

export interface ScopedClass {
  id: string;
  name: string;
  schoolId: string;
}

export function createClassScopeRepository(db: Db) {
  return {
    /** The class, if `actor` may reach it; otherwise null (same as not existing). */
    findClass(actor: Actor, classId: string): Promise<ScopedClass | null> {
      return db.class.findFirst({
        where: { AND: [{ id: classId }, classScope(actor)] },
        select: { id: true, name: true, schoolId: true },
      });
    },

    /** The class's students today, by name. */
    students(classId: string): Promise<{ id: string; fullName: string }[]> {
      return db.user.findMany({
        where: { classLink: { classId } },
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        select: { id: true, fullName: true },
      });
    },
  };
}

export type ClassScopeRepository = ReturnType<typeof createClassScopeRepository>;
