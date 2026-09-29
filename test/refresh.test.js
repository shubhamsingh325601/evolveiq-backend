// Integration tests for refresh tokens — real PostgreSQL, requires TEST_DATABASE_URL.
// The database is wiped and re-migrated at the start of this file.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-0123456789';
process.env.JWT_TTL_SECONDS = '3600';
process.env.JWT_REFRESH_TTL_SECONDS = '604800';

const { loadConfig } = await import('../src/config.js');
const { createPool } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');
const { hashSecret } = await import('../src/lib/password.js');

const SCHOOL_A = '11111111-1111-4111-8111-111111111111';
const ADMIN = { email: 'root@evolviq.test', password: 'Root-Password-1' };
const INVALID = { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token.' } };
const enc = (s) => new TextEncoder().encode(s);

let app, db, config, rootToken;

async function post(url, body, token) {
  const res = await app.inject({
    method: 'POST', url, payload: body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}
const login = (b) => post('/api/v1/auth/login', b);
const register = (b, t) => post('/api/v1/auth/register', b, t);
const refresh = (refreshToken) => post('/api/v1/auth/refresh', { refreshToken });

// Build a refresh-shaped JWT with any override, to probe each verification rule.
async function craft({ secret = process.env.JWT_REFRESH_SECRET, alg = 'HS256', iss, aud, exp, sub, jti } = {}) {
  const t = new SignJWT({})
    .setProtectedHeader({ alg })
    .setSubject(sub ?? randomUUID())
    .setJti(jti ?? randomUUID())
    .setIssuer(iss ?? config.jwt.issuer)
    .setAudience(aud ?? config.jwt.audience)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
    .setExpirationTime(exp ?? '1h');
  return t.sign(enc(secret));
}

async function newTeacher(tag) {
  const creds = { email: `${tag}@evolviq.test`, password: 'Teacher-Pass-123' };
  const r = await register({ role: 'teacher', fullName: tag, schoolId: SCHOOL_A, ...creds }, rootToken);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const l = await login(creds);
  assert.equal(l.status, 200);
  return { id: r.body.user.id, creds, login: l.body };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL');
  config = loadConfig();
  db = createPool(config);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(f, dir), 'utf8'));
  }
  await db.query(await readFile(new URL('../db/seed.dev.sql', import.meta.url), 'utf8'));
  await db.query(
    `INSERT INTO users (role, full_name, email, secret_hash) VALUES ('platform_admin', 'Root', $1, $2)`,
    [ADMIN.email, await hashSecret(ADMIN.password)],
  );
  app = await buildApp({ config, db });
  rootToken = (await login(ADMIN)).body.accessToken;
});

after(async () => {
  await app?.close();
  await db?.end();
});

