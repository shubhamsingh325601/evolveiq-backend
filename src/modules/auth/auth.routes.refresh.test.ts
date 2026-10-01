// Refresh-token API integration tests (ported 1:1 from the previous node:test suite;
// every case and assertion is preserved — the configuration cases now live in src/config.test.ts). Supertest over HTTP against a real PostgreSQL.
import { randomUUID } from 'node:crypto';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

const INVALID = { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token.' } };
const enc = (s: string) => new TextEncoder().encode(s);

let ctx: TestContext;
let rootToken: string;

const login = (b: unknown) => ctx.login(b);
const register = (b: unknown, t?: string) => ctx.register(b, t);
const refresh = (refreshToken: unknown) => ctx.post('/api/v1/auth/refresh', { refreshToken });

// Build a refresh-shaped JWT with any override, to probe each verification rule.
async function craft(o: {
  secret?: string; alg?: string; iss?: string; aud?: string; exp?: number | string; sub?: string; jti?: string;
} = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: o.alg ?? 'HS256' })
    .setSubject(o.sub ?? randomUUID())
    .setJti(o.jti ?? randomUUID())
    .setIssuer(o.iss ?? ctx.config.jwt.issuer)
    .setAudience(o.aud ?? ctx.config.jwt.audience)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
    .setExpirationTime(o.exp ?? '1h')
    .sign(enc(o.secret ?? process.env.JWT_REFRESH_SECRET!));
}

async function newTeacher(tag: string) {
  const creds = { email: `${tag}@evolviq.test`, password: 'Teacher-Pass-123' };
  const r = await register({ role: 'teacher', fullName: tag, schoolId: SCHOOL_A, ...creds }, rootToken);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const l = await login(creds);
  expect(l.status).toBe(200);
  return { id: r.body.user.id as string, creds, login: l.body };
}

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await login(ADMIN)).body.accessToken;
});

afterAll(async () => {
  await ctx?.close();
});

