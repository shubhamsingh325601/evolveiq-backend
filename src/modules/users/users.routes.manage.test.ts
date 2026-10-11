// User management — edit, deactivate and reactivate (Platform Admin: anyone; School Admin:
// students, teachers and parents of their own school; nobody: themselves).
// Covers the editable fields per role, immutable role/school, normalisation, duplicates,
// school scoping and what deactivation / reactivation do to logins and sessions.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const BASE = '/api/v1/users';
const PW = 'Manage-Password-1';

let ctx: TestContext;
let rootToken: string;
let rootId: string;
type Account = { id: string; token: string; refreshToken: string };
const u: Record<string, Account> = {};

let seq = 0;
const next = () => (seq += 1);
const adult = (role: string, schoolId?: string) => {
  const n = next();
  const email = `m${n}@manage.test`;
  return createAndLogin(ctx, rootToken, { role, fullName: `Adult ${n}`, email, password: PW, ...(schoolId && { schoolId }) })
    .then((a) => ({ ...a, email }));
};
const student = (schoolId = SCHOOL_A) => {
  const n = next();
  const studentId = `MG-${n}`;
  return createAndLogin(ctx, rootToken, { role: 'student', fullName: `Student ${n}`, studentId, pin: '482913', schoolId })
    .then((a) => ({ ...a, studentId }));
};

