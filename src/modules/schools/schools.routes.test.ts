// School API integration tests — Supertest over HTTP against the real app + PostgreSQL.
// Covers RBAC (shared guard), create / list (pagination, sorting, filtering) / view / rename,
// validation, not-found and database-error handling.
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const BASE = '/api/v1/schools';
const SCHOOL_KEYS = ['createdAt', 'id', 'name', 'updatedAt'];
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

let ctx: TestContext;
let rootToken: string;
const roleTokens: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  const pw = 'Role-Password-1';
  roleTokens.school_admin = (await createAndLogin(ctx, rootToken, { role: 'school_admin', fullName: 'SA', email: 'sa@evolviq.test', password: pw, schoolId: SCHOOL_A })).token;
  roleTokens.teacher = (await createAndLogin(ctx, rootToken, { role: 'teacher', fullName: 'T', email: 't@evolviq.test', password: pw, schoolId: SCHOOL_A })).token;
  roleTokens.parent = (await createAndLogin(ctx, rootToken, { role: 'parent', fullName: 'P', email: 'p@evolviq.test', password: pw, schoolId: SCHOOL_A })).token;
  roleTokens.psychologist = (await createAndLogin(ctx, rootToken, { role: 'psychologist', fullName: 'Ps', email: 'ps@evolviq.test', password: pw })).token;
  roleTokens.student = (await createAndLogin(ctx, rootToken, { role: 'student', fullName: 'S', studentId: 'SCH-1', pin: '246813', schoolId: SCHOOL_A })).token;
});

afterAll(async () => {
  await ctx?.close();
});

const create = (body: unknown, token: string = rootToken) => ctx.post(BASE, body, token);
const list = (qs = '', token: string = rootToken) => ctx.get(`${BASE}${qs}`, token);
const view = (id: string, token: string = rootToken) => ctx.get(`${BASE}/${id}`, token);
const rename = (id: string, body: unknown, token: string = rootToken) => ctx.patch(`${BASE}/${id}`, body, token);
const schoolCount = async () => (await ctx.pg.query('SELECT count(*)::int AS n FROM schools')).rows[0].n as number;
const dbName = async (id: string) => (await ctx.pg.query('SELECT name FROM schools WHERE id = $1', [id])).rows[0]?.name;

// ─────────────────────────────── RBAC ───────────────────────────────
describe('RBAC — shared guard on every school endpoint', () => {
  const calls = () => [
    ['POST', BASE, { name: 'RBAC Probe School' }],
    ['GET', BASE, undefined],
    ['GET', `${BASE}/${SCHOOL_A}`, undefined],
    ['PATCH', `${BASE}/${SCHOOL_A}`, { name: 'Hijacked' }],
  ] as const;

  test('unauthenticated (no / garbage / forged / expired token) → 401 UNAUTHENTICATED', async () => {
    const forged = await new SignJWT({ role: 'platform_admin', sid: null })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(randomUUID())
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience).setExpirationTime('1h')
      .sign(new TextEncoder().encode('not-the-server-secret-not-the-server-secret'));
    const rootId = (await ctx.pg.query(`SELECT id FROM users WHERE email = $1`, [ADMIN.email])).rows[0].id;
    const expired = await new SignJWT({ role: 'platform_admin', sid: null })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(rootId)
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(ctx.config.jwt.secret);
    for (const token of [undefined, 'garbage', 'a.b.c', forged, expired]) {
      for (const [method, url, body] of calls()) {
        const r = await ctx.send(method, url, { body, token });
        expect(r.status, `${method} ${url} token=${String(token).slice(0, 10)}`).toBe(401);
        expect(r.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } });
      }
    }
  });

  test('a refresh token is not accepted as an access token → 401', async () => {
    const refreshToken = (await ctx.login(ADMIN)).body.refreshToken;
    expect((await list('', refreshToken)).status).toBe(401);
  });

  test.each(['school_admin', 'teacher', 'parent', 'psychologist', 'student'])(
    'authenticated %s (not Platform Admin) → 403 FORBIDDEN on all four endpoints, nothing changes',
    async (role) => {
      const before = await schoolCount();
      for (const [method, url, body] of calls()) {
        const r = await ctx.send(method, url, { body, token: roleTokens[role] });
        expect(r.status, `${role} ${method} ${url}`).toBe(403);
        expect(r.body).toEqual({ error: { code: 'FORBIDDEN', message: 'You are not allowed to perform this action.' } });
      }
      expect(await schoolCount()).toBe(before);
      expect(await dbName(SCHOOL_A)).toBe('Demo School A');
    },
  );

  test('the guard runs before validation: non-admins get 403 even for an invalid request', async () => {
    expect((await create({ bogus: true }, roleTokens.teacher)).status).toBe(403);
    expect((await list('?sortBy=password', roleTokens.school_admin)).status).toBe(403);
    expect((await view('not-a-uuid', roleTokens.parent)).status).toBe(403);
    // …and unauthenticated callers get 401 first.
    expect((await ctx.post(BASE, { bogus: true })).status).toBe(401);
  });

  test('Platform Admin → allowed on all four endpoints', async () => {
    const created = await create({ name: 'RBAC Allowed School' });
    expect(created.status).toBe(201);
    const id = created.body.school.id;
    expect((await list()).status).toBe(200);
    expect((await view(id)).status).toBe(200);
    expect((await rename(id, { name: 'RBAC Allowed School 2' })).status).toBe(200);
  });

  test('a second Platform Admin created via /auth/register is also allowed', async () => {
    const pa = await createAndLogin(ctx, rootToken, { role: 'platform_admin', fullName: 'PA2', email: 'pa2@evolviq.test', password: 'Platform-Pass-2' });
    expect((await list('', pa.token)).status).toBe(200);
  });

  test('deactivated Platform Admin with a still-valid token → 401', async () => {
    const pa = await createAndLogin(ctx, rootToken, { role: 'platform_admin', fullName: 'Gone PA', email: 'gone.pa@evolviq.test', password: 'Platform-Pass-3' });
    expect((await list('', pa.token)).status).toBe(200);
    await ctx.pg.query('UPDATE users SET is_active = false WHERE id = $1', [pa.id]);
    expect((await list('', pa.token)).status).toBe(401);
    expect((await create({ name: 'Should Not Exist' }, pa.token)).status).toBe(401);
    expect((await ctx.pg.query(`SELECT 1 FROM schools WHERE name = 'Should Not Exist'`)).rowCount).toBe(0);
  });

  test('demoted user (token still says platform_admin) → 401', async () => {
    const pa = await createAndLogin(ctx, rootToken, { role: 'platform_admin', fullName: 'Demoted', email: 'demoted@evolviq.test', password: 'Platform-Pass-4' });
    await ctx.pg.query(`UPDATE users SET role = 'psychologist' WHERE id = $1`, [pa.id]);
    expect((await list('', pa.token)).status).toBe(401);
  });
});

