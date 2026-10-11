// The OpenAPI document and the Scalar API reference are served and describe the school
// endpoints (auth, RBAC, params, pagination/sort/filter, errors) alongside the auth ones.
// No database needed: building the app and serving /docs never runs a query.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createPrismaClient, type Db } from '../db/prisma.js';

let app: FastifyInstance;
let db: Db;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let doc: any;

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
  const config = loadConfig();
  db = createPrismaClient({ databaseUrl: config.databaseUrl, poolMax: 1 });
  app = await buildApp({ config, db });
  const r = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
  expect(r.statusCode).toBe(200);
  doc = r.json();
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

describe('API documentation', () => {
  test('Scalar reference is served at /docs', async () => {
    const r = await app.inject({ method: 'GET', url: '/docs/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
  });

  test('OpenAPI 3.1 with a bearer security scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  test('existing auth endpoints are still documented', () => {
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/refresh']));
    expect(doc.paths['/api/v1/auth/register'].post.security).toEqual([{ bearerAuth: [] }]);
  });

  test('all four school endpoints are documented as Platform Admin-only with error responses', () => {
    const ops = [
      ['/api/v1/schools', 'post', ['201', '400', '401', '403', '500']],
      ['/api/v1/schools', 'get', ['200', '400', '401', '403', '500']],
      ['/api/v1/schools/{schoolId}', 'get', ['200', '400', '401', '403', '404', '500']],
      ['/api/v1/schools/{schoolId}', 'patch', ['200', '400', '401', '403', '404', '500']],
    ] as const;
    for (const [path, method, statuses] of ops) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method} ${path}`).toBeDefined();
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(op.description).toContain('Platform Admin');
      expect(Object.keys(op.responses).sort()).toEqual([...statuses].sort());
      expect(op.tags).toEqual(['Schools']);
    }
  });

  test('list endpoint documents pagination, sorting (allowlist) and name filtering', () => {
    const params = doc.paths['/api/v1/schools'].get.parameters;
    const byName = Object.fromEntries(params.map((p: { name: string }) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['limit', 'name', 'page', 'sortBy', 'sortOrder']);
    expect(byName.page.in).toBe('query');
    expect(byName.limit.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
    expect(byName.sortBy.schema.enum).toEqual(['name', 'createdAt', 'updatedAt']);
    expect(byName.sortOrder.schema.enum).toEqual(['asc', 'desc']);
  });

  test('camelCase path parameter and request bodies are documented', () => {
    const view = doc.paths['/api/v1/schools/{schoolId}'].get;
    expect(view.parameters).toEqual([expect.objectContaining({ name: 'schoolId', in: 'path', required: true })]);
    expect(doc.paths['/api/v1/schools'].post.requestBody.content['application/json'].schema).toBeDefined();
    expect(doc.paths['/api/v1/schools/{schoolId}'].patch.requestBody.content['application/json'].schema).toBeDefined();
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['School', 'Pagination', 'SchoolListResponse', 'ErrorResponse']),
    );
  });

  test('logout is documented as authenticated for every role, 204 on success', () => {
    const op = doc.paths['/api/v1/auth/logout']?.post;
    expect(op).toBeDefined();
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op.tags).toEqual(['Auth']);
    for (const label of ['Student', 'Parent', 'Teacher', 'Psychologist', 'School Admin', 'Platform Admin']) {
      expect(op.description).toContain(label);
    }
    expect(Object.keys(op.responses).sort()).toEqual(['204', '400', '401', '500']);
    expect(op.requestBody.content['application/json'].schema).toBeDefined();
  });

  test('every API operation documents bearer auth and its allowed roles (except login / refresh)', () => {
    const PUBLIC = new Set(['/api/v1/auth/login', '/api/v1/auth/refresh']);
    let count = 0;
    for (const [path, ops] of Object.entries(doc.paths as Record<string, Record<string, { security?: unknown; description?: string; tags?: string[] }>>)) {
      if (!path.startsWith('/api/') || PUBLIC.has(path)) continue;
      for (const [method, op] of Object.entries(ops)) {
        count += 1;
        expect(op.security, `${method} ${path}`).toEqual([{ bearerAuth: [] }]);
        expect(op.description, `${method} ${path}`).toContain('Allowed role(s):');
        expect(op.tags?.length, `${method} ${path}`).toBe(1);
      }
    }
    expect(count).toBeGreaterThan(40);
  });

  test('parent-facing (Family) endpoints are Parent-only', () => {
    const family = Object.entries(doc.paths as Record<string, Record<string, { description: string; tags: string[] }>>)
      .filter(([path]) => path.startsWith('/api/v1/family/'));
    expect(family.length).toBeGreaterThanOrEqual(2);
    for (const [path, ops] of family) {
      for (const op of Object.values(ops)) {
        expect(op.tags, path).toEqual(['Family']);
        expect(op.description, path).toContain('Allowed role(s): Parent.');
      }
    }
  });

  test('workflow endpoints are documented', () => {
    const expected = [
      ['/api/v1/parent-students', 'post'], ['/api/v1/parent-students', 'get'], ['/api/v1/parent-students/{studentId}', 'delete'],
      ['/api/v1/classes', 'post'], ['/api/v1/classes', 'get'], ['/api/v1/classes/{classId}', 'get'], ['/api/v1/classes/{classId}', 'patch'],
      ['/api/v1/classes/{classId}/teachers/{teacherId}', 'put'], ['/api/v1/classes/{classId}/students/{studentId}', 'put'],
      ['/api/v1/observations', 'post'], ['/api/v1/observations', 'get'], ['/api/v1/observations/mine', 'get'],
      ['/api/v1/observations/{observationId}', 'get'], ['/api/v1/observations/{observationId}/review', 'post'],
      ['/api/v1/family/observations', 'post'], ['/api/v1/family/observations', 'get'],
      ['/api/v1/activities', 'post'], ['/api/v1/activities', 'get'], ['/api/v1/activities/{activityId}', 'patch'],
      ['/api/v1/activities/{activityId}/archive', 'post'], ['/api/v1/assignments', 'post'], ['/api/v1/assignments/mine', 'get'],
      ['/api/v1/activity-completions', 'post'], ['/api/v1/students/{studentId}/assignments', 'get'],
      ['/api/v1/family/children/{studentId}/assignments', 'get'], ['/api/v1/students/{studentId}/growth-areas', 'get'],
      ['/api/v1/students/{studentId}/streak', 'get'], ['/api/v1/students/{studentId}/monthly-summaries/{month}', 'get'],
    ] as const;
    for (const [path, method] of expected) expect(doc.paths[path]?.[method], `${method} ${path}`).toBeDefined();
    expect(doc.paths['/api/v1/activities'].post.requestBody.content['application/json'].schema).toBeDefined();
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['ActivityContent', 'ActivityAnswer', 'ParentObservation', 'TeacherObservation', 'ReviewObservation', 'FamilyAssignment']),
    );
  });

  test('user endpoints are documented with their roles, params and error responses', () => {
    const ops = [
      ['/api/v1/users', 'get', ['200', '400', '401', '403', '500'], 'School Admin'],
      ['/api/v1/users/{userId}', 'get', ['200', '400', '401', '403', '404', '500'], 'School Admin'],
      ['/api/v1/users/{userId}', 'patch', ['200', '400', '401', '403', '404', '409', '500'], 'School Admin'],
      ['/api/v1/users/{userId}/deactivate', 'post', ['200', '400', '401', '403', '404', '500'], 'School Admin'],
      ['/api/v1/users/{userId}/reactivate', 'post', ['200', '400', '401', '403', '404', '500'], 'School Admin'],
    ] as const;
    for (const [path, method, statuses, role] of ops) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method} ${path}`).toBeDefined();
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(op.tags).toEqual(['Users']);
      expect(op.description).toContain(role);
      expect(Object.keys(op.responses).sort()).toEqual([...statuses].sort());
    }
    expect(doc.paths['/api/v1/users/{userId}'].patch.requestBody.content['application/json'].schema).toBeDefined();
    const byName = Object.fromEntries(doc.paths['/api/v1/users'].get.parameters.map((p: { name: string }) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['isActive', 'limit', 'name', 'page', 'role', 'schoolId', 'sortBy', 'sortOrder']);
    expect(byName.sortBy.schema.enum).toEqual(['fullName', 'createdAt']);
    expect(byName.role.schema.enum).toEqual(['student', 'parent', 'teacher', 'psychologist', 'school_admin', 'platform_admin']);
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['User', 'UserListResponse', 'UserResponse']));
  });
});
