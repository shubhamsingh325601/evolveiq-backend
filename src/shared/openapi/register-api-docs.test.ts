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
});
