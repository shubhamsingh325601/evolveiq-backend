// Setting a new password or PIN for someone who forgot theirs (asked for on 21 Nov 2026):
//   POST /users/:userId/set-password          Platform Admin (anyone), School Admin (own school)
//   POST /family/children/:studentId/set-pin  a parent, for their own child
// Supertest over HTTP against a real PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

let ctx: TestContext;
let rootToken: string;
type Account = { id: string; token: string; refreshToken: string };
let adminA: Account;
let adminA2: Account;
let adminB: Account;
let teacherA: Account;
let psychologist: Account;
let parentA: Account;
let otherParentA: Account;
let studentA: Account;
let teacherB: Account;

const setPassword = (userId: string, body: unknown, token?: string) => ctx.post(`/api/v1/users/${userId}/set-password`, body, token);
const setPin = (studentId: string, body: unknown, token?: string) => ctx.post(`/api/v1/family/children/${studentId}/set-pin`, body, token);

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  const make = (body: Record<string, unknown>) => createAndLogin(ctx, rootToken, body);
  adminA = await make({ role: 'school_admin', fullName: 'Admin A', email: 'sp.admin.a@evolviq.test', password: 'Admin-A-Password-1', schoolId: SCHOOL_A });
  adminA2 = await make({ role: 'school_admin', fullName: 'Admin A2', email: 'sp.admin.a2@evolviq.test', password: 'Admin-A2-Password-1', schoolId: SCHOOL_A });
  adminB = await make({ role: 'school_admin', fullName: 'Admin B', email: 'sp.admin.b@evolviq.test', password: 'Admin-B-Password-1', schoolId: SCHOOL_B });
  teacherA = await make({ role: 'teacher', fullName: 'Teacher A', email: 'sp.teacher.a@evolviq.test', password: 'Teacher-A-Password-1', schoolId: SCHOOL_A });
  teacherB = await make({ role: 'teacher', fullName: 'Teacher B', email: 'sp.teacher.b@evolviq.test', password: 'Teacher-B-Password-1', schoolId: SCHOOL_B });
  psychologist = await make({ role: 'psychologist', fullName: 'Counsellor', email: 'sp.psy@evolviq.test', password: 'Counsellor-Password-1' });
  parentA = await make({ role: 'parent', fullName: 'Parent A', email: 'sp.parent.a@evolviq.test', password: 'Parent-A-Password-1', schoolId: SCHOOL_A });
  otherParentA = await make({ role: 'parent', fullName: 'Other Parent', email: 'sp.parent.o@evolviq.test', password: 'Other-Parent-Password-1', schoolId: SCHOOL_A });
  studentA = await make({ role: 'student', fullName: 'Kid A', studentId: 'SP-1001', pin: '111111', schoolId: SCHOOL_A, parentId: parentA.id });
});

afterAll(async () => {
  await ctx?.close();
});

