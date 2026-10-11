// Classes — Supertest over HTTP against the real app + PostgreSQL.
// School Admin manages own-school classes (school from the token), case-insensitive unique
// names (409), many teachers per class and classes per teacher, one class per student,
// same-school membership only, and teachers see only the classes they are assigned to.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const BASE = '/api/v1/classes';
const PW = 'Classes-Password-1';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

let ctx: TestContext;
let rootToken: string;
type Account = { id: string; token: string; refreshToken: string };
const u: Record<string, Account> = {};

let seq = 0;
const next = () => (seq += 1);
const teacher = (schoolId = SCHOOL_A) =>
  createAndLogin(ctx, rootToken, { role: 'teacher', fullName: `Teacher ${next()}`, email: `ct${seq}@classes.test`, password: PW, schoolId });
const student = (schoolId = SCHOOL_A) =>
  createAndLogin(ctx, rootToken, { role: 'student', fullName: `Pupil ${next()}`, studentId: `CLS-${seq}`, pin: '482913', schoolId });

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  u.saA = await createAndLogin(ctx, rootToken, { role: 'school_admin', fullName: 'SA A', email: 'sa.a@classes.test', password: PW, schoolId: SCHOOL_A });
  u.saB = await createAndLogin(ctx, rootToken, { role: 'school_admin', fullName: 'SA B', email: 'sa.b@classes.test', password: PW, schoolId: SCHOOL_B });
  u.parentA = await createAndLogin(ctx, rootToken, { role: 'parent', fullName: 'P A', email: 'p.a@classes.test', password: PW, schoolId: SCHOOL_A });
  u.psych = await createAndLogin(ctx, rootToken, { role: 'psychologist', fullName: 'Ps', email: 'ps@classes.test', password: PW });
});

afterAll(async () => {
  await ctx?.close();
});

const create = (name: unknown, token: string = u.saA!.token) => ctx.post(BASE, { name }, token);
const newClass = async (token: string = u.saA!.token) => {
  const r = await create(`Class ${next()}`, token);
  if (r.status !== 201) throw new Error(`create class failed: ${r.status}`);
  return r.body.class.id as string;
};
const addTeacher = (c: string, t: string, token: string = u.saA!.token) => ctx.put(`${BASE}/${c}/teachers/${t}`, token);
const addStudent = (c: string, s: string, token: string = u.saA!.token) => ctx.put(`${BASE}/${c}/students/${s}`, token);
const classOf = async (studentId: string) =>
  (await ctx.pg.query('SELECT class_id FROM class_students WHERE student_id = $1', [studentId])).rows[0]?.class_id ?? null;

describe('RBAC', () => {
  test('no token → 401', async () => {
    expect((await ctx.get(BASE)).status).toBe(401);
    expect((await ctx.post(BASE, { name: 'X' })).status).toBe(401);
  });

  test.each(['parentA', 'psych'])('%s → 403 on every class endpoint', async (who) => {
    const c = await newClass();
    const t = await teacher();
    const token = u[who]!.token;
    expect((await create('Nope', token)).status).toBe(403);
    expect((await ctx.get(BASE, token)).status).toBe(403);
    expect((await ctx.get(`${BASE}/${c}`, token)).status).toBe(403);
    expect((await ctx.patch(`${BASE}/${c}`, { name: 'Hijack' }, token)).status).toBe(403);
    expect((await addTeacher(c, t.id, token)).status).toBe(403);
  });

  test('Platform Admin does not manage classes (School Admin scope) → 403', async () => {
    expect((await create('Platform Class', rootToken)).status).toBe(403);
    expect((await ctx.get(BASE, rootToken)).status).toBe(403);
  });

  test('a teacher can read but not create, rename or change membership → 403', async () => {
    const t = await teacher();
    const c = await newClass();
    const s = await student();
    expect((await create('By Teacher', t.token)).status).toBe(403);
    expect((await ctx.patch(`${BASE}/${c}`, { name: 'Renamed' }, t.token)).status).toBe(403);
    expect((await addTeacher(c, t.id, t.token)).status).toBe(403);
    expect((await addStudent(c, s.id, t.token)).status).toBe(403);
    expect(await classOf(s.id)).toBe(null);
  });
});