// ─────────────────────────────── CREATE ───────────────────────────────
describe('POST /api/v1/schools', () => {
  test('201 with the created school, Location header, and the row persisted', async () => {
    const r = await create({ name: 'Sunrise Public School' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(['school']);
    expect(Object.keys(r.body.school).sort()).toEqual(SCHOOL_KEYS);
    expect(r.body.school.name).toBe('Sunrise Public School');
    expect(r.body.school.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(r.body.school.createdAt).toISOString()).toBe(r.body.school.createdAt);
    expect(r.headers.location).toBe(`${BASE}/${r.body.school.id}`);
    expect(await dbName(r.body.school.id)).toBe('Sunrise Public School');
  });

  test('name is stored trimmed; 200 characters is the maximum', async () => {
    const r = await create({ name: '   Kongu Vellalar Matric  ' });
    expect(r.body.school.name).toBe('Kongu Vellalar Matric');
    expect((await create({ name: 'L'.repeat(200) })).status).toBe(201);
  });

  test.each([
    ['missing name', {}, 'name'],
    ['empty name', { name: '' }, 'name'],
    ['blank name', { name: '    ' }, 'name'],
    ['201 characters', { name: 'x'.repeat(201) }, 'name'],
    ['control characters', { name: 'Bad\u0000School' }, 'name'],
    ['number', { name: 12345 }, 'name'],
    ['null', { name: null }, 'name'],
    ['unknown field', { name: 'OK School', id: UNKNOWN_ID }, 'id'],
  ])('%s → 400 VALIDATION_ERROR (field %s)', async (_label, body, field) => {
    const before = await schoolCount();
    const r = await create(body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(await schoolCount()).toBe(before);
  });

  test('non-object JSON body → 400; malformed JSON → 400; non-JSON → 415', async () => {
    expect((await create(['Sunrise'])).status).toBe(400);
    const auth = { authorization: `Bearer ${rootToken}` };
    const bad = await request(ctx.baseUrl).post(BASE).set(auth).set('content-type', 'application/json').send('{"name":');
    expect(bad.status).toBe(400);
    const form = await request(ctx.baseUrl).post(BASE).set(auth).type('form').send('name=x');
    expect(form.status).toBe(415);
  });
});

// ─────────────────────────────── VIEW ───────────────────────────────
describe('GET /api/v1/schools/:id', () => {
  test('200 with the school', async () => {
    const r = await view(SCHOOL_A);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.school).sort()).toEqual(SCHOOL_KEYS);
    expect(r.body.school).toMatchObject({ id: SCHOOL_A, name: 'Demo School A' });
  });

  test('unknown id → 404 NOT_FOUND', async () => {
    const r = await view(UNKNOWN_ID);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'School not found.' } });
  });

  test.each(['not-a-uuid', '123', "1' OR '1'='1"])('invalid schoolId %j → 400 VALIDATION_ERROR (field schoolId)', async (id) => {
    const r = await view(encodeURIComponent(id));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details[0].field).toBe('schoolId');
  });
});

