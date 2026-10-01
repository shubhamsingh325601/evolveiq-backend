// Unit tests for the school request schemas (Zod, route boundary).
import { describe, expect, test } from 'vitest';
import {
  CreateSchoolBodySchema,
  ListSchoolsQuerySchema,
  RenameSchoolBodySchema,
  SchoolIdParamsSchema,
} from './schools.schemas.js';

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.join('.'));

describe('list query', () => {
  test('defaults', () => {
    expect(ListSchoolsQuerySchema.parse({})).toEqual({ page: 1, limit: 20, sortBy: 'name', sortOrder: 'asc' });
  });

  test('parses valid values', () => {
    expect(ListSchoolsQuerySchema.parse({ page: '2', limit: '100', sortBy: 'updatedAt', sortOrder: 'desc', name: 'abc' }))
      .toEqual({ page: 2, limit: 100, sortBy: 'updatedAt', sortOrder: 'desc', name: 'abc' });
  });

  test.each(['0', '-1', '1.5', 'abc', '', ' 1', '1e2', '0x10', '01', '10001'])('page=%j is rejected', (page) => {
    expect(issues(ListSchoolsQuerySchema.safeParse({ page }))).toContain('page');
  });

  test.each(['0', '101', '-5', 'ten', '20.0'])('limit=%j is rejected', (limit) => {
    expect(issues(ListSchoolsQuerySchema.safeParse({ limit }))).toContain('limit');
  });

  test('repeated query keys (arrays) are rejected', () => {
    expect(issues(ListSchoolsQuerySchema.safeParse({ page: ['1', '2'] }))).toContain('page');
  });

  test.each(['id', 'password', 'secret_hash', 'users', '__proto__', 'constructor', 'name; DROP TABLE schools', 'NAME', ''])(
    'sortBy=%j is not in the allowlist → rejected',
    (sortBy) => {
      expect(issues(ListSchoolsQuerySchema.safeParse({ sortBy }))).toContain('sortBy');
    },
  );

  test.each(['ASC', 'up', 'descending', ''])('sortOrder=%j is rejected', (sortOrder) => {
    expect(issues(ListSchoolsQuerySchema.safeParse({ sortOrder }))).toContain('sortOrder');
  });

  test('name filter is trimmed; blank means "no filter"; length is capped', () => {
    expect(ListSchoolsQuerySchema.parse({ name: '  sun  ' }).name).toBe('sun');
    expect(ListSchoolsQuerySchema.parse({ name: '   ' }).name).toBeUndefined();
    expect(issues(ListSchoolsQuerySchema.safeParse({ name: 'x'.repeat(201) }))).toContain('name');
  });

  test('unknown query parameters are rejected', () => {
    expect(ListSchoolsQuerySchema.safeParse({ sort: 'name' }).success).toBe(false);
  });
});

describe('create / rename body', () => {
  for (const [label, schema] of [['create', CreateSchoolBodySchema], ['rename', RenameSchoolBodySchema]] as const) {
    test(`${label}: accepts 1–200 visible characters`, () => {
      expect(schema.parse({ name: 'A' })).toEqual({ name: 'A' });
      expect(schema.safeParse({ name: 'x'.repeat(200) }).success).toBe(true);
    });

    test.each([
      ['missing', {}],
      ['empty', { name: '' }],
      ['blank', { name: '   ' }],
      ['too long', { name: 'x'.repeat(201) }],
      ['control character', { name: 'Bad\u0007Name' }],
      ['not a string', { name: 42 }],
      ['null', { name: null }],
    ])(`${label}: %s → rejected`, (_case, body) => {
      expect(issues(schema.safeParse(body))).toContain('name');
    });

    test(`${label}: unknown fields are rejected`, () => {
      expect(schema.safeParse({ name: 'OK', id: 'x' }).success).toBe(false);
    });
  }
});

describe('schoolId param', () => {
  test('UUID accepted, anything else rejected', () => {
    expect(SchoolIdParamsSchema.safeParse({ schoolId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true);
    for (const schoolId of ['1', 'abc', '11111111-1111-4111-8111-11111111111', "1' OR '1'='1"]) {
      expect(SchoolIdParamsSchema.safeParse({ schoolId }).success, schoolId).toBe(false);
    }
  });

  test('the route param is camelCase `schoolId`, not `id`', () => {
    expect(SchoolIdParamsSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
  });
});
