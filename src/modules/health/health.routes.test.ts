// Health and care profiles — Supertest over HTTP against the real app + PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const health = (studentId: string) => `/api/v1/students/${studentId}/health`;
const put = (studentId: string, body: unknown, token: string) => ctx.send('PUT', health(studentId), { body, token });

const FULL = {
  conditions: ['asthma', 'on_medication'],
  bloodGroup: 'O+',
  allergies: 'Peanuts',
  medications: 'Inhaler before PE, kept in her bag',
  careNotes: 'Let her sit out if she is short of breath, and call us.',
  emergencyContact: { name: 'Priya', relation: 'Mother', phone: '+91 98450 12345' },
};

describe('a student’s health profile', () => {
  test('reads as empty until something is recorded', async () => {
    const r = await ctx.get(health(a.student.id), a.parent.token);
    expect(r.status).toBe(200);
    expect(r.body.health).toEqual({
      studentId: a.student.id,
      conditions: [],
      bloodGroup: null,
      allergies: null,
      medications: null,
      careNotes: null,
      emergencyContact: null,
      updatedBy: null,
      updatedAt: null,
    });
  });

  test('the parent records it; the teacher, the counsellor and the school admin read it', async () => {
    const saved = await put(a.student.id, FULL, a.parent.token);
    expect(saved.status).toBe(200);
    expect(saved.body.health).toMatchObject({ ...FULL, updatedBy: { role: 'parent' } });
    expect(saved.body.health.updatedAt).toEqual(expect.any(String));

    for (const token of [a.teacher.token, psych.token, a.schoolAdmin.token]) {
      const r = await ctx.get(health(a.student.id), token);
      expect(r.status).toBe(200);
      expect(r.body.health.conditions).toEqual(['asthma', 'on_medication']);
      expect(r.body.health.emergencyContact).toEqual(FULL.emergencyContact);
    }
  });

  test('a write replaces the whole profile', async () => {
    const r = await put(a.student.id, { conditions: ['adhd'] }, a.schoolAdmin.token);
    expect(r.status).toBe(200);
    expect(r.body.health).toMatchObject({
      conditions: ['adhd'],
      bloodGroup: null,
      allergies: null,
      emergencyContact: null,
      updatedBy: { role: 'school_admin' },
    });
  });

  test('teachers, counsellors and students cannot write it; students cannot read it', async () => {
    expect((await put(a.student.id, FULL, a.teacher.token)).status).toBe(403);
    expect((await put(a.student.id, FULL, psych.token)).status).toBe(403);
    expect((await put(a.student.id, FULL, a.student.token)).status).toBe(403);
    expect((await ctx.get(health(a.student.id), a.student.token)).status).toBe(403);
  });

  test('another family or school reaches nothing (404)', async () => {
    expect((await ctx.get(health(a.student.id), b.parent.token)).status).toBe(404);
    expect((await ctx.get(health(a.student.id), b.teacher.token)).status).toBe(404);
    expect((await put(a.student.id, FULL, b.schoolAdmin.token)).status).toBe(404);
    expect((await put(a.student.id, FULL, b.parent.token)).status).toBe(404);
  });

  test('validates what is written', async () => {
    const bad = [
      { conditions: ['asthma', 'asthma'] },
      { conditions: ['broken_leg'] },
      { conditions: [], bloodGroup: 'C+' },
      { conditions: [], emergencyContact: { name: 'Priya', phone: 'call me' } },
      { conditions: [], emergencyContact: { name: '   ', phone: '112' } },
      { conditions: [], allergies: 'x'.repeat(501) },
      { conditions: [], diagnosis: 'anything' },
      {},
    ];
    for (const body of bad) expect((await put(a.student.id, body, a.parent.token)).status).toBe(400);
  });
});

describe('a class’s profiles', () => {
  const classHealth = (classId: string) => `/api/v1/classes/${classId}/health`;

  test('reach the class’s teacher and the school admin, with only recorded students', async () => {
    await put(a.student.id, FULL, a.parent.token);
    for (const token of [a.teacher.token, a.schoolAdmin.token]) {
      const r = await ctx.get(classHealth(a.classId), token);
      expect(r.status).toBe(200);
      expect(r.body.profiles).toHaveLength(1);
      expect(r.body.profiles[0]).toMatchObject({ studentId: a.student.id, conditions: ['asthma', 'on_medication'] });
    }
    const empty = await ctx.get(classHealth(b.classId), b.teacher.token);
    expect(empty.body.profiles).toEqual([]);
  });

  test('another school’s class is not found, and families cannot ask', async () => {
    expect((await ctx.get(classHealth(a.classId), b.teacher.token)).status).toBe(404);
    expect((await ctx.get(classHealth(a.classId), b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.get(classHealth(a.classId), a.parent.token)).status).toBe(403);
    expect((await ctx.get(classHealth(a.classId), psych.token)).status).toBe(403);
  });
});
