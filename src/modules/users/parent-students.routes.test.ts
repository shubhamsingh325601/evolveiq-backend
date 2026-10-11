// Parent ↔ student links — Supertest over HTTP against the real app + PostgreSQL.
// One parent per student, many children per parent, same school only, School Admin confined
// to their own school, parents see only their own children; register's parentId still works.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const BASE = '/api/v1/parent-students';
const PW = 'Links-Password-1';

let ctx: TestContext;
let rootToken: string;
type Account = { id: string; token: string; refreshToken: string };
const u: Record<string, Account> = {};

let seq = 0;
const next = () => (seq += 1);
const parent = (schoolId = SCHOOL_A) =>
  createAndLogin(ctx, rootToken, { role: 'parent', fullName: `Parent ${next()}`, email: `lp${seq}@links.test`, password: PW, schoolId });
const student = (schoolId = SCHOOL_A) =>
  createAndLogin(ctx, rootToken, { role: 'student', fullName: `Kid ${next()}`, studentId: `LNK-${seq}`, pin: '482913', schoolId });

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  u.saA = await createAndLogin(ctx, rootToken, { role: 'school_admin', fullName: 'SA A', email: 'sa.a@links.test', password: PW, schoolId: SCHOOL_A });
  u.teacherA = await createAndLogin(ctx, rootToken, { role: 'teacher', fullName: 'T A', email: 't.a@links.test', password: PW, schoolId: SCHOOL_A });
  u.psych = await createAndLogin(ctx, rootToken, { role: 'psychologist', fullName: 'Ps', email: 'ps@links.test', password: PW });
});

afterAll(async () => {
  await ctx?.close();
});

const link = (body: unknown, token: string = rootToken) => ctx.post(BASE, body, token);
const unlink = (studentId: string, token: string = rootToken) => ctx.del(`${BASE}/${studentId}`, token);
const list = (qs = '', token: string = rootToken) => ctx.get(`${BASE}${qs}`, token);
const parentOf = async (studentId: string) =>
  (await ctx.pg.query('SELECT parent_id FROM parent_students WHERE student_id = $1', [studentId])).rows[0]?.parent_id ?? null;

describe('RBAC', () => {
  test('no token → 401', async () => {
    expect((await ctx.post(BASE, {})).status).toBe(401);
    expect((await ctx.get(BASE)).status).toBe(401);
  });

  test.each(['teacherA', 'psych'])('%s → 403 on every endpoint', async (who) => {
    const p = await parent();
    const s = await student();
    expect((await link({ parentId: p.id, studentId: s.id }, u[who]!.token)).status).toBe(403);
    expect((await list('', u[who]!.token)).status).toBe(403);
    expect((await unlink(s.id, u[who]!.token)).status).toBe(403);
    expect(await parentOf(s.id)).toBe(null);
  });

  test('parents and students cannot create links', async () => {
    const p = await parent();
    const s = await student();
    expect((await link({ parentId: p.id, studentId: s.id }, p.token)).status).toBe(403);
    expect((await link({ parentId: p.id, studentId: s.id }, s.token)).status).toBe(403);
    expect((await unlink(s.id, p.token)).status).toBe(403);
  });
});

