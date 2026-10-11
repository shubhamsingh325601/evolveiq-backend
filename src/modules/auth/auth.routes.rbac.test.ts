// /api/v1/auth/register is protected by the SHARED RBAC guard (not a route-local check).
// The guard runs in onRequest — before body validation and before the service — so a
// non-registrar is rejected with 403 even when the body is invalid. Without the guard, the
// same request would reach validation and return 400.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

let ctx: TestContext;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestContext();
  tokens.platform_admin = (await ctx.login(ADMIN)).body.accessToken;
  const pw = 'Role-Password-1';
  const root = tokens.platform_admin!;
  tokens.school_admin = (await createAndLogin(ctx, root, { role: 'school_admin', fullName: 'SA', email: 'rb.sa@evolviq.test', password: pw, schoolId: SCHOOL_A })).token;
  tokens.teacher = (await createAndLogin(ctx, root, { role: 'teacher', fullName: 'T', email: 'rb.t@evolviq.test', password: pw, schoolId: SCHOOL_A })).token;
  tokens.parent = (await createAndLogin(ctx, root, { role: 'parent', fullName: 'P', email: 'rb.p@evolviq.test', password: pw, schoolId: SCHOOL_A })).token;
  tokens.psychologist = (await createAndLogin(ctx, root, { role: 'psychologist', fullName: 'Ps', email: 'rb.ps@evolviq.test', password: pw })).token;
  tokens.student = (await createAndLogin(ctx, root, { role: 'student', fullName: 'S', studentId: 'RB-1', pin: '135792', schoolId: SCHOOL_A })).token;
});

afterAll(async () => {
  await ctx?.close();
});

describe('POST /api/v1/auth/register — shared RBAC guard', () => {
  test.each(['teacher', 'parent', 'psychologist', 'student'])(
    '%s is stopped by the guard (403) before validation, even with an invalid body',
    async (role) => {
      const r = await ctx.register({}, tokens[role]);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: { code: 'FORBIDDEN', message: 'You are not allowed to perform this action.' } });
    },
  );

  test.each(['platform_admin', 'school_admin'])('%s passes the guard (invalid body → 400 from validation)', async (role) => {
    const r = await ctx.register({}, tokens[role]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('unauthenticated → 401 before anything else', async () => {
    expect((await ctx.register({})).status).toBe(401);
  });

  test('existing per-target rules still apply after the guard (School Admin → psychologist = 403 with the specific message)', async () => {
    const r = await ctx.register(
      { role: 'psychologist', fullName: 'X', email: 'rb.x@evolviq.test', password: 'Password-XX-1' },
      tokens.school_admin,
    );
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('Your role cannot create psychologist accounts.');
  });

  test('registrars still create accounts (201)', async () => {
    const r = await ctx.register(
      { role: 'teacher', fullName: 'New T', email: 'rb.new@evolviq.test', password: 'Teacher-Pass-1' },
      tokens.school_admin,
    );
    expect(r.status).toBe(201);
    expect(r.body.user.schoolId).toBe(SCHOOL_A);
  });
});
