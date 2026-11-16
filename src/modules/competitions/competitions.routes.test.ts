// Events & Competitions — Supertest over HTTP against the real app + PostgreSQL. A gap found
// against the client's prototype, not yet confirmed scope (docs/SCOPE_OF_WORK.md, 16 Nov 2026).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;
/** A second teacher at school A, teaching the same class — for "not yours to remove" cases. */
let teacher2: Account;

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
  teacher2 = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
  const assigned = await ctx.put(`/api/v1/classes/${a.classId}/teachers/${teacher2.id}`, a.schoolAdmin.token);
  expect(assigned.status).toBe(204);
});

afterAll(async () => {
  await ctx?.close();
});

const COMPETITIONS = '/api/v1/competitions';
const create = (body: unknown, token: string) => ctx.post(COMPETITIONS, body, token);
const titles = async (token: string, query = '') =>
  ((await ctx.get(`${COMPETITIONS}${query}`, token)).body.competitions as { title: string }[]).map((c) => c.title);

describe('creating', () => {
  test('a school admin creates a competition for their own school', async () => {
    const r = await create({ title: 'Inter-School Chess', level: 'inter_school', scheduledOn: '2026-12-01' }, a.schoolAdmin.token);
    expect(r.status).toBe(201);
    expect(r.body.competition).toMatchObject({
      schoolId: SCHOOL_A,
      title: 'Inter-School Chess',
      level: 'inter_school',
      status: 'planning',
      scheduledOn: '2026-12-01',
      nominations: [],
    });
  });

  test('a school admin cannot create for another school', async () => {
    expect((await create({ title: 'x', level: 'state', schoolId: SCHOOL_B }, a.schoolAdmin.token)).status).toBe(403);
  });

  test('a platform admin creates for a named school, and 422s for an unknown one', async () => {
    const r = await create({ title: 'National Science Olympiad', level: 'national', schoolId: SCHOOL_B }, rootToken);
    expect(r.status).toBe(201);
    expect(r.body.competition.schoolId).toBe(SCHOOL_B);

    const unknown = await create(
      { title: 'Nowhere', level: 'national', schoolId: '99999999-9999-4999-8999-999999999999' },
      rootToken,
    );
    expect(unknown.status).toBe(422);
  });

  test('a platform admin must name a school; only admins create; bad input 400s', async () => {
    expect((await create({ title: 'No school named', level: 'national' }, rootToken)).status).toBe(400);
    expect((await create({ title: 'x', level: 'state' }, a.teacher.token)).status).toBe(403);
    expect((await create({ title: 'x', level: 'state' }, a.parent.token)).status).toBe(403);
    expect((await create({ title: '   ', level: 'state' }, a.schoolAdmin.token)).status).toBe(400);
    expect((await create({ title: 'x', level: 'olympics' }, a.schoolAdmin.token)).status).toBe(400);
  });
});

describe('listing', () => {
  test("a teacher sees only their own school's competitions", async () => {
    const seenByATeacher = await titles(a.teacher.token);
    expect(seenByATeacher).toContain('Inter-School Chess');
    expect(seenByATeacher).not.toContain('National Science Olympiad');

    const seenByBTeacher = await titles(b.teacher.token);
    expect(seenByBTeacher).toContain('National Science Olympiad');
    expect(seenByBTeacher).not.toContain('Inter-School Chess');
  });

  test("platform admin sees every school's, filterable by schoolId; others can't filter", async () => {
    const everything = await titles(rootToken);
    expect(everything).toEqual(expect.arrayContaining(['Inter-School Chess', 'National Science Olympiad']));
    const onlyB = await titles(rootToken, `?schoolId=${SCHOOL_B}`);
    expect(onlyB).toContain('National Science Olympiad');
    expect(onlyB).not.toContain('Inter-School Chess');
    expect((await ctx.get(`${COMPETITIONS}?schoolId=${SCHOOL_A}`, a.schoolAdmin.token)).status).toBe(403);
  });

  test('a psychologist, having no school of their own, sees none', async () => {
    expect(await titles(psych.token)).toEqual([]);
  });
});

