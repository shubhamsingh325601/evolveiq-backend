// Who may create which accounts — derived ONLY from PRD §3 ("Roles and permission boundaries").
//
//   Platform Admin  "create and deactivate every user type"      → all six roles
//   School Admin    "Manage students, teachers, classes, parents" → student, teacher, parent (own school)
//   Teacher         "Must never add, remove or deactivate any user"
//   Psychologist    "Must never manage schools, users or billing"
//   Parent/Student  no user-management rights documented
//
// There is no public self-sign-up in the PRD: every account is created by an admin.

import { Errors } from '../../lib/errors.js';

export const ROLES = Object.freeze([
  'student', 'parent', 'teacher', 'school_admin', 'psychologist', 'platform_admin',
]);

const CREATABLE_BY = Object.freeze({
  platform_admin: new Set(ROLES),
  school_admin: new Set(['student', 'teacher', 'parent']),
});

export const REGISTRAR_ROLES = Object.freeze(Object.keys(CREATABLE_BY));

// Psychologist and Platform Admin work across schools (C3 filters the queue "by school").
const SCHOOL_SCOPED = new Set(['student', 'parent', 'teacher', 'school_admin']);

export function canRegister(actorRole) {
  return Object.hasOwn(CREATABLE_BY, actorRole);
}

// Returns the school the new user belongs to, or throws. Pure: no I/O.
export function authorizeRegistration(actor, body) {
  if (!CREATABLE_BY[actor.role]?.has(body.role)) {
    throw Errors.forbidden(`Your role cannot create ${body.role} accounts.`);
  }

  if (!SCHOOL_SCOPED.has(body.role)) return null;

  if (actor.role === 'school_admin') {
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