describe('create / rename', () => {
  test('creates a class in the caller\'s school (201 + Location)', async () => {
    const r = await create('  Grade 4 – B  ');
    expect(r.status).toBe(201);
    expect(r.body.class).toMatchObject({ name: 'Grade 4 – B', schoolId: SCHOOL_A });
    expect(r.headers.location).toBe(`/api/v1/classes/${r.body.class.id}`);
    expect(Object.keys(r.body.class).sort()).toEqual(['createdAt', 'id', 'name', 'schoolId', 'updatedAt']);
  });

  test('a schoolId in the body is rejected (400): the school always comes from the token', async () => {
    const r = await ctx.post(BASE, { name: 'Elsewhere', schoolId: SCHOOL_B }, u.saA!.token);
    expect(r.status).toBe(400);
    expect(r.body.error.details).toContainEqual({ field: 'schoolId', message: 'is not allowed' });
  });

  test('duplicate name in the same school, any case → 409', async () => {
    expect((await create('Class A')).status).toBe(201);
    for (const name of ['Class A', 'class a', 'CLASS A', '  class A ']) {
      const r = await create(name);
      expect(r.status, name).toBe(409);
      expect(r.body.error).toEqual({ code: 'CONFLICT', message: 'A class with this name already exists in this school.' });
    }
  });

  test('the same name in another school is fine', async () => {
    expect((await create('Shared Name')).status).toBe(201);
    expect((await create('shared name', u.saB!.token)).status).toBe(201);
  });

  test('rename; renaming onto a taken name (any case) → 409; another school\'s class → 404', async () => {
    const c = await newClass();
    await create('Taken Name');
    const ok = await ctx.patch(`${BASE}/${c}`, { name: 'Fresh Name' }, u.saA!.token);
    expect(ok.status).toBe(200);
    expect(ok.body.class.name).toBe('Fresh Name');
    expect((await ctx.patch(`${BASE}/${c}`, { name: 'TAKEN NAME' }, u.saA!.token)).status).toBe(409);
    const cB = await newClass(u.saB!.token);
    expect((await ctx.patch(`${BASE}/${cB}`, { name: 'Hijack' }, u.saA!.token)).status).toBe(404);
    expect((await ctx.patch(`${BASE}/${UNKNOWN}`, { name: 'X' }, u.saA!.token)).status).toBe(404);
  });

  test.each([[''], ['   '], ['x'.repeat(101)], [42]])('invalid name %j → 400', async (name) => {
    expect((await create(name)).status).toBe(400);
  });
});

describe('teachers ↔ classes', () => {
  test('a class can have many teachers and a teacher many classes', async () => {
    const [c1, c2] = [await newClass(), await newClass()];
    const [t1, t2] = [await teacher(), await teacher()];
    for (const [c, t] of [[c1, t1], [c1, t2], [c2, t1]] as const) expect((await addTeacher(c, t.id)).status).toBe(204);
    const detail = await ctx.get(`${BASE}/${c1}`, u.saA!.token);
    expect(detail.body.teachers.map((x: { id: string }) => x.id).sort()).toEqual([t1.id, t2.id].sort());
    const t1Classes = await ctx.get(`${BASE}?limit=100`, t1.token);
    expect(t1Classes.body.classes.map((x: { id: string }) => x.id).sort()).toEqual([c1, c2].sort());
  });

  test('assigning twice is a no-op (204)', async () => {
    const c = await newClass();
    const t = await teacher();
    expect((await addTeacher(c, t.id)).status).toBe(204);
    expect((await addTeacher(c, t.id)).status).toBe(204);
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM class_teachers WHERE class_id = $1', [c])).rows[0].n).toBe(1);
  });

  test('cross-school or non-teacher → 404, nothing written', async () => {
    const c = await newClass();
    const tB = await teacher(SCHOOL_B);
    const r = await addTeacher(c, tB.id);
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('Teacher not found.');
    for (const id of [u.parentA!.id, u.saA!.id, UNKNOWN]) expect((await addTeacher(c, id)).status).toBe(404);
    const cB = await newClass(u.saB!.token);
    expect((await addTeacher(cB, (await teacher()).id)).status).toBe(404); // class of another school
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM class_teachers WHERE class_id IN ($1, $2)', [c, cB])).rows[0].n).toBe(0);
  });

  test('unassign; unassigning again → 404', async () => {
    const c = await newClass();
    const t = await teacher();
    await addTeacher(c, t.id);
    expect((await ctx.del(`${BASE}/${c}/teachers/${t.id}`, u.saA!.token)).status).toBe(204);
    expect((await ctx.del(`${BASE}/${c}/teachers/${t.id}`, u.saA!.token)).status).toBe(404);
    expect((await ctx.get(`${BASE}/${c}`, t.token)).status).toBe(404); // no longer theirs
  });
});

