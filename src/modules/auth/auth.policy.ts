// Who may create which accounts — derived ONLY from PRD §3 ("Roles and permission boundaries").
//
//   Platform Admin  "create and deactivate every user type"      → all six roles
//   School Admin    "Manage students, teachers, classes, parents" → student, teacher, parent (own school)
//   Teacher         "Must never add, remove or deactivate any user"
//   Psychologist    "Must never manage schools, users or billing"
//   Parent/Student  no user-management rights documented
//
// There is no public self-sign-up in the PRD: every account is created by an admin.
//
// Two layers:
//   1. REGISTRAR_ROLES — "may this role call /auth/register at all?" Enforced by the shared
//      RBAC guard on the route (src/shared/rbac), not here.
//   2. authorizeRegistration — "may THIS actor create THIS account in THIS school?" Depends
//      on the request body, so it is a business rule applied by the service.

import { Errors } from '../../shared/errors/index.js';
import { ROLES, Role, type Actor } from '../../shared/rbac/index.js';

const CREATABLE_BY: Readonly<Partial<Record<Role, ReadonlySet<Role>>>> = Object.freeze({
  [Role.PlatformAdmin]: new Set(ROLES),
  [Role.SchoolAdmin]: new Set<Role>([Role.Student, Role.Teacher, Role.Parent]),
});

export const REGISTRAR_ROLES = Object.freeze([Role.PlatformAdmin, Role.SchoolAdmin] as const);

// Psychologist and Platform Admin work across schools (C3 filters the queue "by school").
const SCHOOL_SCOPED: ReadonlySet<Role> = new Set<Role>([
  Role.Student, Role.Parent, Role.Teacher, Role.SchoolAdmin,
]);

export interface RegistrationTarget {
  readonly role: Role;
  readonly schoolId?: string | undefined;
}

// Returns the school the new user belongs to, or throws. Pure: no I/O.
export function authorizeRegistration(actor: Actor, body: RegistrationTarget): string | null {
  if (!CREATABLE_BY[actor.role]?.has(body.role)) {
    throw Errors.forbidden(`Your role cannot create ${body.role} accounts.`);
  }

  if (!SCHOOL_SCOPED.has(body.role)) return null;

  if (actor.role === Role.SchoolAdmin) {
    // "Whole school" scope: a School Admin always creates users in their own school.
    if (body.schoolId && body.schoolId !== actor.schoolId) {
      throw Errors.forbidden('School Admins can only create users in their own school.');
    }
    return actor.schoolId;
  }

  // Platform Admin must say which school.
  if (!body.schoolId) {
    throw Errors.validation([{ field: 'schoolId', message: `is required for ${body.role} accounts` }]);
  }
  return body.schoolId;
}
