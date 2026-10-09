// Service-level unit tests for user management: scoping rules with a mocked repository.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AppError } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import type { UserRecord, UsersRepository } from './users.repository.js';
import { ListUsersQuerySchema } from './users.schemas.js';
import { createUsersService } from './users.service.js';

const SCHOOL_A = '11111111-1111-4111-8111-111111111111';
const SCHOOL_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const PLATFORM_ADMIN: Actor = { userId: '44444444-4444-4444-8444-444444444444', role: 'platform_admin', schoolId: null };
const SCHOOL_ADMIN: Actor = { userId: '55555555-5555-4555-8555-555555555555', role: 'school_admin', schoolId: SCHOOL_A };

const record = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: USER_ID,
  role: 'student',
  fullName: 'Sam Student',
  email: null,
  studentLoginId: 'A-1001',
  schoolId: SCHOOL_A,
  parentLink: null,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

const query = (raw: Record<string, string> = {}) => ListUsersQuerySchema.parse(raw);

async function expectAppError(promise: Promise<unknown>, statusCode: number, code: string) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ statusCode, code });
}

let repo: { [K in keyof UsersRepository]: ReturnType<typeof vi.fn> };
let service: ReturnType<typeof createUsersService>;

beforeEach(() => {
  repo = {
    findById: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    deactivate: vi.fn(), reactivate: vi.fn(), update: vi.fn(),
  };
  service = createUsersService({ repository: repo as unknown as UsersRepository });
});

describe('list — scope', () => {
  test('Platform Admin: no implicit school or role restriction', async () => {
    await service.list(PLATFORM_ADMIN, query());
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ schoolId: undefined, roles: undefined }));
  });

  test('Platform Admin: filters pass through', async () => {
    await service.list(PLATFORM_ADMIN, query({ schoolId: SCHOOL_B, role: 'teacher', isActive: 'false', name: ' ab ' }));
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: SCHOOL_B, roles: ['teacher'], isActive: false, nameContains: 'ab' }),
    );
  });

  test('School Admin: forced to own school and to the roles they manage', async () => {
    await service.list(SCHOOL_ADMIN, query());
    const params = repo.list.mock.calls[0]![0];
    expect(params.schoolId).toBe(SCHOOL_A);
    expect([...params.roles].sort()).toEqual(['parent', 'student', 'teacher']);
  });

  test('School Admin: own school + managed role is allowed', async () => {
    await service.list(SCHOOL_ADMIN, query({ schoolId: SCHOOL_A, role: 'parent' }));
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ schoolId: SCHOOL_A, roles: ['parent'] }));
  });

  test('School Admin: another school → 403, repository never called', async () => {
    await expectAppError(service.list(SCHOOL_ADMIN, query({ schoolId: SCHOOL_B })), 403, 'FORBIDDEN');
    expect(repo.list).not.toHaveBeenCalled();
  });

  test.each(['school_admin', 'psychologist', 'platform_admin'])('School Admin: unmanaged role %s → 403', async (role) => {
    await expectAppError(service.list(SCHOOL_ADMIN, query({ role })), 403, 'FORBIDDEN');
    expect(repo.list).not.toHaveBeenCalled();
  });

  test.each<Actor>([
    { userId: USER_ID, role: 'teacher', schoolId: SCHOOL_A },
    { userId: USER_ID, role: 'psychologist', schoolId: null },
    { userId: USER_ID, role: 'school_admin', schoolId: null },
  ])('any other caller ($role, school $schoolId) → 403 even if the route guard were bypassed', async (actor) => {
    await expectAppError(service.list(actor, query()), 403, 'FORBIDDEN');
  });

  test('page → skip/take, and pagination metadata', async () => {
    repo.list.mockResolvedValue({ items: [record()], total: 41 });
    const r = await service.list(PLATFORM_ADMIN, query({ page: '3', limit: '20' }));
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ skip: 40, take: 20 }));
    expect(r.pagination).toEqual({ page: 3, limit: 20, total: 41, totalPages: 3, hasNextPage: false, hasPreviousPage: true });
  });
});