describe('students ↔ classes', () => {
  test('a student belongs to exactly one class: adding to a second class → 409, the first stays', async () => {
    const [c1, c2] = [await newClass(), await newClass()];
    const s = await student();
    expect((await addStudent(c1, s.id)).status).toBe(204);
    const r = await addStudent(c2, s.id);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toBe('This student already belongs to another class.');
    expect(await classOf(s.id)).toBe(c1);
  });

  test('adding to the same class again is a no-op (204)', async () => {
    const c = await newClass();
    const s = await student();
    expect((await addStudent(c, s.id)).status).toBe(204);
    expect((await addStudent(c, s.id)).status).toBe(204);
  });

  test('moving = remove then add', async () => {
    const [c1, c2] = [await newClass(), await newClass()];
    const s = await student();
    await addStudent(c1, s.id);
    expect((await ctx.del(`${BASE}/${c1}/students/${s.id}`, u.saA!.token)).status).toBe(204);
    expect((await addStudent(c2, s.id)).status).toBe(204);
    expect(await classOf(s.id)).toBe(c2);
  });

  test('cross-school or non-student → 404, nothing written', async () => {
    const c = await newClass();
    const sB = await student(SCHOOL_B);
    expect((await addStudent(c, sB.id)).body.error.message).toBe('Student not found.');
    for (const id of [u.parentA!.id, (await teacher()).id, UNKNOWN]) expect((await addStudent(c, id)).status).toBe(404);
    const cB = await newClass(u.saB!.token);
    expect((await addStudent(cB, (await student()).id)).status).toBe(404);
    expect(await classOf(sB.id)).toBe(null);
  });

  test('concurrent adds of one student to different classes: exactly one wins', async () => {
    const classes = await Promise.all([newClass(), newClass(), newClass(), newClass()]);
    const s = await student();
    const results = await Promise.all(classes.map((c) => addStudent(c, s.id)));
    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  test('remove from a class they are not in → 404', async () => {
    const c = await newClass();
    expect((await ctx.del(`${BASE}/${c}/students/${(await student()).id}`, u.saA!.token)).status).toBe(404);
  });
});

describe('teacher scoping', () => {
  test("a teacher sees only their own classes and those classes' students", async () => {
    const [mine, theirs] = [await newClass(), await newClass()];
    const [me, other] = [await teacher(), await teacher()];
    const [myKid, theirKid] = [await student(), await student()];
    await addTeacher(mine, me.id);
    await addTeacher(theirs, other.id);
    await addStudent(mine, myKid.id);
    await addStudent(theirs, theirKid.id);

    const listed = await ctx.get(`${BASE}?limit=100`, me.token);
    expect(listed.body.classes.map((c: { id: string }) => c.id)).toEqual([mine]);
    const detail = await ctx.get(`${BASE}/${mine}`, me.token);
    expect(detail.status).toBe(200);
    expect(detail.body.students).toEqual([{ id: myKid.id, fullName: expect.any(String) }]);
    const blocked = await ctx.get(`${BASE}/${theirs}`, me.token);
    expect(blocked.status).toBe(404);
    expect(JSON.stringify(blocked.body)).not.toContain(theirKid.id);
  });

  test('School Admin sees every class of their school, none of another school', async () => {
    const cB = await newClass(u.saB!.token);
    const r = await ctx.get(`${BASE}?limit=100`, u.saA!.token);
    const { rows } = await ctx.pg.query('SELECT id FROM classes WHERE school_id = $1', [SCHOOL_A]);
    expect(r.body.classes.map((c: { id: string }) => c.id).sort()).toEqual(rows.map((x: { id: string }) => x.id).sort());
    expect((await ctx.get(`${BASE}/${cB}`, u.saA!.token)).status).toBe(404);
  });

  test('list: name filter, sort and pagination', async () => {
    await create('Zeta Filter');
    await create('alpha filter');
    const r = await ctx.get(`${BASE}?name=FILTER&sortBy=name&sortOrder=asc`, u.saA!.token);
    expect(r.body.classes.map((c: { name: string }) => c.name)).toEqual(['alpha filter', 'Zeta Filter']);
    expect((await ctx.get(`${BASE}?sortBy=schoolId`, u.saA!.token)).status).toBe(400);
  });
});