// ─────────────────────── Login response & token contents ───────────────────────
describe('login issues a refresh token (existing behaviour preserved)', () => {
  test('login keeps every existing field and adds refreshToken + refreshExpiresIn', async () => {
    const r = await login(ADMIN);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(
      ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType', 'user']);
    expect(r.body.tokenType).toBe('Bearer');
    expect(r.body.expiresIn).toBe(3600);
    expect(r.body.refreshExpiresIn).toBe(604800);
    expect(Object.keys(r.body.user).sort()).toEqual(['fullName', 'id', 'role', 'schoolId']);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('access-token claims are unchanged; refresh token carries only sub/jti/iss/aud/iat/exp', async () => {
    const { login: body, id } = await newTeacher('claims');
    const access = decodeJwt(body.accessToken);
    expect(Object.keys(access).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sid', 'sub']);
    expect(access.role).toBe('teacher');
    expect(access.sid).toBe(SCHOOL_A);

    const rt = decodeJwt(body.refreshToken);
    expect(Object.keys(rt).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    expect(rt.sub).toBe(id);
    expect(rt.exp! - rt.iat!).toBe(604800);
    expect(decodeProtectedHeader(body.refreshToken).alg).toBe('HS256');
    expect(body.refreshToken).not.toContain('Teacher-Pass-123');
  });

  test('only the JTI is stored — never the raw token — with matching expiry', async () => {
    const { login: body, id } = await newTeacher('storage');
    const { jti, exp } = decodeJwt(body.refreshToken);
    const { rows } = await ctx.pg.query(
      `SELECT jti, family_id, extract(epoch FROM expires_at)::bigint AS exp, revoked_at
       FROM refresh_tokens WHERE user_id = $1`, [id]);
    expect(rows.length).toBe(1);
    expect(rows[0].jti).toBe(jti);
    expect(rows[0].family_id).toBe(jti);
    expect(Number(rows[0].exp)).toBe(exp);
    expect(rows[0].revoked_at).toBe(null);
    const { rows: all } = await ctx.pg.query('SELECT row_to_json(r)::text AS j FROM refresh_tokens r');
    expect(all.every((r: { j: string }) => !r.j.includes(body.refreshToken.split('.')[2]))).toBe(true);
  });

  test('student login also gets a refresh token', async () => {
    const r = await register({ role: 'student', fullName: 'Kid', studentId: 'R-1', pin: '482913', schoolId: SCHOOL_A }, rootToken);
    expect(r.status).toBe(201);
    const l = await login({ studentId: 'r-1', pin: '482913' });
    expect(l.status).toBe(200);
    expect(typeof l.body.refreshToken).toBe('string');
  });

  test('failed and locked logins create no refresh-token rows', async () => {
    const before = (await ctx.pg.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n;
    expect((await login({ email: ADMIN.email, password: 'wrong-password' })).status).toBe(401);
    expect((await login({ email: 'nobody@evolviq.test', password: 'wrong-password' })).status).toBe(401);
    const after = (await ctx.pg.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n;
    expect(after).toBe(before);
    await ctx.pg.query('UPDATE users SET failed_login_attempts = 0 WHERE email = $1', [ADMIN.email]);
  });
});

// ─────────────────────────────── Successful refresh ─────────────────────────────
describe('POST /refresh — success', () => {
  test('returns a new access token and a rotated refresh token', async () => {
    const { login: body, id } = await newTeacher('ok');
    const r = await refresh(body.refreshToken);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(
      ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType']);
    expect(r.body.tokenType).toBe('Bearer');
    expect(r.body.expiresIn).toBe(3600);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.refreshToken).not.toBe(body.refreshToken);

    const access = decodeJwt(r.body.accessToken);
    expect(access.sub).toBe(id);
    expect(access.role).toBe('teacher');
    expect(access.sid).toBe(SCHOOL_A);

    // Old row revoked, new row in the same family.
    const oldJti = decodeJwt(body.refreshToken).jti;
    const newJti = decodeJwt(r.body.refreshToken).jti;
    const { rows } = await ctx.pg.query(
      'SELECT jti, family_id, revoked_at FROM refresh_tokens WHERE jti = ANY($1::uuid[]) ORDER BY created_at',
      [[oldJti, newJti]]);
    expect(rows.length).toBe(2);
    expect(rows.find((x: { jti: string }) => x.jti === oldJti).revoked_at).toBeTruthy();
    expect(rows.find((x: { jti: string }) => x.jti === newJti).revoked_at).toBe(null);
    expect(rows[0].family_id).toBe(rows[1].family_id);
  });

  test('refreshed access token is accepted by an existing protected endpoint', async () => {
    const r = await refresh((await login(ADMIN)).body.refreshToken);
    expect(r.status).toBe(200);
    const created = await register(
      { role: 'psychologist', fullName: 'Via Refresh', email: 'via.refresh@evolviq.test', password: 'Psych-Pass-123' },
      r.body.accessToken);
    expect(created.status).toBe(201);
  });

  test('the rotated token can itself be refreshed (chain of 3)', async () => {
    let token = (await newTeacher('chain')).login.refreshToken;
    for (let i = 0; i < 3; i++) {
      const r = await refresh(token);
      expect(r.status).toBe(200);
      token = r.body.refreshToken;
    }
  });

  test("new access token reflects the user's CURRENT role/school, not the old token", async () => {
    const { login: body, id } = await newTeacher('promoted');
    await ctx.pg.query(`UPDATE users SET role = 'school_admin' WHERE id = $1`, [id]);
    const r = await refresh(body.refreshToken);
    expect(decodeJwt(r.body.accessToken).role).toBe('school_admin');
  });
});

// ─────────────────────────────── Rejections ─────────────────────────────────────
describe('POST /refresh — invalid tokens (all → 401 INVALID_REFRESH_TOKEN)', () => {
  test('garbage / empty-signature / truncated token', async () => {
    const good: string = (await login(ADMIN)).body.refreshToken;
    for (const t of ['not-a-jwt', 'a.b.c', good.slice(0, -5), `${good.split('.').slice(0, 2).join('.')}.`]) {
      const r = await refresh(t);
      expect(r.status, t).toBe(401);
      expect(r.body).toEqual(INVALID);
    }
  });

  test('expired token (JWT exp in the past)', async () => {
    const { login: body, id } = await newTeacher('expired');
    const { jti } = decodeJwt(body.refreshToken);
    const t = await craft({ sub: id, jti: jti!, exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await refresh(t)).body).toEqual(INVALID);
  });

  test('expired in the database even though the JWT is still valid', async () => {
    const { login: body } = await newTeacher('dbexpired');
    const { jti } = decodeJwt(body.refreshToken);
    await ctx.pg.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE jti = $1`, [jti]);
    expect((await refresh(body.refreshToken)).body).toEqual(INVALID);
  });

  test('wrong signing secret — including the ACCESS-token secret', async () => {
    const { login: body, id } = await newTeacher('wrongsecret');
    const { jti } = decodeJwt(body.refreshToken);
    const other = await craft({ sub: id, jti: jti!, secret: 'a-completely-different-secret-of-sufficient-length' });
    const accessSecret = await craft({ sub: id, jti: jti!, secret: process.env.JWT_ACCESS_SECRET! });
    expect((await refresh(other)).body).toEqual(INVALID);
    expect((await refresh(accessSecret)).body).toEqual(INVALID);
    // An access token cannot be used as a refresh token…
    expect((await refresh(body.accessToken)).body).toEqual(INVALID);
    // …and a refresh token cannot be used as an access token.
    const asBearer = await register(
      { role: 'student', fullName: 'X', studentId: 'X-9', pin: '123456', schoolId: SCHOOL_A }, body.refreshToken);
    expect(asBearer.status).toBe(401);
  });

  test('wrong algorithm (HS512 with the right secret, and alg=none)', async () => {
    const { login: body, id } = await newTeacher('wrongalg');
    const { jti } = decodeJwt(body.refreshToken);
    const hs512 = await craft({ sub: id, jti: jti!, alg: 'HS512' });
    expect((await refresh(hs512)).body).toEqual(INVALID);
    const [, payload] = body.refreshToken.split('.');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    expect((await refresh(none)).body).toEqual(INVALID);
  });

  test('wrong issuer and wrong audience', async () => {
    const { login: body, id } = await newTeacher('wrongissaud');
    const { jti } = decodeJwt(body.refreshToken);
    expect((await refresh(await craft({ sub: id, jti: jti!, iss: 'someone-else' }))).body).toEqual(INVALID);
    expect((await refresh(await craft({ sub: id, jti: jti!, aud: 'another-app' }))).body).toEqual(INVALID);
    // The genuine token still works afterwards — the forged attempts didn't revoke it.
    expect((await refresh(body.refreshToken)).status).toBe(200);
  });

  test('validly signed but unknown JTI, mismatched sub, or non-UUID claims', async () => {
    const { login: body } = await newTeacher('unknownjti');
    const { sub, jti } = decodeJwt(body.refreshToken);
    expect((await refresh(await craft({ sub: sub! }))).body).toEqual(INVALID);                    // unknown jti
    expect((await refresh(await craft({ sub: randomUUID(), jti: jti! }))).body).toEqual(INVALID); // wrong user
    expect((await refresh(await craft({ sub: 'x', jti: 'y' }))).body).toEqual(INVALID);           // not UUIDs
  });

  test('missing required claims (no jti)', async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(randomUUID())
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience).setIssuedAt().setExpirationTime('1h')
      .sign(enc(process.env.JWT_REFRESH_SECRET!));
    expect((await refresh(t)).body).toEqual(INVALID);
  });

  test('request validation → 400 VALIDATION_ERROR', async () => {
    for (const payload of [{}, { refreshToken: '' }, { refreshToken: 123 }, { refreshToken: 'x', extra: 1 },
      { refreshToken: 'x'.repeat(2049) }]) {
      const r = await ctx.post('/api/v1/auth/refresh', payload);
      expect(r.status, JSON.stringify(payload)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('POST /refresh — user state and revocation', () => {
  test('deactivated user → 403 ACCOUNT_DISABLED, and the token is revoked', async () => {
    const { login: body, id } = await newTeacher('deactivated');
    await ctx.pg.query('UPDATE users SET is_active = false WHERE id = $1', [id]);
    const r = await refresh(body.refreshToken);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_DISABLED');
    // Reactivating does not resurrect the presented token.
    await ctx.pg.query('UPDATE users SET is_active = true WHERE id = $1', [id]);
    expect((await refresh(body.refreshToken)).body).toEqual(INVALID);
  });

  test('deleted user → 401 (tokens cascade-deleted)', async () => {
    const { login: body, id } = await newTeacher('deleted');
    await ctx.pg.query('DELETE FROM users WHERE id = $1', [id]);
    expect((await refresh(body.refreshToken)).body).toEqual(INVALID);
  });

  test('revoked refresh token → 401', async () => {
    const { login: body } = await newTeacher('revoked');
    const { jti } = decodeJwt(body.refreshToken);
    await ctx.pg.query('UPDATE refresh_tokens SET revoked_at = now() WHERE jti = $1', [jti]);
    expect((await refresh(body.refreshToken)).body).toEqual(INVALID);
  });

  test('reuse of a rotated token → 401 and the whole family is revoked', async () => {
    const { login: body } = await newTeacher('reuse');
    const first = await refresh(body.refreshToken);              // R1 → R2
    expect(first.status).toBe(200);
    expect((await refresh(body.refreshToken)).body).toEqual(INVALID);       // replay R1
    expect((await refresh(first.body.refreshToken)).body).toEqual(INVALID); // R2 now dead too
    const family = decodeJwt(body.refreshToken).jti;
    const { rows } = await ctx.pg.query(
      'SELECT count(*)::int AS live FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL', [family]);
    expect(rows[0].live).toBe(0);
  });

  test("reuse revokes only that family — the same user's other sessions survive", async () => {
    const t = await newTeacher('twosessions');
    const other = (await login(t.creds)).body.refreshToken;      // second, independent login
    expect((await refresh(t.login.refreshToken)).status).toBe(200);
    await refresh(t.login.refreshToken);                          // replay → revoke family 1
    expect((await refresh(other)).status).toBe(200);              // family 2 unaffected
  });

  test('concurrent use of one token: exactly one rotation wins', async () => {
    const { login: body } = await newTeacher('concurrent');
    const results = await Promise.all(Array.from({ length: 10 }, () => refresh(body.refreshToken)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length, results.map((r) => r.status).join(',')).toBe(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 401)).toBe(true);
    // The losers are replays, so the family (including the winner's new token) is revoked.
    expect((await refresh(ok[0]!.body.refreshToken)).body).toEqual(INVALID);
  });

  test('expired-but-not-revoked token does NOT trigger family revocation', async () => {
    const t = await newTeacher('expirednorevoke');
    const r = await refresh(t.login.refreshToken);                // R1 → R2 (same family)
    const { jti } = decodeJwt(r.body.refreshToken);
    const craftedOldExpired = await craft({ sub: t.id, jti: decodeJwt(t.login.refreshToken).jti!, exp: Math.floor(Date.now() / 1000) - 1 });
    await refresh(craftedOldExpired);                             // rejected by JWT exp, no DB work
    const { rows } = await ctx.pg.query('SELECT revoked_at FROM refresh_tokens WHERE jti = $1', [jti]);
    expect(rows[0].revoked_at).toBe(null);
  });
});
