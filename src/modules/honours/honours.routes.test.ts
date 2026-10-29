// The celebration wall — Supertest over HTTP against the real app + PostgreSQL, with a FIXED
// clock: NOW = 2026-11-03T20:00:00Z = 2026-11-04 in Asia/Kolkata (current month 2026-11).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { addStudentToClass, createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

const NOW = new Date('2026-11-03T20:00:00.000Z');

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;
/** A second student at school A, with no parent: another family's child. */
let classmate: Account;

beforeAll(async () => {
  ctx = await createTestContext({ now: () => NOW });
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
  classmate = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
  await addStudentToClass(ctx, a, classmate.id);
});

afterAll(async () => {
  await ctx?.close();
});

const HONOURS = '/api/v1/honours';
const name = (body: unknown, token = a.schoolAdmin.token) => ctx.post(HONOURS, body, token);
const kinds = async (token: string) =>
  ((await ctx.get(HONOURS, token)).body.honours as { kind: string; honoree: { id: string } }[]).map((h) => `${h.kind}:${h.honoree.id}`);

describe('naming honours', () => {
  test('the school admin names a Staff of the Month and Students of the Month', async () => {
    const staff = await name({ kind: 'staff_of_month', month: '2026-10', honoreeId: a.teacher.id, citation: 'Ran the science fair.' });
    expect(staff.status).toBe(201);
    expect(staff.body.honour).toMatchObject({
      kind: 'staff_of_month',
      month: '2026-10',
      honoree: { id: a.teacher.id, role: 'teacher', className: null },
      citation: 'Ran the science fair.',
    });
    const student = await name({ kind: 'student_of_month', month: '2026-11', honoreeId: a.student.id, citation: 'Helped a new classmate settle in.' });
    expect(student.status).toBe(201);
    expect(student.body.honour.honoree).toMatchObject({ role: 'student', className: expect.any(String) });
    expect((await name({ kind: 'student_of_month', month: '2026-11', honoreeId: classmate.id, citation: 'Read every day.' })).status).toBe(201);
  });

  test('refuses doubles, the wrong person, other schools, the future and everyone else', async () => {
    expect((await name({ kind: 'staff_of_month', month: '2026-10', honoreeId: a.teacher.id, citation: 'Again' })).status).toBe(409);
    expect((await name({ kind: 'staff_of_month', month: '2026-10', honoreeId: a.student.id, citation: 'x' })).status).toBe(422);
    expect((await name({ kind: 'student_of_month', month: '2026-10', honoreeId: a.teacher.id, citation: 'x' })).status).toBe(422);
    expect((await name({ kind: 'staff_of_month', month: '2026-10', honoreeId: b.teacher.id, citation: 'x' })).status).toBe(422);
    expect((await name({ kind: 'staff_of_month', month: '2026-12', honoreeId: a.teacher.id, citation: 'x' })).status).toBe(400);
    expect((await name({ kind: 'staff_of_month', month: '2026-10', honoreeId: a.teacher.id, citation: '  ' })).status).toBe(400);
    expect((await name({ kind: 'staff_of_month', month: '2026-09', honoreeId: a.teacher.id, citation: 'x' }, a.teacher.token)).status).toBe(403);
    expect((await name({ kind: 'staff_of_month', month: '2026-09', honoreeId: a.teacher.id, citation: 'x' }, rootToken)).status).toBe(403);
  });
});

describe('who sees the wall', () => {
  test('staff see their whole school', async () => {
    for (const token of [a.schoolAdmin.token, a.teacher.token]) {
      expect(await kinds(token)).toEqual(
        expect.arrayContaining([`staff_of_month:${a.teacher.id}`, `student_of_month:${a.student.id}`, `student_of_month:${classmate.id}`]),
      );
    }
  });

  test("families see the Staff of the Month and their own child's honours, never another child's", async () => {
    const parent = await kinds(a.parent.token);
    expect(parent).toEqual(expect.arrayContaining([`staff_of_month:${a.teacher.id}`, `student_of_month:${a.student.id}`]));
    expect(parent).not.toContain(`student_of_month:${classmate.id}`);
    const own = await kinds(a.student.token);
    expect(own).toEqual(expect.arrayContaining([`staff_of_month:${a.teacher.id}`, `student_of_month:${a.student.id}`]));
    expect(own).not.toContain(`student_of_month:${classmate.id}`);
    const theirs = await kinds(classmate.token);
    expect(theirs).toContain(`student_of_month:${classmate.id}`);
    expect(theirs).not.toContain(`student_of_month:${a.student.id}`);
  });

  test('other schools see nothing; the platform sees every wall; counsellors are not asked', async () => {
    expect(await kinds(b.parent.token)).toEqual([]);
    expect(await kinds(b.teacher.token)).toEqual([]);
    expect(await kinds(rootToken)).toHaveLength(3);
    expect((await ctx.get(`${HONOURS}?schoolId=${SCHOOL_B}`, rootToken)).body.honours).toEqual([]);
    expect((await ctx.get(`${HONOURS}?schoolId=${SCHOOL_B}`, a.schoolAdmin.token)).status).toBe(403);
    expect((await ctx.get(HONOURS, psych.token)).status).toBe(403);
  });

  test('filters by month and kind, newest month first', async () => {
    const november = (await ctx.get(`${HONOURS}?month=2026-11`, a.teacher.token)).body.honours as { month: string }[];
    expect(november.every((h) => h.month === '2026-11')).toBe(true);
    const staff = (await ctx.get(`${HONOURS}?kind=staff_of_month`, a.teacher.token)).body.honours as { kind: string }[];
    expect(staff.map((h) => h.kind)).toEqual(['staff_of_month']);
    const months = ((await ctx.get(HONOURS, a.teacher.token)).body.honours as { month: string }[]).map((h) => h.month);
    expect(months).toEqual([...months].sort().reverse());
  });
});

test('an honour can be taken down by its own school admin', async () => {
  const id = ((await ctx.get(`${HONOURS}?kind=staff_of_month`, a.schoolAdmin.token)).body.honours[0] as { id: string }).id;
  expect((await ctx.del(`${HONOURS}/${id}`, b.schoolAdmin.token)).status).toBe(404);
  expect((await ctx.del(`${HONOURS}/${id}`, a.teacher.token)).status).toBe(403);
  expect((await ctx.del(`${HONOURS}/${id}`, a.schoolAdmin.token)).status).toBe(204);
  expect(await kinds(a.parent.token)).not.toContain(`staff_of_month:${a.teacher.id}`);
});
