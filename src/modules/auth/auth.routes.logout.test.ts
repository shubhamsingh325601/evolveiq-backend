// POST /api/v1/auth/logout — ends the caller's session by revoking its refresh-token family.
// Covers authentication, every role, validation, ownership of the refresh token, isolation
// from the user's other sessions, idempotency and the refresh behaviour afterwards.
import { randomUUID } from 'node:crypto';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const LOGOUT = '/api/v1/auth/logout';
const REFRESH = '/api/v1/auth/refresh';
const PW = 'Logout-Password-1';

let ctx: TestContext;
let rootToken: string;

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
});

afterAll(async () => {
  await ctx?.close();
});

const logout = (refreshToken: unknown, token?: string) => ctx.post(LOGOUT, { refreshToken }, token);
const refresh = (refreshToken: string) => ctx.post(REFRESH, { refreshToken });
const liveTokens = async (userId: string) =>
  (await ctx.pg.query('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0].n as number;

let seq = 0;
async function newTeacher() {
  seq += 1;
  const email = `logout${seq}@evolviq.test`;
  const user = await createAndLogin(ctx, rootToken, { role: 'teacher', fullName: 'Logout T', email, password: PW, schoolId: SCHOOL_A });
  return { ...user, email };
}

describe('authentication and access', () => {
  test('no / garbage access token → 401 UNAUTHENTICATED and nothing is revoked', async () => {
    const t = await newTeacher();
    for (const token of [undefined, 'garbage']) {
      const r = await logout(t.refreshToken, token);
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
    expect(await liveTokens(t.id)).toBe(1);
  });

  test('a refresh token is not accepted as the access token → 401', async () => {
    const t = await newTeacher();
    expect((await logout(t.refreshToken, t.refreshToken)).status).toBe(401);
    expect(await liveTokens(t.id)).toBe(1);
  });

  test.each([
    { role: 'student', fullName: 'S', studentId: 'LO-1', pin: '482913', schoolId: SCHOOL_A },
    { role: 'parent', fullName: 'P', email: 'lo.p@evolviq.test', password: PW, schoolId: SCHOOL_A },
    { role: 'teacher', fullName: 'T', email: 'lo.t@evolviq.test', password: PW, schoolId: SCHOOL_A },
    { role: 'school_admin', fullName: 'SA', email: 'lo.sa@evolviq.test', password: PW, schoolId: SCHOOL_A },
    { role: 'psychologist', fullName: 'Ps', email: 'lo.ps@evolviq.test', password: PW },
    { role: 'platform_admin', fullName: 'PA', email: 'lo.pa@evolviq.test', password: PW },
  ])('$role can log out → 204 with no body', async (body) => {
    const u = await createAndLogin(ctx, rootToken, body);
    const r = await logout(u.refreshToken, u.token);
    expect(r.status).toBe(204);
    expect(r.body).toEqual({});
    expect(await liveTokens(u.id)).toBe(0);
  });

  test('a deactivated user is rejected by authentication (401) like on every protected route', async () => {
    const t = await newTeacher();
    await ctx.pg.query('UPDATE users SET is_active = false WHERE id = $1', [t.id]);
    expect((await logout(t.refreshToken, t.token)).status).toBe(401);
  });
});

describe('validation', () => {
  test.each([
    ['missing refreshToken', {}],
    ['empty refreshToken', { refreshToken: '' }],
    ['non-string refreshToken', { refreshToken: 42 }],
    ['unknown field', { refreshToken: 'x.y.z', everywhere: true }],
  ])('%s → 400 VALIDATION_ERROR', async (_label, body) => {
    const t = await newTeacher();
    const r = await ctx.post(LOGOUT, body, t.token);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(await liveTokens(t.id)).toBe(1);
  });
});

describe('ending the session', () => {
  test('after logout the refresh token can no longer be used → 401 INVALID_REFRESH_TOKEN', async () => {
    const t = await newTeacher();
    expect((await logout(t.refreshToken, t.token)).status).toBe(204);
    const r = await refresh(t.refreshToken);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  test('revokes the whole family: a token rotated from the presented one stops working too', async () => {
    const t = await newTeacher();
    const rotated = (await refresh(t.refreshToken)).body.refreshToken as string;
    // Present the latest token: the family (old + new) is fully revoked.
    expect((await logout(rotated, t.token)).status).toBe(204);
    expect(await liveTokens(t.id)).toBe(0);
    expect((await refresh(rotated)).status).toBe(401);
  });

  test("the user's other sessions stay signed in", async () => {
    const t = await newTeacher();
    const other = (await ctx.login({ email: t.email, password: PW })).body.refreshToken as string;
    expect((await logout(t.refreshToken, t.token)).status).toBe(204);
    expect(await liveTokens(t.id)).toBe(1);
    expect((await refresh(other)).status).toBe(200);
  });

  test('logging out an already-ended session is a no-op → 204', async () => {
    const t = await newTeacher();
    expect((await logout(t.refreshToken, t.token)).status).toBe(204);
    expect((await logout(t.refreshToken, t.token)).status).toBe(204);
    expect(await liveTokens(t.id)).toBe(0);
  });
});

describe('the refresh token must belong to the caller', () => {
  test("another user's refresh token → 401 INVALID_REFRESH_TOKEN and their session survives", async () => {
    const attacker = await newTeacher();
    const victim = await newTeacher();
    const r = await logout(victim.refreshToken, attacker.token);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    expect(await liveTokens(victim.id)).toBe(1);
    expect(await liveTokens(attacker.id)).toBe(1);
    expect((await refresh(victim.refreshToken)).status).toBe(200);
  });

  test('forged, malformed or access-token-shaped refresh tokens → 401, nothing revoked', async () => {
    const t = await newTeacher();
    const { jti } = decodeJwt(t.refreshToken);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' }).setSubject(t.id).setJti(String(jti))
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience).setIssuedAt().setExpirationTime('1h')
      .sign(new TextEncoder().encode('not-the-refresh-secret-not-the-refresh-secret'));
    const nonUuidJti = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' }).setSubject(t.id).setJti('not-a-uuid')
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience).setIssuedAt().setExpirationTime('1h')
      .sign(ctx.config.jwt.refresh.secret);
    for (const token of ['garbage', 'a.b.c', forged, nonUuidJti, t.token]) {
      const r = await logout(token, t.token);
      expect(r.status, token.slice(0, 12)).toBe(401);
      expect(r.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    }
    expect(await liveTokens(t.id)).toBe(1);
  });

  test('a validly signed token for an unknown session → 204, nothing else touched', async () => {
    const t = await newTeacher();
    const unknown = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' }).setSubject(t.id).setJti(randomUUID())
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience).setIssuedAt().setExpirationTime('1h')
      .sign(ctx.config.jwt.refresh.secret);
    expect((await logout(unknown, t.token)).status).toBe(204);
    expect(await liveTokens(t.id)).toBe(1);
  });
});
