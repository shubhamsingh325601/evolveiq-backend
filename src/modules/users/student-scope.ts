// Row-level access to students — the ONE place that decides which students a caller may act
// on. Every student-facing operation (observations, assignments, progress) filters through
// this, so the rules can't drift between modules:
//
//   Student         themselves only
//   Parent          the children linked to them (parent_students)
//   Teacher         students of the classes they are assigned to (class_teachers × class_students)
//   School Admin    every student of their own school
//   Psychologist    every student (they work across schools — PRD §3, §4)
//   Platform Admin  every student
//
// The route's RBAC guard decides which roles may call an endpoint at all; this decides which
// rows they reach. A student outside the scope is reported exactly like a missing one.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';
import { Role, type Actor } from '../../shared/rbac/index.js';

/** Prisma filter for the students `actor` may reach (always includes role = student). */
export function studentScope(actor: Actor): Prisma.UserWhereInput {
  const isStudent = { role: Role.Student };
  switch (actor.role) {
    case Role.Student:
      return { ...isStudent, id: actor.userId };
    case Role.Parent:
      return { ...isStudent, parentLink: { parentId: actor.userId } };
    case Role.Teacher:
      return { ...isStudent, classLink: { class: { teachers: { some: { teacherId: actor.userId } } } } };
    case Role.SchoolAdmin:
      // A School Admin always has a school (users_school_scope_by_role); fail closed if not.
      return actor.schoolId === null ? { id: { in: [] } } : { ...isStudent, schoolId: actor.schoolId };
    case Role.Psychologist:
    case Role.PlatformAdmin:
      return isStudent;
  }
}

export interface ScopedStudent {
  id: string;
  fullName: string;
  schoolId: string | null;
  createdAt: Date;
}

export function createStudentScopeRepository(db: Db) {
  return {
    /** The student, if `actor` may reach them; otherwise null (same as not existing). */
    findStudent(actor: Actor, studentId: string): Promise<ScopedStudent | null> {
      return db.user.findFirst({
        where: { AND: [{ id: studentId }, studentScope(actor)] },
        select: { id: true, fullName: true, schoolId: true, createdAt: true },
      });
    },
  };
}

export type StudentScopeRepository = ReturnType<typeof createStudentScopeRepository>;
