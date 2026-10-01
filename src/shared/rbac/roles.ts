// The six roles from ARCHITECTURE.md, in the project's existing storage format
// (Postgres enum `user_role`, lower snake_case — also what the JWT `role` claim carries).
import type { UserRole } from '../../generated/prisma/enums.js';

export const Role = {
  Student: 'student',
  Parent: 'parent',
  Teacher: 'teacher',
  Psychologist: 'psychologist',
  SchoolAdmin: 'school_admin',
  PlatformAdmin: 'platform_admin',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ROLES: readonly Role[] = Object.freeze(Object.values(Role));

/** Human-readable names, as written in ARCHITECTURE.md. Used in API docs. */
export const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
  student: 'Student',
  parent: 'Parent',
  teacher: 'Teacher',
  psychologist: 'Psychologist',
  school_admin: 'School Admin',
  platform_admin: 'Platform Admin',
});

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

// Compile-time guarantee that the RBAC roles and the database enum never drift apart.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const IS_ROLE_TYPE_IN_SYNC_WITH_DB: Same<Role, UserRole> = true;
void IS_ROLE_TYPE_IN_SYNC_WITH_DB;