beforeAll(async () => {
  ctx = await createTestContext();
  const login = await ctx.login(ADMIN);
  rootToken = login.body.accessToken;
  rootId = login.body.user.id;
  u.saA = await adult('school_admin', SCHOOL_A);
  u.saA2 = await adult('school_admin', SCHOOL_A);
  u.saB = await adult('school_admin', SCHOOL_B);
  u.teacherA = await adult('teacher', SCHOOL_A);
  u.parentA = await adult('parent', SCHOOL_A);
  u.studentA = await student(SCHOOL_A);
  u.psych = await adult('psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const edit = (id: string, body: unknown, token: string = rootToken) => ctx.patch(`${BASE}/${id}`, body, token);
const deactivate = (id: string, token: string = rootToken) => ctx.post(`${BASE}/${id}/deactivate`, undefined, token);
const reactivate = (id: string, token: string = rootToken) => ctx.post(`${BASE}/${id}/reactivate`, undefined, token);
const row = async (id: string) =>
  (await ctx.pg.query('SELECT role, school_id, full_name, email, student_login_id, is_active FROM users WHERE id = $1', [id])).rows[0];
const liveTokens = async (id: string) =>
  (await ctx.pg.query('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [id])).rows[0].n as number;

// ─────────────────────────────── RBAC ───────────────────────────────
describe('RBAC — shared guard', () => {
  test('no token → 401 on edit / reactivate', async () => {
    expect((await ctx.patch(`${BASE}/${u.teacherA!.id}`, { fullName: 'X' })).status).toBe(401);
    expect((await ctx.post(`${BASE}/${u.teacherA!.id}/reactivate`, undefined)).status).toBe(401);
  });

  test.each(['teacherA', 'parentA', 'studentA', 'psych'])('%s → 403 on edit, deactivate and reactivate; nothing changes', async (who) => {
    const target = u.studentA!.id === u[who]!.id ? u.teacherA!.id : u.studentA!.id;
    const before = await row(target);
    expect((await edit(target, { fullName: 'Hijacked' }, u[who]!.token)).status).toBe(403);
    expect((await deactivate(target, u[who]!.token)).status).toBe(403);
    expect((await reactivate(target, u[who]!.token)).status).toBe(403);
    expect(await row(target)).toEqual(before);
  });
});

// ─────────────────────────────── Edit ───────────────────────────────
describe('PATCH /users/:userId — edit', () => {
  test('adult: fullName + email, stored normalised; the new email logs in, the old one no longer does', async () => {
    const t = await adult('teacher', SCHOOL_A);
    const r = await edit(t.id, { fullName: '  Renamed Teacher ', email: 'Renamed.Teacher@Manage.TEST' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: t.id, fullName: 'Renamed Teacher', email: 'renamed.teacher@manage.test', role: 'teacher', schoolId: SCHOOL_A });
    expect((await ctx.login({ email: 'renamed.teacher@manage.test', password: PW })).status).toBe(200);
    expect((await ctx.login({ email: t.email, password: PW })).status).toBe(401);
  });

  test('student: fullName + studentId (upper-cased); the new student ID logs in', async () => {
    const s = await student();
    const r = await edit(s.id, { fullName: 'Renamed Kid', studentId: 'new-kid-1' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ fullName: 'Renamed Kid', studentId: 'NEW-KID-1', email: null });
    expect((await ctx.login({ studentId: 'NEW-KID-1', pin: '482913' })).status).toBe(200);
    expect((await ctx.login({ studentId: s.studentId, pin: '482913' })).status).toBe(401);
  });

  test('a single field can be changed on its own', async () => {
    const p = await adult('parent', SCHOOL_B);
    const r = await edit(p.id, { fullName: 'Only Name' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ fullName: 'Only Name', email: p.email });
  });

  test('a student cannot get an email, an adult cannot get a student ID → 400, nothing changes', async () => {
    const s = await student();
    const t = await adult('teacher', SCHOOL_A);
    const before = [await row(s.id), await row(t.id)];
    const r1 = await edit(s.id, { email: 'kid@manage.test' });
    expect(r1.status).toBe(400);
    expect(r1.body.error.details).toEqual([{ field: 'email', message: 'is not allowed for students' }]);
    const r2 = await edit(t.id, { studentId: 'T-1000' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.details).toEqual([{ field: 'studentId', message: 'is allowed for students only' }]);
    expect([await row(s.id), await row(t.id)]).toEqual(before);
  });

  test.each([
    ['role', { role: 'school_admin' }],
    ['schoolId', { schoolId: SCHOOL_B }],
    ['parentId', { parentId: SCHOOL_A }],
    ['isActive', { isActive: false }],
    ['password', { password: 'Another-Password-1' }],
    ['pin', { pin: '111111' }],
  ])('immutable / non-editable field %s → 400 "is not allowed", nothing changes', async (field, body) => {
    const t = await adult('teacher', SCHOOL_A);
    const before = await row(t.id);
    const r = await edit(t.id, { fullName: 'Sneaky', ...body });
    expect(r.status).toBe(400);
    expect(r.body.error.details).toContainEqual({ field, message: 'is not allowed' });
    expect(await row(t.id)).toEqual(before);
  });

  test.each([
    ['empty body', {}],
    ['blank name', { fullName: '   ' }],
    ['bad email', { email: 'not-an-email' }],
    ['bad studentId', { studentId: 'a b' }],
    ['name too long', { fullName: 'x'.repeat(101) }],
  ])('%s → 400 VALIDATION_ERROR', async (_label, body) => {
    const r = await edit(u.teacherA!.id, body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a taken email or student ID (any case) → 409 DUPLICATE_ACCOUNT naming the field', async () => {
    const t = await adult('teacher', SCHOOL_A);
    const r1 = await edit(t.id, { email: (await row(u.parentA!.id)).email.toUpperCase() });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatchObject({ code: 'DUPLICATE_ACCOUNT', details: { field: 'email' } });
    const s = await student();
    const r2 = await edit(s.id, { studentId: (await row(u.studentA!.id)).student_login_id.toLowerCase() });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toMatchObject({ code: 'DUPLICATE_ACCOUNT', details: { field: 'studentId' } });
  });

  test('School Admin edits students / teachers / parents of their own school', async () => {
    for (const target of [await student(), await adult('teacher', SCHOOL_A), await adult('parent', SCHOOL_A)]) {
      const r = await edit(target.id, { fullName: 'Edited By SA' }, u.saA!.token);
      expect(r.status).toBe(200);
      expect(r.body.user.fullName).toBe('Edited By SA');
    }
  });

  test('School Admin: anyone outside their reach → 404, nothing changes', async () => {
    const otherSchool = await student(SCHOOL_B);
    for (const id of [otherSchool.id, u.saA2!.id, u.saB!.id, u.psych!.id, rootId]) {
      const before = await row(id);
      expect((await edit(id, { fullName: 'Hijacked' }, u.saA!.token)).status).toBe(404);
      expect(await row(id)).toEqual(before);
    }
  });

  test('unknown id → 404; malformed id → 400', async () => {
    expect((await edit('99999999-9999-4999-8999-999999999999', { fullName: 'X' })).status).toBe(404);
    expect((await edit('nope', { fullName: 'X' })).status).toBe(400);
  });
});

// ─────────────────────────────── Deactivate (School Admin) ───────────────────────────────
describe('POST /users/:userId/deactivate — School Admin scope', () => {
  test('School Admin deactivates a student of their school: refresh tokens revoked, login 403, access token 401', async () => {
    const s = await student();
    const r = await deactivate(s.id, u.saA!.token);
    expect(r.status).toBe(200);
    expect(r.body.user.isActive).toBe(false);
    expect(await liveTokens(s.id)).toBe(0);
    expect((await ctx.login({ studentId: s.studentId, pin: '482913' })).body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await ctx.post('/api/v1/auth/logout', { refreshToken: s.refreshToken }, s.token)).status).toBe(401);
  });

  test('School Admin deactivates teachers and parents of their school', async () => {
    for (const target of [await adult('teacher', SCHOOL_A), await adult('parent', SCHOOL_A)]) {
      expect((await deactivate(target.id, u.saA!.token)).status).toBe(200);
      expect((await row(target.id)).is_active).toBe(false);
    }
  });

  test('nobody can deactivate themselves → 403', async () => {
    for (const [id, token] of [[u.saA!.id, u.saA!.token], [rootId, rootToken]] as const) {
      const r = await deactivate(id, token);
      expect(r.status).toBe(403);
      expect(r.body.error.message).toBe('You cannot deactivate your own account.');
      expect((await row(id)).is_active).toBe(true);
    }
  });
});

// ─────────────────────────────── Reactivate ───────────────────────────────
describe('POST /users/:userId/reactivate', () => {
  test('restores login; sessions revoked at deactivation stay revoked', async () => {
    const t = await adult('teacher', SCHOOL_A);
    expect((await deactivate(t.id)).status).toBe(200);
    const r = await reactivate(t.id);
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ id: t.id, isActive: true });
    expect((await ctx.post('/api/v1/auth/refresh', { refreshToken: t.refreshToken })).status).toBe(401);
    const login = await ctx.login({ email: t.email, password: PW });
    expect(login.status).toBe(200);
    expect((await ctx.get(`${BASE}/${t.id}`, rootToken)).body.user.isActive).toBe(true);
  });

  test('the token issued before deactivation does not come back to life', async () => {
    const t = await adult('school_admin', SCHOOL_B);
    expect((await deactivate(t.id)).status).toBe(200);
    expect((await reactivate(t.id)).status).toBe(200);
    // Access tokens are re-checked against the live row: the old one is valid again only
    // because the account is active again — it was never revoked, just refused while inactive.
    expect((await ctx.get(BASE, t.token)).status).toBe(200);
    expect(await liveTokens(t.id)).toBe(0);
  });

  test('School Admin reactivates within their reach; outside it → 404', async () => {
    const s = await student();
    await deactivate(s.id);
    expect((await reactivate(s.id, u.saA!.token)).status).toBe(200);
    expect((await ctx.login({ studentId: s.studentId, pin: '482913' })).status).toBe(200);

    const other = await student(SCHOOL_B);
    await deactivate(other.id);
    expect((await reactivate(other.id, u.saA!.token)).status).toBe(404);
    expect((await row(other.id)).is_active).toBe(false);
    const otherAdmin = await adult('school_admin', SCHOOL_A);
    await deactivate(otherAdmin.id);
    expect((await reactivate(otherAdmin.id, u.saA!.token)).status).toBe(404);
    expect((await row(otherAdmin.id)).is_active).toBe(false);
  });

  test('is idempotent: reactivating an active user → 200', async () => {
    const r = await reactivate(u.teacherA!.id);
    expect(r.status).toBe(200);
    expect(r.body.user.isActive).toBe(true);
  });

  test('nobody can reactivate themselves → 403', async () => {
    expect((await reactivate(u.saA!.id, u.saA!.token)).status).toBe(403);
    expect((await reactivate(rootId)).status).toBe(403);
  });

  test('unknown id → 404; malformed id → 400', async () => {
    expect((await reactivate('99999999-9999-4999-8999-999999999999')).status).toBe(404);
    expect((await reactivate('nope')).status).toBe(400);
  });
});