describe('editing and removing a competition', () => {
  let competitionId: string;

  beforeAll(async () => {
    const r = await create({ title: 'Science Fair', level: 'intra_school' }, a.schoolAdmin.token);
    competitionId = r.body.competition.id;
  });

  test('only school admin / platform admin may patch or delete; a teacher gets 403', async () => {
    expect((await ctx.patch(`${COMPETITIONS}/${competitionId}`, { status: 'registration_open' }, a.teacher.token)).status).toBe(403);
    expect((await ctx.del(`${COMPETITIONS}/${competitionId}`, a.teacher.token)).status).toBe(403);
  });

  test('a school admin of another school gets 404, never a leak', async () => {
    expect((await ctx.patch(`${COMPETITIONS}/${competitionId}`, { status: 'confirmed' }, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.del(`${COMPETITIONS}/${competitionId}`, b.schoolAdmin.token)).status).toBe(404);
  });

  test('its own school admin can patch it, and so can a platform admin', async () => {
    const patched = await ctx.patch(
      `${COMPETITIONS}/${competitionId}`,
      { status: 'registration_open', title: 'Annual Science Fair' },
      a.schoolAdmin.token,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.competition).toMatchObject({ status: 'registration_open', title: 'Annual Science Fair' });
    expect((await ctx.patch(`${COMPETITIONS}/${competitionId}`, {}, a.schoolAdmin.token)).status).toBe(400);
    expect((await ctx.patch(`${COMPETITIONS}/${competitionId}`, { status: 'shortlisting' }, rootToken)).status).toBe(200);
  });

  test('it is deleted by its own school admin; a second delete 404s', async () => {
    expect((await ctx.del(`${COMPETITIONS}/${competitionId}`, a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.del(`${COMPETITIONS}/${competitionId}`, a.schoolAdmin.token)).status).toBe(404);
  });
});

describe('nominations', () => {
  let competitionId: string;
  const nominate = (studentId: string, token: string) => ctx.post(`${COMPETITIONS}/${competitionId}/nominations`, { studentId }, token);
  const unnominate = (studentId: string, token: string) => ctx.del(`${COMPETITIONS}/${competitionId}/nominations/${studentId}`, token);

  beforeAll(async () => {
    const r = await create({ title: 'District Quiz', level: 'inter_school' }, a.schoolAdmin.token);
    competitionId = r.body.competition.id;
  });

  test("a teacher nominates one of their own school's students", async () => {
    const r = await nominate(a.student.id, a.teacher.token);
    expect(r.status).toBe(201);
    expect(r.body.nomination).toMatchObject({ studentId: a.student.id, nominatedBy: { fullName: expect.any(String) } });

    const listed = (await ctx.get(COMPETITIONS, a.teacher.token)).body.competitions as {
      id: string;
      nominations: { studentId: string }[];
    }[];
    const competition = listed.find((c) => c.id === competitionId);
    expect(competition?.nominations.map((n) => n.studentId)).toContain(a.student.id);
  });

  test('nominating a student from a different school is rejected (422)', async () => {
    expect((await nominate(b.student.id, a.teacher.token)).status).toBe(422);
  });

  test('nominating the same student twice conflicts (409)', async () => {
    expect((await nominate(a.student.id, a.teacher.token)).status).toBe(409);
  });

  test("the competition must belong to the teacher's own school (404)", async () => {
    expect((await nominate(b.student.id, b.teacher.token)).status).toBe(404);
  });

  test('only a teacher may nominate', async () => {
    expect((await nominate(a.student.id, a.schoolAdmin.token)).status).toBe(403);
    expect((await nominate(a.student.id, rootToken)).status).toBe(403);
  });

  test("removing a nomination the caller didn't make, and isn't an admin for, is forbidden (403)", async () => {
    expect((await unnominate(a.student.id, teacher2.token)).status).toBe(403);
  });

  test('removing it across schools 404s, whether admin or teacher', async () => {
    expect((await unnominate(a.student.id, b.schoolAdmin.token)).status).toBe(404);
    expect((await unnominate(a.student.id, b.teacher.token)).status).toBe(404);
  });

  test('the nominating teacher removes their own nomination', async () => {
    expect((await unnominate(a.student.id, a.teacher.token)).status).toBe(204);
    const listed = (await ctx.get(COMPETITIONS, a.teacher.token)).body.competitions as { id: string; nominations: unknown[] }[];
    expect(listed.find((c) => c.id === competitionId)?.nominations).toEqual([]);
  });

  test('a school admin, and a platform admin, may also remove a nomination', async () => {
    expect((await nominate(a.student.id, a.teacher.token)).status).toBe(201);
    expect((await unnominate(a.student.id, a.schoolAdmin.token)).status).toBe(204);

    expect((await nominate(a.student.id, a.teacher.token)).status).toBe(201);
    expect((await unnominate(a.student.id, rootToken)).status).toBe(204);
  });

  test('removing a nomination that does not exist 404s', async () => {
    expect((await unnominate(a.student.id, a.teacher.token)).status).toBe(404);
  });
});