// ─────────────────────────────── RENAME ───────────────────────────────
describe('PATCH /api/v1/schools/:id', () => {
  test('200: renames, trims, bumps updatedAt, keeps createdAt; GET and the DB agree', async () => {
    const created = (await create({ name: 'Old Name School' })).body.school;
    await new Promise((r) => setTimeout(r, 15));
    const r = await rename(created.id, { name: '  New Name School ' });
    expect(r.status).toBe(200);
    expect(r.body.school).toMatchObject({ id: created.id, name: 'New Name School', createdAt: created.createdAt });
    expect(Date.parse(r.body.school.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect((await view(created.id)).body.school.name).toBe('New Name School');
    expect(await dbName(created.id)).toBe('New Name School');
  });

  test('renaming to the same name is allowed', async () => {
    expect((await rename(SCHOOL_B, { name: 'Demo School B' })).status).toBe(200);
  });

  test('unknown id → 404 NOT_FOUND and nothing is created', async () => {
    const before = await schoolCount();
    const r = await rename(UNKNOWN_ID, { name: 'Ghost School' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'School not found.' } });
    expect(await schoolCount()).toBe(before);
  });

  test('invalid id → 400', async () => {
    expect((await rename('nope', { name: 'X School' })).status).toBe(400);
  });

  test.each([
    ['missing name', {}],
    ['blank name', { name: ' ' }],
    ['too long', { name: 'y'.repeat(201) }],
    ['extra field', { name: 'Fine', createdAt: '2020-01-01T00:00:00.000Z' }],
    ['wrong type', { name: ['A'] }],
  ])('%s → 400 VALIDATION_ERROR and the name is unchanged', async (_label, body) => {
    const r = await rename(SCHOOL_A, body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(await dbName(SCHOOL_A)).toBe('Demo School A');
  });
});

// ─────────────────────────────── LIST ───────────────────────────────
describe('GET /api/v1/schools — pagination, sorting, filtering', () => {
  const PAG = 'Pagetest';
  const names = Array.from({ length: 12 }, (_, i) => `${PAG} ${String(i + 1).padStart(2, '0')}`);

  beforeAll(async () => {
    // Insert in shuffled order so "sorted" results can't come from insertion order.
    for (const name of [...names].sort(() => Math.random() - 0.5)) {
      expect((await create({ name })).status).toBe(201);
    }
    await create({ name: '100% Vidya School' });
    await create({ name: 'A_B Academy' });
    await create({ name: 'AxB Academy' });
  });

  test('defaults: page 1, limit 20, sorted by name asc (+ id), full metadata', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['pagination', 'schools']);
    const total = await schoolCount();
    expect(r.body.pagination).toEqual({
      page: 1, limit: 20, total, totalPages: Math.ceil(total / 20),
      hasNextPage: total > 20, hasPreviousPage: false,
    });
    const expected = (await ctx.pg.query('SELECT id FROM schools ORDER BY name ASC, id ASC LIMIT 20')).rows.map((x) => x.id);
    expect(r.body.schools.map((s: { id: string }) => s.id)).toEqual(expected);
    for (const s of r.body.schools) expect(Object.keys(s).sort()).toEqual(SCHOOL_KEYS);
  });

  test('pagination: pages are disjoint, ordered, and add up to the filtered total', async () => {
    const pages = [];
    for (const page of [1, 2, 3]) {
      const r = await list(`?name=${PAG}&limit=5&page=${page}`);
      expect(r.status).toBe(200);
      pages.push(r.body);
    }
    expect(pages.map((p) => p.schools.length)).toEqual([5, 5, 2]);
    expect(pages[0].pagination).toEqual({ page: 1, limit: 5, total: 12, totalPages: 3, hasNextPage: true, hasPreviousPage: false });
    expect(pages[1].pagination).toMatchObject({ page: 2, hasNextPage: true, hasPreviousPage: true });
    expect(pages[2].pagination).toMatchObject({ page: 3, hasNextPage: false, hasPreviousPage: true });
    expect(pages.flatMap((p) => p.schools.map((s: { name: string }) => s.name))).toEqual(names);
  });

  test('a page past the end is empty but keeps consistent metadata', async () => {
    const r = await list(`?name=${PAG}&limit=5&page=4`);
    expect(r.status).toBe(200);
    expect(r.body.schools).toEqual([]);
    expect(r.body.pagination).toEqual({ page: 4, limit: 5, total: 12, totalPages: 3, hasNextPage: false, hasPreviousPage: true });
  });

  test('limit=100 is the maximum', async () => {
    expect((await list('?limit=100')).status).toBe(200);
    expect((await list('?limit=101')).status).toBe(400);
  });

  test('sorting by name desc', async () => {
    const r = await list(`?name=${PAG}&sortBy=name&sortOrder=desc&limit=100`);
    expect(r.body.schools.map((s: { name: string }) => s.name)).toEqual([...names].reverse());
  });

  test('sorting by createdAt / updatedAt (asc and desc) matches the database order', async () => {
    for (const [field, column] of [['createdAt', 'created_at'], ['updatedAt', 'updated_at']] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const r = await list(`?sortBy=${field}&sortOrder=${order}&limit=100`);
        expect(r.status).toBe(200);
        const expected = (await ctx.pg.query(
          `SELECT id FROM schools ORDER BY ${column} ${order}, id ASC LIMIT 100`)).rows.map((x) => x.id);
        expect(r.body.schools.map((s: { id: string }) => s.id), `${field} ${order}`).toEqual(expected);
      }
    }
  });

  test.each(['password', 'secret_hash', 'id', 'created_at', '__proto__', 'name;DROP TABLE schools'])(
    'sortBy=%j is not allowlisted → 400 (field sortBy)',
    async (sortBy) => {
      const r = await list(`?sortBy=${encodeURIComponent(sortBy)}`);
      expect(r.status).toBe(400);
      expect(r.body.error.details[0].field).toBe('sortBy');
    },
  );

  test('invalid sortOrder → 400', async () => {
    const r = await list('?sortOrder=sideways');
    expect(r.status).toBe(400);
    expect(r.body.error.details[0].field).toBe('sortOrder');
  });

  test.each(['page=0', 'page=-1', 'page=abc', 'page=1.5', 'limit=0', 'limit=1e2', 'page=1&page=2'])(
    'invalid pagination %j → 400',
    async (qs) => {
      const r = await list(`?${qs}`);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  test('unknown query parameter → 400 (no silent typos)', async () => {
    const r = await list('?sort=name');
    expect(r.status).toBe(400);
    expect(r.body.error.details[0].field).toBe('sort');
  });

  test('name filter: case-insensitive substring, total reflects the filter', async () => {
    const r = await list('?name=pAgEtEsT 1');
    expect(r.status).toBe(200);
    expect(r.body.schools.map((s: { name: string }) => s.name)).toEqual([`${PAG} 10`, `${PAG} 11`, `${PAG} 12`]);
    expect(r.body.pagination.total).toBe(3);
  });

  test('name filter with no match → empty list, total 0, totalPages 0', async () => {
    const r = await list('?name=zzz-no-such-school');
    expect(r.body).toEqual({
      schools: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
    });
  });

  test('LIKE wildcards in the filter match literally (% and _)', async () => {
    const pct = await list(`?name=${encodeURIComponent('%')}`);
    expect(pct.body.schools.map((s: { name: string }) => s.name)).toEqual(['100% Vidya School']);
    const underscore = await list('?name=A_B');
    expect(underscore.body.schools.map((s: { name: string }) => s.name)).toEqual(['A_B Academy']);
  });

  test('blank name filter = no filter', async () => {
    const r = await list('?name=%20%20');
    expect(r.body.pagination.total).toBe(await schoolCount());
  });

  test('filter + sort + pagination combine', async () => {
    const r = await list(`?name=${PAG}&sortBy=name&sortOrder=desc&limit=4&page=2`);
    expect(r.body.schools.map((s: { name: string }) => s.name)).toEqual([...names].reverse().slice(4, 8));
    expect(r.body.pagination).toMatchObject({ total: 12, totalPages: 3, page: 2 });
  });
});

// ─────────────────────────────── DATABASE ERRORS ───────────────────────────────
describe('database errors', () => {
  test('a failing query → 500 INTERNAL_ERROR with no internals leaked', async () => {
    // Break the schools table out from under the running app, then restore it.
    await ctx.pg.query('ALTER TABLE schools RENAME TO schools_offline');
    try {
      for (const r of [await list(), await view(SCHOOL_A), await create({ name: 'Down School' }), await rename(SCHOOL_A, { name: 'X' })]) {
        expect(r.status).toBe(500);
        expect(r.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
      }
    } finally {
      await ctx.pg.query('ALTER TABLE schools_offline RENAME TO schools');
    }
    expect((await list()).status).toBe(200);
  });
});
