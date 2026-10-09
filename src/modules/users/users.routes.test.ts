// User-management API integration tests — Supertest over HTTP against the real app + PostgreSQL.
// Covers RBAC (shared guard), School Admin school scoping (no cross-school or out-of-role
// access, including by guessing IDs), list pagination/sorting/filtering, the response shape
// (no secrets) and deactivation (login, access tokens and refresh tokens all stop working).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const BASE = '/api/v1/users';
const USER_KEYS = ['createdAt', 'email', 'fullName', 'id', 'isActive', 'parentId', 'role', 'schoolId', 'studentId'];
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const PW = 'Users-Password-1';

let ctx: TestContext;
let rootToken: string;
let rootId: string;
type Account = { id: string; token: string; refreshToken: string };
const u: Record<string, Account> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  const login = await ctx.login(ADMIN);
  rootToken = login.body.accessToken;
  rootId = login.body.user.id;
  const adult = (role: string, key: string, schoolId?: string, fullName = key) =>
    createAndLogin(ctx, rootToken, { role, fullName, email: `${key.toLowerCase()}@users.test`, password: PW, ...(schoolId && { schoolId }) });

  u.saA = await adult('school_admin', 'SA-A', SCHOOL_A, 'Asha Admin');
  u.saA2 = await adult('school_admin', 'SA-A2', SCHOOL_A, 'Second Admin');
  u.teacherA = await adult('teacher', 'T-A', SCHOOL_A, 'Tara Teacher');
  u.parentA = await adult('parent', 'P-A', SCHOOL_A, 'Pooja Parent');
  u.studentA = await createAndLogin(ctx, rootToken, { role: 'student', fullName: 'Sam 100% Student', studentId: 'USR-A1', pin: '482913', schoolId: SCHOOL_A, parentId: u.parentA.id });
  u.saB = await adult('school_admin', 'SA-B', SCHOOL_B, 'Bala Admin');
  u.teacherB = await adult('teacher', 'T-B', SCHOOL_B, 'Bhavna Teacher');
  u.studentB = await createAndLogin(ctx, rootToken, { role: 'student', fullName: 'Bobby Student', studentId: 'USR-B1', pin: '135792', schoolId: SCHOOL_B });
  u.psych = await adult('psychologist', 'PS', undefined, 'Priya Psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const list = (qs = '', token: string = rootToken) => ctx.get(`${BASE}${qs}`, token);
const view = (id: string, token: string = rootToken) => ctx.get(`${BASE}/${id}`, token);
const deactivate = (id: string, token: string = rootToken) => ctx.post(`${BASE}/${id}/deactivate`, undefined, token);
const isActive = async (id: string) => (await ctx.pg.query('SELECT is_active FROM users WHERE id = $1', [id])).rows[0].is_active as boolean;
const dbIds = async (sql: string, params: unknown[] = []) =>
  ((await ctx.pg.query(`SELECT id FROM users ${sql} ORDER BY id`, params)).rows as { id: string }[]).map((r) => r.id);
const ids = (r: { body: { users: { id: string }[] } }) => r.body.users.map((x) => x.id).sort();

// Fresh throwaway accounts for tests that deactivate.
let seq = 0;
const freshTeacher = (schoolId = SCHOOL_A) => {
  seq += 1;
  return createAndLogin(ctx, rootToken, { role: 'teacher', fullName: `Fresh ${seq}`, email: `fresh${seq}@users.test`, password: PW, schoolId });
};

// ─────────────────────────────── RBAC ───────────────────────────────
describe('RBAC — shared guard', () => {
  const calls = () => [
    ['GET', BASE],
    ['GET', `${BASE}/${u.studentA!.id}`],
    ['POST', `${BASE}/${u.teacherA!.id}/deactivate`],
  ] as const;

  test('no / garbage token → 401 on every endpoint', async () => {
    for (const token of [undefined, 'garbage']) {
      for (const [method, url] of calls()) {
        const r = await ctx.send(method, url, { token });
        expect(r.status, `${method} ${url}`).toBe(401);
        expect(r.body.error.code).toBe('UNAUTHENTICATED');
      }
    }
  });

  test.each(['teacherA', 'parentA', 'studentA', 'psych'])('%s → 403 on every endpoint, nobody is deactivated', async (who) => {
    for (const [method, url] of calls()) {
      const r = await ctx.send(method, url, { token: u[who]!.token });
      expect(r.status, `${who} ${method} ${url}`).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
    expect(await isActive(u.teacherA!.id)).toBe(true);
  });

  test('School Admin cannot deactivate anyone outside their school or roles → 404, nothing changes', async () => {
    for (const who of ['teacherB', 'studentB', 'saB', 'saA2', 'psych']) {
      const r = await deactivate(u[who]!.id, u.saA!.token);
      expect(r.status, who).toBe(404);
      expect(await isActive(u[who]!.id), who).toBe(true);
    }
    expect((await deactivate(rootId, u.saA!.token)).status).toBe(404);
    expect(await isActive(rootId)).toBe(true);
  });
});

// ─────────────────────────────── Response shape ───────────────────────────────
describe('response shape', () => {
  test('exactly the documented fields — never secrets or lockout state', async () => {
    const r = await list('?limit=100');
    expect(r.status).toBe(200);
    for (const user of r.body.users) {
      expect(Object.keys(user).sort()).toEqual(USER_KEYS);
    }
    const raw = JSON.stringify(r.body);
    for (const leaked of ['secret', 'Hash', 'argon2', 'failed', 'locked']) expect(raw).not.toContain(leaked);
  });

  test('a student has studentId + parentId and no email; an adult has email and no studentId', async () => {
    const student = (await view(u.studentA!.id)).body.user;
    expect(student).toMatchObject({ role: 'student', studentId: 'USR-A1', email: null, parentId: u.parentA!.id, schoolId: SCHOOL_A, isActive: true });
    expect(new Date(student.createdAt).toISOString()).toBe(student.createdAt);
    const psych = (await view(u.psych!.id)).body.user;
    expect(psych).toMatchObject({ role: 'psychologist', email: 'ps@users.test', studentId: null, schoolId: null, parentId: null });
  });
});

// ─────────────────────────────── Platform Admin list ───────────────────────────────
describe('GET /users — Platform Admin', () => {
  test('sees every user in every school, with correct pagination metadata', async () => {
    const r = await list('?limit=100');
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(await dbIds(''));
    expect(r.body.pagination).toMatchObject({ page: 1, limit: 100, total: r.body.users.length, hasNextPage: false, hasPreviousPage: false });
  });

  test('filters by role, school, active flag and name', async () => {
    expect(ids(await list('?role=teacher&limit=100'))).toEqual(await dbIds(`WHERE role = 'teacher'`));
    expect(ids(await list(`?schoolId=${SCHOOL_B}&limit=100`))).toEqual(await dbIds('WHERE school_id = $1', [SCHOOL_B]));
    expect(ids(await list(`?role=student&schoolId=${SCHOOL_A}`))).toEqual([u.studentA!.id]);
    expect(ids(await list('?name=PRIYA'))).toEqual([u.psych!.id]);
    expect(ids(await list('?name=100%25'))).toEqual([u.studentA!.id]); // literal %, not a wildcard
    expect(ids(await list('?name=%25%25%25'))).toEqual([]);
    expect(ids(await list('?isActive=false&limit=100'))).toEqual(await dbIds('WHERE NOT is_active'));
    expect(ids(await list('?isActive=true&limit=100'))).toEqual(await dbIds('WHERE is_active'));
  });

  test('sorts by fullName / createdAt in either direction (DB order, id tie-break)', async () => {
    for (const [sortBy, column] of [['fullName', 'full_name'], ['createdAt', 'created_at']] as const) {
      for (const order of ['asc', 'desc'] as const) {
        const r = await list(`?sortBy=${sortBy}&sortOrder=${order}&limit=100`);
        const expected = (await ctx.pg.query(`SELECT id FROM users ORDER BY ${column} ${order}, id ASC`)).rows.map((x: { id: string }) => x.id);
        expect(r.body.users.map((x: { id: string }) => x.id), `${sortBy} ${order}`).toEqual(expected);
      }
    }
  });

  test('pages are disjoint and add up to the total', async () => {
    const total = (await list('?limit=1')).body.pagination.total as number;
    const seen = new Set<string>();
    for (let page = 1; page <= Math.ceil(total / 3); page += 1) {
      const r = await list(`?limit=3&page=${page}`);
      for (const x of r.body.users) seen.add(x.id);
    }
    expect(seen.size).toBe(total);
    const past = await list(`?limit=3&page=${Math.ceil(total / 3) + 1}`);
    expect(past.body.users).toEqual([]);
    expect(past.body.pagination).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  test.each([
    ['?sortBy=secretHash'],
    ['?sortBy=email'],
    ['?sortOrder=up'],
    ['?role=admin'],
    ['?isActive=yes'],
    ['?schoolId=not-a-uuid'],
    ['?limit=101'],
    ['?page=0'],
    ['?unknown=1'],
  ])('invalid query %s → 400 VALIDATION_ERROR', async (qs) => {
    const r = await list(qs);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────── School Admin scoping ───────────────────────────────
describe('GET /users — School Admin is confined to their own school', () => {
  test('sees only students, teachers and parents of their own school', async () => {
    const r = await list('?limit=100', u.saA!.token);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(await dbIds(`WHERE school_id = $1 AND role IN ('student', 'teacher', 'parent')`, [SCHOOL_A]));
    const seen = ids(r);
    for (const outside of ['saA', 'saA2', 'saB', 'teacherB', 'studentB', 'psych']) expect(seen).not.toContain(u[outside]!.id);
    expect(seen).not.toContain(rootId);
  });

  test('may filter by a role they manage and by their own school', async () => {
    expect(ids(await list('?role=parent', u.saA!.token))).toEqual([u.parentA!.id]);
    expect(ids(await list(`?schoolId=${SCHOOL_A}&role=student`, u.saA!.token))).toEqual([u.studentA!.id]);
  });

  test('another school → 403', async () => {
    const r = await list(`?schoolId=${SCHOOL_B}`, u.saA!.token);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('School Admins can only list users in their own school.');
  });

  test.each(['school_admin', 'psychologist', 'platform_admin'])('a role they do not manage (%s) → 403', async (role) => {
    const r = await list(`?role=${role}`, u.saA!.token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });
});

// ─────────────────────────────── View ───────────────────────────────
describe('GET /users/:userId', () => {
  test('Platform Admin can view anyone, in any school', async () => {
    for (const who of ['studentB', 'saA', 'psych']) {
      const r = await view(u[who]!.id);
      expect(r.status, who).toBe(200);
      expect(r.body.user.id).toBe(u[who]!.id);
    }
  });

  test('School Admin can view students, teachers and parents of their school', async () => {
    for (const who of ['studentA', 'teacherA', 'parentA']) {
      expect((await view(u[who]!.id, u.saA!.token)).status, who).toBe(200);
    }
  });

  test('School Admin gets 404 (not 403) for anyone outside their reach — IDs cannot be probed', async () => {
    for (const who of ['studentB', 'teacherB', 'saB', 'saA2', 'saA', 'psych']) {
      const r = await view(u[who]!.id, u.saA!.token);
      expect(r.status, who).toBe(404);
      expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    }
    expect((await view(rootId, u.saA!.token)).status).toBe(404);
  });

  test('unknown id → 404; malformed id → 400', async () => {
    expect((await view(UNKNOWN_ID)).status).toBe(404);
    const r = await view('not-a-uuid');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────── Deactivate ───────────────────────────────
describe('POST /users/:userId/deactivate', () => {
  test('deactivates: login → 403 ACCOUNT_DISABLED, access token → 401, refresh tokens revoked', async () => {
    const t = await freshTeacher();
    const email = `fresh${seq}@users.test`;
    const r = await deactivate(t.id);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: t.id, isActive: false });
    expect(await isActive(t.id)).toBe(false);

    const live = (await ctx.pg.query('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [t.id])).rows[0].n;
    expect(live).toBe(0);
    expect((await ctx.post('/api/v1/auth/refresh', { refreshToken: t.refreshToken })).status).toBe(401);
    expect((await ctx.post('/api/v1/auth/logout', { refreshToken: t.refreshToken }, t.token)).status).toBe(401);

    const login = await ctx.login({ email, password: PW });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  test("a deactivated School Admin's token stops working immediately", async () => {
    const sa = await createAndLogin(ctx, rootToken, { role: 'school_admin', fullName: 'Leaving Admin', email: 'leaving@users.test', password: PW, schoolId: SCHOOL_B });
    expect((await list('', sa.token)).status).toBe(200);
    expect((await deactivate(sa.id)).status).toBe(200);
    expect((await list('', sa.token)).status).toBe(401);
  });

  test("other users' sessions are untouched", async () => {
    const a = await freshTeacher();
    const b = await freshTeacher();
    expect((await deactivate(a.id)).status).toBe(200);
    expect((await ctx.post('/api/v1/auth/refresh', { refreshToken: b.refreshToken })).status).toBe(200);
    expect(await isActive(b.id)).toBe(true);
  });

  test('is idempotent: deactivating an inactive user → 200, still inactive', async () => {
    const t = await freshTeacher(SCHOOL_B);
    expect((await deactivate(t.id)).status).toBe(200);
    const again = await deactivate(t.id);
    expect(again.status).toBe(200);
    expect(again.body.user.isActive).toBe(false);
  });

  test('works for every role, including another Platform Admin', async () => {
    const pa = await createAndLogin(ctx, rootToken, { role: 'platform_admin', fullName: 'Other PA', email: 'other.pa@users.test', password: PW });
    const r = await deactivate(pa.id);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ role: 'platform_admin', isActive: false });
  });

  test('a Platform Admin cannot deactivate themselves → 403', async () => {
    const r = await deactivate(rootId);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('You cannot deactivate your own account.');
    expect(await isActive(rootId)).toBe(true);
  });

  test('deactivated users show up under isActive=false', async () => {
    const t = await freshTeacher();
    await deactivate(t.id);
    expect(ids(await list('?isActive=false&limit=100'))).toContain(t.id);
    expect(ids(await list('?isActive=true&limit=100'))).not.toContain(t.id);
  });

  test('unknown id → 404; malformed id → 400', async () => {
    expect((await deactivate(UNKNOWN_ID)).status).toBe(404);
    expect((await deactivate('not-a-uuid')).status).toBe(400);
  });
});