describe('POST /users/:userId/set-password', () => {
  test('only Platform and School Admins may call it', async () => {
    expect((await setPassword(studentA.id, { pin: '222222' })).status).toBe(401);
    for (const caller of [teacherA, psychologist, parentA, studentA]) {
      expect((await setPassword(teacherB.id, { password: 'Brand-New-Password-1' }, caller.token)).status).toBe(403);
    }
  });

  test("School Admin sets a student's PIN: it works at once, the old one doesn't, and their sessions end", async () => {
    const r = await setPassword(studentA.id, { pin: '222222' }, adminA.token);
    expect(r.status).toBe(204);
    expect((await ctx.login({ studentId: 'SP-1001', pin: '111111' })).status).toBe(401);
    expect((await ctx.login({ studentId: 'SP-1001', pin: '222222' })).status).toBe(200);
    expect((await ctx.post('/api/v1/auth/refresh', { refreshToken: studentA.refreshToken })).status).toBe(401);
  });

  test("School Admin sets a teacher's password in their own school, and it clears a lockout", async () => {
    for (let i = 0; i < 5; i++) await ctx.login({ email: 'sp.teacher.a@evolviq.test', password: 'wrong-wrong-wrong' });
    expect((await ctx.login({ email: 'sp.teacher.a@evolviq.test', password: 'Teacher-A-Password-1' })).status).toBe(401); // locked

    expect((await setPassword(teacherA.id, { password: 'Teacher-A-New-Password' }, adminA.token)).status).toBe(204);
    expect((await ctx.login({ email: 'sp.teacher.a@evolviq.test', password: 'Teacher-A-New-Password' })).status).toBe(200);
  });

  test('School Admin: another school, another School Admin or a Counsellor → 404', async () => {
    for (const target of [teacherB, adminA2, adminB, psychologist]) {
      const r = await setPassword(target.id, { password: 'Brand-New-Password-1' }, adminA.token);
      expect(r.status).toBe(404);
    }
    expect((await ctx.login({ email: 'sp.teacher.b@evolviq.test', password: 'Teacher-B-Password-1' })).status).toBe(200);
  });

  test('Platform Admin reaches anyone', async () => {
    expect((await setPassword(adminB.id, { password: 'Admin-B-New-Password' }, rootToken)).status).toBe(204);
    expect((await ctx.login({ email: 'sp.admin.b@evolviq.test', password: 'Admin-B-New-Password' })).status).toBe(200);
  });

  test('your own account → 403', async () => {
    expect((await setPassword(adminA.id, { password: 'Brand-New-Password-1' }, adminA.token)).status).toBe(403);
  });

  test('a password for an adult, a PIN for a student — anything else is 400', async () => {
    const cases: [string, unknown, string][] = [
      [studentA.id, { password: 'Brand-New-Password-1' }, 'pin'],
      [teacherA.id, { pin: '123456' }, 'password'],
      [teacherA.id, { password: 'Brand-New-Password-1', pin: '123456' }, 'body'],
      [teacherA.id, {}, 'body'],
      [teacherA.id, { password: 'short' }, 'password'],
      [studentA.id, { pin: '12345' }, 'pin'],
      [studentA.id, { pin: '123456', role: 'platform_admin' }, 'role'],
    ];
    for (const [userId, body, field] of cases) {
      const r = await setPassword(userId, body, adminA.token);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    }
  });

  test('an unknown user → 404', async () => {
    expect((await setPassword('99999999-9999-4999-8999-999999999999', { pin: '123456' }, rootToken)).status).toBe(404);
  });
});

describe('POST /family/children/:studentId/set-pin', () => {
  test("only parents may call it", async () => {
    expect((await setPin(studentA.id, { pin: '333333' })).status).toBe(401);
    for (const caller of [teacherA, adminA, studentA]) {
      expect((await setPin(studentA.id, { pin: '333333' }, caller.token)).status).toBe(403);
    }
    expect((await ctx.post(`/api/v1/family/children/${studentA.id}/set-pin`, { pin: '333333' }, rootToken)).status).toBe(403);
  });

  test("a parent sets their own child's PIN; the child's sessions end", async () => {
    const kid = await ctx.login({ studentId: 'SP-1001', pin: '222222' });
    expect(kid.status).toBe(200);

    expect((await setPin(studentA.id, { pin: '444444' }, parentA.token)).status).toBe(204);
    expect((await ctx.login({ studentId: 'SP-1001', pin: '222222' })).status).toBe(401);
    expect((await ctx.login({ studentId: 'SP-1001', pin: '444444' })).status).toBe(200);
    expect((await ctx.post('/api/v1/auth/refresh', { refreshToken: kid.body.refreshToken })).status).toBe(401);
  });

  test("another family's child, an adult, or no one → 404", async () => {
    for (const id of [studentA.id]) expect((await setPin(id, { pin: '555555' }, otherParentA.token)).status).toBe(404);
    expect((await setPin(teacherA.id, { pin: '555555' }, parentA.token)).status).toBe(404);
    expect((await setPin('99999999-9999-4999-8999-999999999999', { pin: '555555' }, parentA.token)).status).toBe(404);
    expect((await ctx.login({ studentId: 'SP-1001', pin: '444444' })).status).toBe(200);
  });

  test('the PIN must be 6 digits', async () => {
    for (const body of [{ pin: '12345' }, { pin: 'abcdef' }, {}, { pin: '123456', extra: 1 }]) {
      const r = await setPin(studentA.id, body, parentA.token);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
