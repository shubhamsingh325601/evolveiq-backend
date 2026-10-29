// Removing accounts, classes and schools — Supertest over HTTP against the real app +
// PostgreSQL. Only what has no history can go; anything with records is switched off instead.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { addStudentToClass, createSchoolFixture, newAccount, type SchoolFixture } from '../../../test/support/fixtures.js';

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
});

afterAll(async () => {
  await ctx?.close();
});

const user = (id: string) => `/api/v1/users/${id}`;

describe('removing an account', () => {
  test('one with no records goes, with its class place, parent link and health profile', async () => {
    const child = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    await addStudentToClass(ctx, a, child.id);
    expect((await ctx.post('/api/v1/parent-students', { parentId: a.parent.id, studentId: child.id }, a.schoolAdmin.token)).status).toBe(201);
    expect((await ctx.send('PUT', `/api/v1/students/${child.id}/health`, { body: { conditions: ['asthma'] }, token: a.parent.token })).status).toBe(200);
    const loginId = (await ctx.get(user(child.id), a.schoolAdmin.token)).body.user.studentId as string;

    expect((await ctx.del(user(child.id), a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.get(user(child.id), a.schoolAdmin.token)).status).toBe(404);
    const members = (await ctx.get(`/api/v1/classes/${a.classId}`, a.schoolAdmin.token)).body.students as { id: string }[];
    expect(members.map((m) => m.id)).not.toContain(child.id);
    expect((await ctx.login({ studentId: loginId, pin: '482913' })).status).toBe(401);
    expect((await ctx.get(`/api/v1/students/${child.id}/health`, a.parent.token)).status).toBe(404);
  });

  test('a teacher with no records goes too, unassigned from their classes', async () => {
    const teacher = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    expect((await ctx.put(`/api/v1/classes/${a.classId}/teachers/${teacher.id}`, a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.del(user(teacher.id), a.schoolAdmin.token)).status).toBe(204);
  });

  test('one with records is kept: 409 HAS_RECORDS, switch it off instead', async () => {
    const observation = await ctx.post(
      '/api/v1/observations',
      { studentId: a.student.id, area: 'learning', description: 'Finished early and helped others.', when: 'today', howOften: 'once', tone: 'positive' },
      a.teacher.token,
    );
    expect(observation.status).toBe(201);
    for (const id of [a.teacher.id, a.student.id]) {
      const r = await ctx.del(user(id), a.schoolAdmin.token);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('HAS_RECORDS');
      expect((await ctx.get(user(id), a.schoolAdmin.token)).status).toBe(200);
    }
    // Nothing was half-removed: the student is still in the class and linked to the parent.
    const members = (await ctx.get(`/api/v1/classes/${a.classId}`, a.schoolAdmin.token)).body;
    expect(members.students.map((m: { id: string }) => m.id)).toContain(a.student.id);
    expect(members.teachers.map((m: { id: string }) => m.id)).toContain(a.teacher.id);
  });

  test('nobody removes themselves, and a school admin only reaches their own school', async () => {
    expect((await ctx.del(user(a.schoolAdmin.id), a.schoolAdmin.token)).status).toBe(403);
    expect((await ctx.del(user(b.parent.id), a.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.del(user(b.parent.id), a.teacher.token)).status).toBe(403);
    expect((await ctx.del(user(b.schoolAdmin.id), a.schoolAdmin.token)).status).toBe(404);
  });

  test('a platform admin removes in any school', async () => {
    const parent = await newAccount(ctx, rootToken, 'parent', SCHOOL_B);
    expect((await ctx.del(user(parent.id), rootToken)).status).toBe(204);
  });
});

describe('deleting a class', () => {
  test('its students stay at the school without a class', async () => {
    const created = await ctx.post('/api/v1/classes', { name: 'To delete' }, a.schoolAdmin.token);
    const classId = created.body.class.id as string;
    const pupil = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    expect((await ctx.put(`/api/v1/classes/${classId}/students/${pupil.id}`, a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.put(`/api/v1/classes/${classId}/teachers/${a.teacher.id}`, a.schoolAdmin.token)).status).toBe(204);

    expect((await ctx.del(`/api/v1/classes/${classId}`, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.del(`/api/v1/classes/${classId}`, a.teacher.token)).status).toBe(403);
    expect((await ctx.del(`/api/v1/classes/${classId}`, a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.get(`/api/v1/classes/${classId}`, a.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.get(user(pupil.id), a.schoolAdmin.token)).status).toBe(200);
    expect((await ctx.put(`/api/v1/classes/${a.classId}/students/${pupil.id}`, a.schoolAdmin.token)).status).toBe(204);
  });
});

describe('deleting a school', () => {
  test('only an empty one, and only by the platform admin', async () => {
    const empty = (await ctx.post('/api/v1/schools', { name: 'Opened by mistake' }, rootToken)).body.school.id as string;
    expect((await ctx.post('/api/v1/notices', { category: 'general', title: 'Hello', schoolId: empty }, rootToken)).status).toBe(201);
    expect((await ctx.del(`/api/v1/schools/${empty}`, a.schoolAdmin.token)).status).toBe(403);
    expect((await ctx.del(`/api/v1/schools/${empty}`, rootToken)).status).toBe(204);
    expect((await ctx.get(`/api/v1/schools/${empty}`, rootToken)).status).toBe(404);

    const busy = await ctx.del(`/api/v1/schools/${SCHOOL_A}`, rootToken);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('HAS_RECORDS');
  });
});