// ─────────────────────── Login response & token contents ───────────────────────
describe('login issues a refresh token (existing behaviour preserved)', () => {
  test('login keeps every existing field and adds refreshToken + refreshExpiresIn', async () => {
    const r = await login(ADMIN);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(),
      ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType', 'user']);
    assert.equal(r.body.tokenType, 'Bearer');
    assert.equal(r.body.expiresIn, 3600);
    assert.equal(r.body.refreshExpiresIn, 604800);
    assert.deepEqual(Object.keys(r.body.user).sort(), ['fullName', 'id', 'role', 'schoolId']);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('access-token claims are unchanged; refresh token carries only sub/jti/iss/aud/iat/exp', async () => {
    const { login: body, id } = await newTeacher('claims');
    const access = decodeJwt(body.accessToken);
    assert.deepEqual(Object.keys(access).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'role', 'sid', 'sub']);
    assert.equal(access.role, 'teacher');
    assert.equal(access.sid, SCHOOL_A);

    const rt = decodeJwt(body.refreshToken);
    assert.deepEqual(Object.keys(rt).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    assert.equal(rt.sub, id);
    assert.equal(rt.exp - rt.iat, 604800);
    assert.equal(decodeProtectedHeader(body.refreshToken).alg, 'HS256');
    assert.ok(!body.refreshToken.includes('Teacher-Pass-123'));
  });

  test('only the JTI is stored — never the raw token — with matching expiry', async () => {
    const { login: body, id } = await newTeacher('storage');
    const { jti, exp } = decodeJwt(body.refreshToken);
    const { rows } = await db.query(
      `SELECT jti, family_id, extract(epoch FROM expires_at)::bigint AS exp, revoked_at
       FROM refresh_tokens WHERE user_id = $1`, [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jti, jti);
    assert.equal(rows[0].family_id, jti);
    assert.equal(Number(rows[0].exp), exp);
    assert.equal(rows[0].revoked_at, null);
    const { rows: all } = await db.query('SELECT row_to_json(r)::text AS j FROM refresh_tokens r');
    assert.ok(all.every((r) => !r.j.includes(body.refreshToken.split('.')[2])));
  });

  test('student login also gets a refresh token', async () => {
    const r = await register({ role: 'student', fullName: 'Kid', studentId: 'R-1', pin: '482913', schoolId: SCHOOL_A }, rootToken);
    assert.equal(r.status, 201);
    const l = await login({ studentId: 'r-1', pin: '482913' });
    assert.equal(l.status, 200);
    assert.equal(typeof l.body.refreshToken, 'string');
  });

  test('failed and locked logins create no refresh-token rows', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n;
    assert.equal((await login({ email: ADMIN.email, password: 'wrong-password' })).status, 401);
    assert.equal((await login({ email: 'nobody@evolviq.test', password: 'wrong-password' })).status, 401);
    const after = (await db.query('SELECT count(*)::int AS n FROM refresh_tokens')).rows[0].n;
    assert.equal(after, before);
    await db.query('UPDATE users SET failed_login_attempts = 0 WHERE email = $1', [ADMIN.email]);
  });
});

// ─────────────────────────────── Successful refresh ─────────────────────────────
describe('POST /refresh — success', () => {
  test('returns a new access token and a rotated refresh token', async () => {
    const { login: body, id } = await newTeacher('ok');
    const r = await refresh(body.refreshToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(),
      ['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType']);
    assert.equal(r.body.tokenType, 'Bearer');
    assert.equal(r.body.expiresIn, 3600);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.notEqual(r.body.refreshToken, body.refreshToken);

    const access = decodeJwt(r.body.accessToken);
    assert.equal(access.sub, id);
    assert.equal(access.role, 'teacher');
    assert.equal(access.sid, SCHOOL_A);

    // Old row revoked, new row in the same family.
    const oldJti = decodeJwt(body.refreshToken).jti;
    const newJti = decodeJwt(r.body.refreshToken).jti;
    const { rows } = await db.query(
      'SELECT jti, family_id, revoked_at FROM refresh_tokens WHERE jti = ANY($1::uuid[]) ORDER BY created_at',
      [[oldJti, newJti]]);
    assert.equal(rows.length, 2);
    assert.ok(rows.find((x) => x.jti === oldJti).revoked_at);
    assert.equal(rows.find((x) => x.jti === newJti).revoked_at, null);
    assert.equal(rows[0].family_id, rows[1].family_id);
  });

  test('refreshed access token is accepted by an existing protected endpoint', async () => {
    const r = await refresh((await login(ADMIN)).body.refreshToken);
    assert.equal(r.status, 200);
    const created = await register(
      { role: 'psychologist', fullName: 'Via Refresh', email: 'via.refresh@evolviq.test', password: 'Psych-Pass-123' },
      r.body.accessToken);
    assert.equal(created.status, 201);
  });

  test('the rotated token can itself be refreshed (chain of 3)', async () => {
    let token = (await newTeacher('chain')).login.refreshToken;
    for (let i = 0; i < 3; i++) {
      const r = await refresh(token);
      assert.equal(r.status, 200);
      token = r.body.refreshToken;
    }
  });

  test('new access token reflects the user\'s CURRENT role/school, not the old token', async () => {
    const { login: body, id } = await newTeacher('promoted');
    await db.query(`UPDATE users SET role = 'school_admin' WHERE id = $1`, [id]);
    const r = await refresh(body.refreshToken);
    assert.equal(decodeJwt(r.body.accessToken).role, 'school_admin');
  });
});

// ─────────────────────────────── Rejections ─────────────────────────────────────
describe('POST /refresh — invalid tokens (all → 401 INVALID_REFRESH_TOKEN)', () => {
  test('garbage / empty-signature / truncated token', async () => {
    const good = (await login(ADMIN)).body.refreshToken;
    for (const t of ['not-a-jwt', 'a.b.c', good.slice(0, -5), `${good.split('.').slice(0, 2).join('.')}.`]) {
      const r = await refresh(t);
      assert.equal(r.status, 401, t);
      assert.deepEqual(r.body, INVALID);
    }
  });

  test('expired token (JWT exp in the past)', async () => {
    const { login: body, id } = await newTeacher('expired');
    const { jti } = decodeJwt(body.refreshToken);
    const t = await craft({ sub: id, jti, exp: Math.floor(Date.now() / 1000) - 60 });
    assert.deepEqual((await refresh(t)).body, INVALID);
  });

  test('expired in the database even though the JWT is still valid', async () => {
    const { login: body } = await newTeacher('dbexpired');
    const { jti } = decodeJwt(body.refreshToken);
    await db.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE jti = $1`, [jti]);
    assert.deepEqual((await refresh(body.refreshToken)).body, INVALID);
  });

  test('wrong signing secret — including the ACCESS-token secret', async () => {
    const { login: body, id } = await newTeacher('wrongsecret');
    const { jti } = decodeJwt(body.refreshToken);
    const other = await craft({ sub: id, jti, secret: 'a-completely-different-secret-of-sufficient-length' });
    const accessSecret = await craft({ sub: id, jti, secret: process.env.JWT_SECRET });
    assert.deepEqual((await refresh(other)).body, INVALID);
    assert.deepEqual((await refresh(accessSecret)).body, INVALID);
    // An access token cannot be used as a refresh token…
    assert.deepEqual((await refresh(body.accessToken)).body, INVALID);
    // …and a refresh token cannot be used as an access token.
    const asBearer = await register(
      { role: 'student', fullName: 'X', studentId: 'X-9', pin: '123456', schoolId: SCHOOL_A }, body.refreshToken);
    assert.equal(asBearer.status, 401);
  });

  test('wrong algorithm (HS512 with the right secret, and alg=none)', async () => {
    const { login: body, id } = await newTeacher('wrongalg');
    const { jti } = decodeJwt(body.refreshToken);
    const hs512 = await craft({ sub: id, jti, alg: 'HS512' });
    assert.deepEqual((await refresh(hs512)).body, INVALID);
    const [, payload] = body.refreshToken.split('.');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    assert.deepEqual((await refresh(none)).body, INVALID);
  });

  test('wrong issuer and wrong audience', async () => {
    const { login: body, id } = await newTeacher('wrongissaud');
    const { jti } = decodeJwt(body.refreshToken);
    assert.deepEqual((await refresh(await craft({ sub: id, jti, iss: 'someone-else' }))).body, INVALID);
    assert.deepEqual((await refresh(await craft({ sub: id, jti, aud: 'another-app' }))).body, INVALID);
    // The genuine token still works afterwards — the forged attempts didn't revoke it.
    assert.equal((await refresh(body.refreshToken)).status, 200);
  });

  test('validly signed but unknown JTI, mismatched sub, or non-UUID claims', async () => {
    const { login: body } = await newTeacher('unknownjti');
    const { sub, jti } = decodeJwt(body.refreshToken);
    assert.deepEqual((await refresh(await craft({ sub }))).body, INVALID);                    // unknown jti
    assert.deepEqual((await refresh(await craft({ sub: randomUUID(), jti }))).body, INVALID); // wrong user
    assert.deepEqual((await refresh(await craft({ sub: 'x', jti: 'y' }))).body, INVALID);     // not UUIDs
  });

  test('missing required claims (no jti)', async () => {
    const t = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(randomUUID())
      .setIssuer(config.jwt.issuer).setAudience(config.jwt.audience).setIssuedAt().setExpirationTime('1h')
      .sign(enc(process.env.JWT_REFRESH_SECRET));
    assert.deepEqual((await refresh(t)).body, INVALID);
  });

  test('request validation → 400 VALIDATION_ERROR', async () => {
    for (const payload of [{}, { refreshToken: '' }, { refreshToken: 123 }, { refreshToken: 'x', extra: 1 },
      { refreshToken: 'x'.repeat(2049) }]) {
      const r = await post('/api/v1/auth/refresh', payload);
      assert.equal(r.status, 400, JSON.stringify(payload));
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    }
  });
});

describe('POST /refresh — user state and revocation', () => {
  test('deactivated user → 403 ACCOUNT_DISABLED, and the token is revoked', async () => {
    const { login: body, id } = await newTeacher('deactivated');
    await db.query('UPDATE users SET is_active = false WHERE id = $1', [id]);
    const r = await refresh(body.refreshToken);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'ACCOUNT_DISABLED');
    // Reactivating does not resurrect the presented token.
    await db.query('UPDATE users SET is_active = true WHERE id = $1', [id]);
    assert.deepEqual((await refresh(body.refreshToken)).body, INVALID);
  });

  test('deleted user → 401 (tokens cascade-deleted)', async () => {
    const { login: body, id } = await newTeacher('deleted');
    await db.query('DELETE FROM users WHERE id = $1', [id]);
    assert.deepEqual((await refresh(body.refreshToken)).body, INVALID);
  });

  test('revoked refresh token → 401', async () => {
    const { login: body } = await newTeacher('revoked');
    const { jti } = decodeJwt(body.refreshToken);
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE jti = $1', [jti]);
    assert.deepEqual((await refresh(body.refreshToken)).body, INVALID);
  });

  test('reuse of a rotated token → 401 and the whole family is revoked', async () => {
    const { login: body } = await newTeacher('reuse');
    const first = await refresh(body.refreshToken);             // R1 → R2
    assert.equal(first.status, 200);
    assert.deepEqual((await refresh(body.refreshToken)).body, INVALID); // replay R1
    assert.deepEqual((await refresh(first.body.refreshToken)).body, INVALID); // R2 now dead too
    const family = decodeJwt(body.refreshToken).jti;
    const { rows } = await db.query(
      'SELECT count(*)::int AS live FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL', [family]);
    assert.equal(rows[0].live, 0);
  });

  test('reuse revokes only that family — the same user\'s other sessions survive', async () => {
    const t = await newTeacher('twosessions');
    const other = (await login(t.creds)).body.refreshToken;      // second, independent login
    assert.equal((await refresh(t.login.refreshToken)).status, 200);
    await refresh(t.login.refreshToken);                          // replay → revoke family 1
    assert.equal((await refresh(other)).status, 200);             // family 2 unaffected
  });

  test('concurrent use of one token: exactly one rotation wins', async () => {
    const { login: body } = await newTeacher('concurrent');
    const results = await Promise.all(Array.from({ length: 10 }, () => refresh(body.refreshToken)));
    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 1, results.map((r) => r.status).join(','));
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 401));
    // The losers are replays, so the family (including the winner's new token) is revoked.
    assert.deepEqual((await refresh(ok[0].body.refreshToken)).body, INVALID);
  });

  test('expired-but-not-revoked token does NOT trigger family revocation', async () => {
    const t = await newTeacher('expirednorevoke');
    const r = await refresh(t.login.refreshToken);                // R1 → R2 (same family)
    const { jti } = decodeJwt(r.body.refreshToken);
    const craftedOldExpired = await craft({ sub: t.id, jti: decodeJwt(t.login.refreshToken).jti, exp: Math.floor(Date.now() / 1000) - 1 });
    await refresh(craftedOldExpired);                             // rejected by JWT exp, no DB work
    const { rows } = await db.query('SELECT revoked_at FROM refresh_tokens WHERE jti = $1', [jti]);
    assert.equal(rows[0].revoked_at, null);
  });
});

// ─────────────────────────────── Configuration ─────────────────────────────────
describe('configuration validation', () => {
  const withEnv = (patch, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete process.env[k];
    try { return fn(); } finally { process.env = saved; }
  };

  test('JWT_REFRESH_SECRET is required', () => {
    assert.throws(() => withEnv({ JWT_REFRESH_SECRET: undefined }, loadConfig), /JWT_REFRESH_SECRET/);
  });
  test('JWT_REFRESH_SECRET must be ≥ 32 bytes', () => {
    assert.throws(() => withEnv({ JWT_REFRESH_SECRET: 'short' }, loadConfig), /at least 32 bytes/);
  });
  test('JWT_REFRESH_SECRET must differ from JWT_SECRET', () => {
    assert.throws(() => withEnv({ JWT_REFRESH_SECRET: process.env.JWT_SECRET }, loadConfig), /different/);
  });
  test('JWT_REFRESH_TTL_SECONDS must be an integer in range and greater than the access TTL', () => {
    assert.throws(() => withEnv({ JWT_REFRESH_TTL_SECONDS: 'abc' }, loadConfig), /JWT_REFRESH_TTL_SECONDS/);
    assert.throws(() => withEnv({ JWT_REFRESH_TTL_SECONDS: '99999999' }, loadConfig), /JWT_REFRESH_TTL_SECONDS/);
    assert.throws(() => withEnv({ JWT_REFRESH_TTL_SECONDS: '1800', JWT_TTL_SECONDS: '3600' }, loadConfig), /greater than/);
    assert.equal(withEnv({ JWT_REFRESH_TTL_SECONDS: '86400' }, loadConfig).jwt.refresh.ttlSeconds, 86400);
  });
});