describe('getById', () => {
  test('maps the record to the DTO (studentLoginId → studentId, ISO dates)', async () => {
    repo.findById.mockResolvedValue(record({ parentLink: { parentId: USER_ID } }));
    expect(await service.getById(PLATFORM_ADMIN, USER_ID)).toEqual({
      id: USER_ID,
      role: 'student',
      fullName: 'Sam Student',
      email: null,
      studentId: 'A-1001',
      schoolId: SCHOOL_A,
      parentId: USER_ID,
      isActive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  test('missing → 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expectAppError(service.getById(PLATFORM_ADMIN, USER_ID), 404, 'NOT_FOUND');
  });

  test.each([
    ['another school', record({ schoolId: SCHOOL_B })],
    ['a School Admin of the same school', record({ role: 'school_admin', email: 'x@y.z', studentLoginId: null })],
    ['a psychologist', record({ role: 'psychologist', schoolId: null, email: 'x@y.z', studentLoginId: null })],
  ])('School Admin viewing %s → 404', async (_label, user) => {
    repo.findById.mockResolvedValue(user);
    await expectAppError(service.getById(SCHOOL_ADMIN, USER_ID), 404, 'NOT_FOUND');
  });

  test.each(['student', 'teacher', 'parent'] as const)('School Admin viewing a %s of their school → ok', async (role) => {
    repo.findById.mockResolvedValue(record({ role }));
    expect((await service.getById(SCHOOL_ADMIN, USER_ID)).role).toBe(role);
  });
});

describe('deactivate / reactivate', () => {
  test.each(['deactivate', 'reactivate'] as const)('Platform Admin can %s anyone', async (action) => {
    repo.findById.mockResolvedValue(record({ schoolId: SCHOOL_B, role: 'school_admin' }));
    repo[action].mockResolvedValue(record({ isActive: action === 'reactivate' }));
    expect((await service[action](PLATFORM_ADMIN, USER_ID)).isActive).toBe(action === 'reactivate');
    expect(repo[action]).toHaveBeenCalledWith(USER_ID);
  });

  test.each(['deactivate', 'reactivate'] as const)('School Admin can %s a student/teacher/parent of their school', async (action) => {
    for (const role of ['student', 'teacher', 'parent'] as const) {
      repo.findById.mockResolvedValue(record({ role }));
      repo[action].mockResolvedValue(record({ role }));
      await service[action](SCHOOL_ADMIN, USER_ID);
    }
    expect(repo[action]).toHaveBeenCalledTimes(3);
  });

  test.each(['deactivate', 'reactivate'] as const)('School Admin: anyone outside their reach → 404, nothing written (%s)', async (action) => {
    for (const user of [
      record({ schoolId: SCHOOL_B }),
      record({ role: 'school_admin', email: 'x@y.z', studentLoginId: null }),
      record({ role: 'psychologist', schoolId: null, email: 'x@y.z', studentLoginId: null }),
    ]) {
      repo.findById.mockResolvedValue(user);
      await expectAppError(service[action](SCHOOL_ADMIN, USER_ID), 404, 'NOT_FOUND');
    }
    expect(repo[action]).not.toHaveBeenCalled();
  });

  test.each(['deactivate', 'reactivate'] as const)('own account → 403 for every admin, repository never called (%s)', async (action) => {
    await expectAppError(service[action](PLATFORM_ADMIN, PLATFORM_ADMIN.userId), 403, 'FORBIDDEN');
    await expectAppError(service[action](SCHOOL_ADMIN, SCHOOL_ADMIN.userId), 403, 'FORBIDDEN');
    expect(repo.findById).not.toHaveBeenCalled();
    expect(repo[action]).not.toHaveBeenCalled();
  });

  test('unknown user → 404', async () => {
    repo.findById.mockResolvedValue(null);
    await expectAppError(service.deactivate(PLATFORM_ADMIN, USER_ID), 404, 'NOT_FOUND');
    await expectAppError(service.reactivate(PLATFORM_ADMIN, USER_ID), 404, 'NOT_FOUND');
  });
});

describe('update', () => {
  test('student: trims the name and upper-cases the student ID', async () => {
    repo.findById.mockResolvedValue(record());
    repo.update.mockResolvedValue(record({ fullName: 'New Name', studentLoginId: 'B-2' }));
    const user = await service.update(SCHOOL_ADMIN, USER_ID, { fullName: '  New Name ', studentId: 'b-2' });
    expect(repo.update).toHaveBeenCalledWith(USER_ID, { fullName: 'New Name', email: undefined, studentLoginId: 'B-2' });
    expect(user.studentId).toBe('B-2');
  });

  test('adult: lower-cases the email', async () => {
    repo.findById.mockResolvedValue(record({ role: 'teacher', email: 'a@b.c', studentLoginId: null }));
    repo.update.mockResolvedValue(record({ role: 'teacher', email: 'new@b.c', studentLoginId: null }));
    await service.update(PLATFORM_ADMIN, USER_ID, { email: 'NEW@B.C' });
    expect(repo.update).toHaveBeenCalledWith(USER_ID, { fullName: undefined, email: 'new@b.c', studentLoginId: undefined });
  });

  test('student email / adult studentId → 400 naming the field, nothing written', async () => {
    repo.findById.mockResolvedValue(record());
    await expectAppError(service.update(PLATFORM_ADMIN, USER_ID, { email: 'a@b.c' }), 400, 'VALIDATION_ERROR');
    repo.findById.mockResolvedValue(record({ role: 'parent', email: 'a@b.c', studentLoginId: null }));
    await expectAppError(service.update(PLATFORM_ADMIN, USER_ID, { studentId: 'A-1' }), 400, 'VALIDATION_ERROR');
    expect(repo.update).not.toHaveBeenCalled();
  });

  test('School Admin: out of reach → 404, nothing written', async () => {
    repo.findById.mockResolvedValue(record({ schoolId: SCHOOL_B }));
    await expectAppError(service.update(SCHOOL_ADMIN, USER_ID, { fullName: 'X' }), 404, 'NOT_FOUND');
    expect(repo.update).not.toHaveBeenCalled();
  });
});