describe('POST /parent-students', () => {
  test('links a parent and a student of the same school → 201', async () => {
    const p = await parent();
    const s = await student();
    const r = await link({ parentId: p.id, studentId: s.id }, u.saA!.token);
    expect(r.status).toBe(201);
    expect(r.body.link).toMatchObject({ parent: { id: p.id }, student: { id: s.id } });
    expect(Object.keys(r.body.link).sort()).toEqual(['createdAt', 'parent', 'student']);
    expect(await parentOf(s.id)).toBe(p.id);
    // The users API reports the link too.
    expect((await ctx.get(`/api/v1/users/${s.id}`, rootToken)).body.user.parentId).toBe(p.id);
  });

  test('a parent can have several children', async () => {
    const p = await parent();
    const kids = [await student(), await student(), await student()];
    for (const k of kids) expect((await link({ parentId: p.id, studentId: k.id })).status).toBe(201);
    const r = await list(`?parentId=${p.id}`);
    expect(r.body.links.map((l: { student: { id: string } }) => l.student.id).sort()).toEqual(kids.map((k) => k.id).sort());
  });

  test('a student can have only one parent: a second link → 409, the first stays', async () => {
    const p1 = await parent();
    const p2 = await parent();
    const s = await student();
    expect((await link({ parentId: p1.id, studentId: s.id })).status).toBe(201);
    const r = await link({ parentId: p2.id, studentId: s.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'CONFLICT', message: 'This student already has a parent.' });
    expect(await parentOf(s.id)).toBe(p1.id);
  });

  test('the same link twice → 409', async () => {
    const p = await parent();
    const s = await student();
    expect((await link({ parentId: p.id, studentId: s.id })).status).toBe(201);
    expect((await link({ parentId: p.id, studentId: s.id })).status).toBe(409);
  });

  test('concurrent links for one student: exactly one wins', async () => {
    const s = await student();
    const parents = await Promise.all([parent(), parent(), parent(), parent(), parent()]);
    const results = await Promise.all(parents.map((p) => link({ parentId: p.id, studentId: s.id })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  test('cross-school link → 422, nothing written (Platform Admin too)', async () => {
    const pB = await parent(SCHOOL_B);
    const sA = await student(SCHOOL_A);
    const r = await link({ parentId: pB.id, studentId: sA.id });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'INVALID_REFERENCE', details: { field: 'parentId' } });
    expect(await parentOf(sA.id)).toBe(null);
  });

  test('School Admin: a student of another school → 422 (same as unknown), nothing written', async () => {
    const pB = await parent(SCHOOL_B);
    const sB = await student(SCHOOL_B);
    const r = await link({ parentId: pB.id, studentId: sB.id }, u.saA!.token);
    expect(r.status).toBe(422);
    expect(r.body.error.details).toEqual({ field: 'studentId' });
    expect(await parentOf(sB.id)).toBe(null);
  });

  test('wrong roles, unknown or inactive parent → 422 naming the field', async () => {
    const s = await student();
    const otherStudent = await student();
    const inactive = await parent();
    await ctx.pg.query('UPDATE users SET is_active = false WHERE id = $1', [inactive.id]);
    for (const parentId of [otherStudent.id, u.teacherA!.id, inactive.id, '99999999-9999-4999-8999-999999999999']) {
      const r = await link({ parentId, studentId: s.id });
      expect(r.status).toBe(422);
      expect(r.body.error.details).toEqual({ field: 'parentId' });
    }
    const p = await parent();
    for (const studentId of [p.id, u.teacherA!.id, '99999999-9999-4999-8999-999999999999']) {
      const r = await link({ parentId: p.id, studentId });
      expect(r.status).toBe(422);
      expect(r.body.error.details).toEqual({ field: 'studentId' });
    }
  });

  test.each([
    ['missing studentId', { parentId: SCHOOL_A }],
    ['bad uuid', { parentId: 'x', studentId: 'y' }],
    ['unknown field', { parentId: SCHOOL_A, studentId: SCHOOL_B, schoolId: SCHOOL_A }],
  ])('%s → 400', async (_label, body) => {
    expect((await link(body)).status).toBe(400);
  });
});

describe('DELETE /parent-students/:studentId', () => {
  test('unlinks; the student can then be linked to another parent', async () => {
    const p1 = await parent();
    const p2 = await parent();
    const s = await student();
    await link({ parentId: p1.id, studentId: s.id });
    const r = await unlink(s.id, u.saA!.token);
    expect(r.status).toBe(204);
    expect(await parentOf(s.id)).toBe(null);
    expect((await link({ parentId: p2.id, studentId: s.id })).status).toBe(201);
  });

  test('no link, or (School Admin) another school → 404, nothing removed', async () => {
    const s = await student();
    expect((await unlink(s.id)).status).toBe(404);
    const pB = await parent(SCHOOL_B);
    const sB = await student(SCHOOL_B);
    await link({ parentId: pB.id, studentId: sB.id });
    expect((await unlink(sB.id, u.saA!.token)).status).toBe(404);
    expect(await parentOf(sB.id)).toBe(pB.id);
  });
});

describe('GET /parent-students', () => {
  test('School Admin sees only links in their school', async () => {
    const pB = await parent(SCHOOL_B);
    const sB = await student(SCHOOL_B);
    await link({ parentId: pB.id, studentId: sB.id });
    const r = await list('?limit=100', u.saA!.token);
    expect(r.status).toBe(200);
    const { rows } = await ctx.pg.query(
      `SELECT ps.student_id FROM parent_students ps JOIN users s ON s.id = ps.student_id WHERE s.school_id = $1 ORDER BY 1`, [SCHOOL_A]);
    expect(r.body.links.map((l: { student: { id: string } }) => l.student.id).sort()).toEqual(rows.map((x: { student_id: string }) => x.student_id).sort());
    expect(r.body.links.some((l: { student: { id: string } }) => l.student.id === sB.id)).toBe(false);
  });

  test("a parent sees only their own children; asking for another parent's → 403", async () => {
    const p = await parent();
    const other = await parent();
    const mine = await student();
    const theirs = await student();
    await link({ parentId: p.id, studentId: mine.id });
    await link({ parentId: other.id, studentId: theirs.id });
    const r = await list('', p.token);
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: { student: { id: string } }) => l.student.id)).toEqual([mine.id]);
    expect((await list(`?studentId=${theirs.id}`, p.token)).body.links).toEqual([]);
    expect((await list(`?parentId=${other.id}`, p.token)).status).toBe(403);
  });
});

describe('register with parentId writes the same link', () => {
  test('a student registered with a parent gets a parent_students row', async () => {
    const p = await parent();
    const r = await ctx.register({ role: 'student', fullName: 'Reg Kid', studentId: 'LNK-REG', pin: '482913', parentId: p.id }, u.saA!.token);
    expect(r.status).toBe(201);
    expect(r.body.user.parentId).toBe(p.id);
    expect(await parentOf(r.body.user.id)).toBe(p.id);
  });
});
