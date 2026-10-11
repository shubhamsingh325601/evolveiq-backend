// Unit tests for the shared RBAC guard (src/shared/rbac). No database, no HTTP server.
import type { FastifyRequest } from 'fastify';
import { describe, expect, test } from 'vitest';
import { UserRole } from '../../generated/prisma/enums.js';
import { REGISTRAR_ROLES } from '../../modules/auth/auth.policy.js';
import { AppError } from '../errors/index.js';
import { actorOf, describeRoles, isRole, requireRole, Role, ROLES, type Actor } from './index.js';

const req = (actor: Actor | null) => ({ actor }) as unknown as FastifyRequest;
const actor = (role: Role): Actor => ({ userId: '00000000-0000-4000-8000-000000000001', role, schoolId: null });

async function outcome(guard: ReturnType<typeof requireRole>, request: FastifyRequest) {
  try {
    // onRequest hooks are invoked with the Fastify instance as `this`; the guard doesn't use it.
    await (guard as unknown as (r: FastifyRequest) => Promise<void>)(request);
    return 'allowed';
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return `${(err as AppError).statusCode} ${(err as AppError).code}`;
  }
}

describe('requireRole (shared RBAC guard)', () => {
  const platformAdminOnly = requireRole(Role.PlatformAdmin);

  test('Platform Admin → allowed', async () => {
    expect(await outcome(platformAdminOnly, req(actor(Role.PlatformAdmin)))).toBe('allowed');
  });

  test.each(ROLES.filter((r) => r !== Role.PlatformAdmin))('%s → 403 FORBIDDEN', async (role) => {
    expect(await outcome(platformAdminOnly, req(actor(role)))).toBe('403 FORBIDDEN');
  });

  test('no authenticated actor → 401 UNAUTHENTICATED (fails closed)', async () => {
    expect(await outcome(platformAdminOnly, req(null))).toBe('401 UNAUTHENTICATED');
  });

  test('multiple allowed roles', async () => {
    const guard = requireRole(Role.PlatformAdmin, Role.SchoolAdmin);
    for (const role of ROLES) {
      const expected = role === Role.PlatformAdmin || role === Role.SchoolAdmin ? 'allowed' : '403 FORBIDDEN';
      expect(await outcome(guard, req(actor(role))), role).toBe(expected);
    }
  });

  test('exposes its allowed roles (deduplicated, frozen) for docs/tests', () => {
    const guard = requireRole(Role.Teacher, Role.Teacher, Role.Parent);
    expect(guard.allowedRoles).toEqual(['teacher', 'parent']);
    expect(Object.isFrozen(guard.allowedRoles)).toBe(true);
  });

  test('an unknown role string in the actor is never admitted', async () => {
    const forged = { userId: 'x', role: 'superuser', schoolId: null } as unknown as Actor;
    expect(await outcome(requireRole(...(ROLES as [Role, ...Role[]])), req(forged))).toBe('403 FORBIDDEN');
  });
});

describe('roles', () => {
  test('the six roles match the database enum exactly', () => {
    expect([...ROLES].sort()).toEqual(Object.values(UserRole).sort());
  });

  test('isRole', () => {
    expect(isRole('platform_admin')).toBe(true);
    expect(isRole('Platform Admin')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  test('describeRoles uses the ARCHITECTURE.md names', () => {
    expect(describeRoles([Role.PlatformAdmin, Role.SchoolAdmin])).toContain('Platform Admin, School Admin');
  });

  test('/auth/register is guarded for exactly Platform Admin and School Admin', () => {
    expect(requireRole(...REGISTRAR_ROLES).allowedRoles).toEqual(['platform_admin', 'school_admin']);
  });
});

describe('actorOf', () => {
  test('returns the actor, or throws 401 when authentication did not run', () => {
    const a = actor(Role.Teacher);
    expect(actorOf(req(a))).toBe(a);
    expect(() => actorOf(req(null))).toThrow(AppError);
  });
});
