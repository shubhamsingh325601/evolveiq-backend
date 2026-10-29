// Business rules for user management. No HTTP, no SQL.
//
// Who manages whom (PRD §3, the same rule as who may create whom — auth.policy.ts):
//   Platform Admin  every user, in every school
//   School Admin    students, teachers and parents of their own school only
// "Manage" = list, view, edit, deactivate, reactivate. Nobody can deactivate themselves.
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import { rolesManagedBy } from '../auth/auth.policy.js';
import type { ListUsersParams, UserChanges, UserRecord, UsersRepository } from './users.repository.js';
import type { ListUsersQuery, UpdateUserBody, UserDto } from './users.schemas.js';

// Unique index (prisma/migrations) → API field.
const UNIQUE_FIELD: Readonly<Record<string, string>> = {
  users_email_key: 'email',
  users_student_login_id_key: 'studentId',
};

function toDto(u: UserRecord): UserDto {
  return {
    id: u.id,
    role: u.role,
    fullName: u.fullName,
    email: u.email,
    studentId: u.studentLoginId,
    schoolId: u.schoolId,
    parentId: u.parentLink?.parentId ?? null,
    isActive: u.isActive,
    createdAt: u.createdAt.toISOString(),
  };
}

/** May `actor` see and manage `user`? */
function isWithinReach(actor: Actor, user: UserRecord): boolean {
  if (actor.role === Role.PlatformAdmin) return true;
  return (
    actor.schoolId !== null && user.schoolId === actor.schoolId && rolesManagedBy(actor.role).has(user.role)
  );
}

/** The school/role filter an actor's list query is confined to. Throws on out-of-scope filters. */
function listScope(actor: Actor, query: ListUsersQuery): Pick<ListUsersParams, 'schoolId' | 'roles'> {
  if (actor.role === Role.PlatformAdmin) {
    return { schoolId: query.schoolId, roles: query.role && [query.role] };
  }
  const managed = rolesManagedBy(actor.role);
  if (actor.schoolId === null || managed.size === 0) throw Errors.forbidden();
  if (query.schoolId !== undefined && query.schoolId !== actor.schoolId) {
    throw Errors.forbidden('School Admins can only list users in their own school.');
  }
  if (query.role !== undefined && !managed.has(query.role)) {
    throw Errors.forbidden(`Your role cannot manage ${query.role} accounts.`);
  }
  return { schoolId: actor.schoolId, roles: query.role ? [query.role] : [...managed] };
}

export function createUsersService(deps: { repository: UsersRepository }) {
  const { repository } = deps;

  async function list(actor: Actor, query: ListUsersQuery): Promise<{ users: UserDto[]; pagination: Pagination }> {
    const { page, limit, sortBy, sortOrder, isActive, name } = query;
    const { items, total } = await repository.list({
      ...listScope(actor, query),
      skip: (page - 1) * limit,
      take: limit,
      sortBy,
      sortOrder,
      isActive,
      nameContains: name,
    });
    return { users: items.map(toDto), pagination: buildPagination(page, limit, total) };
  }

  // Out-of-reach users get the same 404 as missing ones, so IDs can't be probed.
  async function getById(actor: Actor, id: string): Promise<UserDto> {
    return toDto(await findManaged(actor, id));
  }

  /** Loads a user the actor manages, or throws the same 404 as for a missing one. */
  async function findManaged(actor: Actor, id: string): Promise<UserRecord> {
    const user = await repository.findById(id);
    if (!user || !isWithinReach(actor, user)) throw Errors.notFound('User');
    return user;
  }

  // Adults: fullName, email. Students: fullName, studentId. Stored normalised, as at
  // registration (trimmed name, lower-case email, upper-case student ID).
  async function update(actor: Actor, id: string, body: UpdateUserBody): Promise<UserDto> {
    const user = await findManaged(actor, id);
    const isStudent = user.role === Role.Student;
    if (isStudent && body.email !== undefined) {
      throw Errors.validation([{ field: 'email', message: 'is not allowed for students' }]);
    }
    if (!isStudent && body.studentId !== undefined) {
      throw Errors.validation([{ field: 'studentId', message: 'is allowed for students only' }]);
    }
    const changes: UserChanges = {
      fullName: body.fullName?.trim(),
      email: body.email?.toLowerCase(),
      studentLoginId: body.studentId?.toUpperCase(),
    };
    let updated;
    try {
      updated = await repository.update(id, changes);
    } catch (err) {
      const violation = constraintViolation(err);
      const field = violation?.constraint && UNIQUE_FIELD[violation.constraint];
      if (violation?.kind === 'unique' && field) throw Errors.duplicate(field);
      throw err;
    }
    if (!updated) throw Errors.notFound('User');
    return toDto(updated);
  }

  // Idempotent: deactivating an inactive user succeeds and returns the current state.
  // The user's refresh tokens are revoked; authentication already rejects their access
  // tokens on the next request because it re-checks is_active.
  async function deactivate(actor: Actor, id: string): Promise<UserDto> {
    if (id === actor.userId) throw Errors.forbidden('You cannot deactivate your own account.');
    await findManaged(actor, id);
    const user = await repository.deactivate(id);
    if (!user) throw Errors.notFound('User');
    return toDto(user);
  }

  // Idempotent. The user can log in again; existing lockout rules still apply, and the
  // sessions revoked at deactivation stay revoked (they log in afresh).
  async function reactivate(actor: Actor, id: string): Promise<UserDto> {
    if (id === actor.userId) throw Errors.forbidden('You cannot reactivate your own account.');
    await findManaged(actor, id);
    const user = await repository.reactivate(id);
    if (!user) throw Errors.notFound('User');
    return toDto(user);
  }

  // Only an account with no history can go: a mistake, or someone added and never used.
  // Anyone with records is switched off instead, so the school keeps what happened.
  async function remove(actor: Actor, id: string): Promise<void> {
    if (id === actor.userId) throw Errors.forbidden('You cannot remove your own account.');
    await findManaged(actor, id);
    const result = await repository.remove(id);
    if (result === 'missing') throw Errors.notFound('User');
    if (result === 'has_records') {
      throw Errors.hasRecords(
        'This account has records at school, so it cannot be removed. Switch it off instead: they can no longer sign in, and the records are kept.',
      );
    }
  }

  return { list, getById, update, deactivate, reactivate, remove };
}

export type UsersService = ReturnType<typeof createUsersService>;
