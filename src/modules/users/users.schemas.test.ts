// Route-boundary validation for the user-management list query and params.
import { describe, expect, test } from 'vitest';
import { ListUsersQuerySchema, UserIdParamsSchema } from './users.schemas.js';

describe('ListUsersQuerySchema', () => {
  test('defaults', () => {
    expect(ListUsersQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sortBy: 'fullName', sortOrder: 'asc' });
  });

  test('parses every filter', () => {
    expect(
      ListUsersQuerySchema.parse({
        page: '2', limit: '50', sortBy: 'createdAt', sortOrder: 'desc', role: 'parent',
        schoolId: '11111111-1111-4111-8111-111111111111', isActive: 'false', name: '  Kavya ',
      }),
    ).toEqual({
      page: 2, limit: 50, sortBy: 'createdAt', sortOrder: 'desc', role: 'parent',
      schoolId: '11111111-1111-4111-8111-111111111111', isActive: false, name: 'Kavya',
    });
  });

  test('isActive accepts exactly "true" / "false"', () => {
    expect(ListUsersQuerySchema.parse({ isActive: 'true' }).isActive).toBe(true);
    expect(ListUsersQuerySchema.parse({ isActive: 'false' }).isActive).toBe(false);
    for (const value of ['1', '0', 'TRUE', 'yes', '']) {
      expect(ListUsersQuerySchema.safeParse({ isActive: value }).success, value).toBe(false);
    }
  });

  test('blank name = no filter', () => {
    expect(ListUsersQuerySchema.parse({ name: '   ' }).name).toBeUndefined();
  });

  test.each([
    { sortBy: 'email' },
    { sortBy: 'secretHash' },
    { sortBy: 'role' },
    { sortOrder: 'ASC' },
    { role: 'admin' },
    { schoolId: 'not-a-uuid' },
    { name: 'x'.repeat(101) },
    { limit: '101' },
    { page: '0' },
    { other: '1' },
  ])('rejects %o', (raw) => {
    expect(ListUsersQuerySchema.safeParse(raw).success).toBe(false);
  });
});

describe('UserIdParamsSchema', () => {
  test('accepts a UUID, rejects anything else', () => {
    expect(UserIdParamsSchema.safeParse({ userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    for (const userId of ['', 'abc', '11111111-1111-4111-8111-11111111111', "1' OR '1'='1"]) {
      expect(UserIdParamsSchema.safeParse({ userId }).success, userId).toBe(false);
    }
  });
});
