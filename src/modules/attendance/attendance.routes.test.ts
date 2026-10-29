// Class attendance — Supertest over HTTP against the real app + PostgreSQL, with a FIXED clock:
// NOW = 2026-11-03T20:00:00Z = 2026-11-04 01:30 in Asia/Kolkata, so "today" is 4 November.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

const NOW = new Date('2026-11-03T20:00:00.000Z');
const TODAY = '2026-11-04';

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;

beforeAll(async () => {
  ctx = await createTestContext({ now: () => NOW });
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const register = (classId: string, query = '') => `/api/v1/classes/${classId}/attendance${query}`;
const mark = (f: SchoolFixture, day: string, status: string, token = f.teacher.token, studentId = f.student.id) =>
  ctx.send('PUT', `/api/v1/classes/${f.classId}/attendance/${day}`, { body: { records: [{ studentId, status }] }, token });

describe('taking the register', () => {
  test("a teacher takes today's register for their class", async () => {
    const r = await mark(a, TODAY, 'present');
    expect(r.status).toBe(200);
    expect(r.body.attendance).toMatchObject({ classId: a.classId, from: TODAY, to: TODAY });
    expect(r.body.attendance.days).toEqual([{ day: TODAY, markedBy: { fullName: expect.any(String) }, markedAt: expect.any(String) }]);
    expect(r.body.attendance.students[0]).toMatchObject({ id: a.student.id, present: 1, late: 0, absent: 0, records: { [TODAY]: 'present' } });
  });

  test('the month so far counts present, late and absent days', async () => {
    expect((await mark(a, '2026-11-02', 'late')).status).toBe(200);
    expect((await mark(a, '2026-11-03', 'absent')).status).toBe(200);
    const r = await ctx.get(register(a.classId), a.teacher.token);
    expect(r.status).toBe(200);
    expect(r.body.attendance).toMatchObject({ from: '2026-11-01', to: TODAY });
    expect(r.body.attendance.days.map((d: { day: string }) => d.day)).toEqual(['2026-11-02', '2026-11-03', TODAY]);
    expect(r.body.attendance.students[0]).toMatchObject({
      present: 1,
      late: 1,
      absent: 1,
      records: { '2026-11-02': 'late', '2026-11-03': 'absent', [TODAY]: 'present' },
    });
  });

  test('a correction replaces the day, and the school admin can make it', async () => {
    expect((await mark(a, '2026-11-03', 'present', a.schoolAdmin.token)).status).toBe(200);
    const r = await ctx.get(register(a.classId, '?from=2026-11-03&to=2026-11-03'), a.schoolAdmin.token);
    expect(r.body.attendance.students[0]).toMatchObject({ present: 1, absent: 0 });
    expect(r.body.attendance.days[0].markedBy).toEqual({ fullName: expect.any(String) });
  });

  test('an earlier month reads on its own', async () => {
    expect((await mark(a, '2026-10-30', 'absent')).status).toBe(200);
    const r = await ctx.get(register(a.classId, '?from=2026-10-01&to=2026-10-31'), a.teacher.token);
    expect(r.body.attendance.students[0]).toMatchObject({ present: 0, absent: 1 });
  });
});

describe('who may take or read it', () => {
  test('families and counsellors cannot (403)', async () => {
    for (const token of [a.parent.token, a.student.token, psych.token]) {
      expect((await ctx.get(register(a.classId), token)).status).toBe(403);
      expect((await mark(a, TODAY, 'present', token)).status).toBe(403);
    }
  });

  test('another school’s staff reach nothing (404)', async () => {
    expect((await ctx.get(register(a.classId), b.teacher.token)).status).toBe(404);
    expect((await ctx.get(register(a.classId), b.schoolAdmin.token)).status).toBe(404);
    expect((await mark(a, TODAY, 'present', b.teacher.token)).status).toBe(404);
  });

  test('a teacher of another class at the same school reaches nothing (404)', async () => {
    const other = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    expect((await ctx.get(register(a.classId), other.token)).status).toBe(404);
  });
});

describe('what it accepts', () => {
  test('no future days, and corrections up to 30 days back', async () => {
    expect((await mark(a, '2026-11-05', 'present')).status).toBe(400);
    expect((await mark(a, '2026-10-05', 'present')).status).toBe(200);
    expect((await mark(a, '2026-10-04', 'present')).status).toBe(400);
  });

  test('only students of the class, each once', async () => {
    const outsider = await mark(a, TODAY, 'present', a.teacher.token, b.student.id);
    expect(outsider.status).toBe(422);
    const twice = await ctx.send('PUT', `/api/v1/classes/${a.classId}/attendance/${TODAY}`, {
      body: { records: [{ studentId: a.student.id, status: 'present' }, { studentId: a.student.id, status: 'absent' }] },
      token: a.teacher.token,
    });
    expect(twice.status).toBe(400);
    expect((await mark(a, TODAY, 'sick')).status).toBe(400);
  });

  test('reads at most 62 days, never the future, in order', async () => {
    expect((await ctx.get(register(a.classId, '?to=2026-11-05'), a.teacher.token)).status).toBe(400);
    expect((await ctx.get(register(a.classId, '?from=2026-11-04&to=2026-11-01'), a.teacher.token)).status).toBe(400);
    expect((await ctx.get(register(a.classId, '?from=2026-08-01&to=2026-11-01'), a.teacher.token)).status).toBe(400);
    expect((await ctx.get(register(a.classId, '?from=2026-09-04&to=2026-11-04'), a.teacher.token)).status).toBe(200);
  });
});
