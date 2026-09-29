// Integration tests against a real PostgreSQL database.
// Requires TEST_DATABASE_URL (the database is wiped and re-migrated on every run).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-test-refresh-secret-0123456789';
process.env.LOGIN_MAX_ATTEMPTS = '5';
process.env.LOGIN_LOCK_MINUTES = '15';

const { loadConfig } = await import('../src/config.js');
const { createPool } = await import('../src/db.js');
const { buildApp } = await import('../src/app.js');
const { hashSecret } = await import('../src/lib/password.js');

const SCHOOL_A = '11111111-1111-4111-8111-111111111111';
const SCHOOL_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = { email: 'root@evolviq.test', password: 'Root-Password-1' };

let app, db, config, rootToken, schoolAdminA;

async function post(url, body, token, headers = {}) {
  const res = await app.inject({
    method: 'POST', url, payload: body,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers },
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}
const login = (b) => post('/api/v1/auth/login', b);
const register = (b, t) => post('/api/v1/auth/register', b, t);

async function createAndLogin(token, body) {
  const r = await register(body, token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const creds = body.role === 'student'
    ? { studentId: body.studentId, pin: body.pin }
    : { email: body.email, password: body.password };
  const l = await login(creds);
  assert.equal(l.status, 200);
  return { id: r.body.user.id, token: l.body.accessToken };
}

before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL');
  config = loadConfig();
  db = createPool(config);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query(await readFile(new URL('../db/migrations/001_auth.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../db/migrations/002_refresh_tokens.sql', import.meta.url), 'utf8'));
  await db.query(await readFile(new URL('../db/seed.dev.sql', import.meta.url), 'utf8'));
  await db.query(
    `INSERT INTO users (role, full_name, email, secret_hash) VALUES ('platform_admin', 'Root', $1, $2)`,
    [ADMIN.email, await hashSecret(ADMIN.password)],
  );
  app = await buildApp({ config, db });
  rootToken = (await login(ADMIN)).body.accessToken;
  schoolAdminA = await createAndLogin(rootToken, {
    role: 'school_admin', fullName: 'Admin A', email: 'admin.a@evolviq.test',
    password: 'School-Admin-A-1', schoolId: SCHOOL_A,
  });
});

after(async () => {
  await app?.close();
  await db?.end();
});

// ───────────────────────────── LOGIN ─────────────────────────────
describe('POST /login', () => {
  test('success returns a token and only minimal user fields', async () => {
    const r = await login(ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.tokenType, 'Bearer');
    assert.equal(r.body.expiresIn, 3600);
    assert.match(r.body.accessToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(Object.keys(r.body.user).sort(), ['fullName', 'id', 'role', 'schoolId']);
    assert.equal(r.body.user.role, 'platform_admin');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('email is case-insensitive and trimmed', async () => {
    const r = await login({ email: '  ROOT@EvolvIQ.test ', password: ADMIN.password });
    assert.equal(r.status, 200);
  });

  test('wrong password and unknown user return the identical 401', async () => {
    const wrong = await login({ email: ADMIN.email, password: 'nope-nope-nope' });
    const unknown = await login({ email: 'ghost@evolviq.test', password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(wrong.body, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' } });
    await db.query(`UPDATE users SET failed_login_attempts = 0 WHERE email = $1`, [ADMIN.email]);
  });

  test('unknown-user and wrong-password latency are comparable (dummy-hash verify)', async () => {
    const time = async (body) => {
      const t = process.hrtime.bigint();
      await login(body);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const known = [], unknown = [];
    for (let i = 0; i < 4; i++) {
      known.push(await time({ email: ADMIN.email, password: `wrong-${i}` }));
      unknown.push(await time({ email: `ghost${i}@evolviq.test`, password: `wrong-${i}` }));
    }
    await db.query(`UPDATE users SET failed_login_attempts = 0 WHERE email = $1`, [ADMIN.email]);
    // Without the dummy verify, "unknown" would be ~1 ms vs ~25+ ms. Loose bound to avoid flakiness.
    assert.ok(median(unknown) > median(known) * 0.5, `known=${median(known)} unknown=${median(unknown)}`);
  });

  test('validation: empty body, mixed credentials, unknown field, wrong types', async () => {
    for (const body of [
      {},
      { email: ADMIN.email },
      { email: ADMIN.email, password: 'x', studentId: 'S-1', pin: '123456' },
      { email: ADMIN.email, password: 'x', role: 'teacher' },
      { email: 123, password: 'x' },
    ]) {
      const r = await login(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
    }
  });

  test('malformed JSON → 400, wrong content type → 415', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: '{"email":',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(bad.statusCode, 400);
    const txt = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: 'email=a',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(txt.statusCode, 415);
  });

  test('student logs in with student ID + PIN (ID case-insensitive)', async () => {
    await register({ role: 'student', fullName: 'Kid One', studentId: 'a-1001', pin: '482913' }, schoolAdminA.token);
    const r = await login({ studentId: 'A-1001', pin: '482913' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'student');
    assert.equal(r.body.user.schoolId, SCHOOL_A);
    assert.equal((await login({ studentId: 'A-1001', pin: '000000' })).status, 401);
  });

  test('lockout after 5 failures hides even the correct password; resets after expiry', async () => {
    const creds = { email: 'lock@evolviq.test', password: 'Lock-Me-Out-1' };
    await createAndLogin(rootToken, { role: 'teacher', fullName: 'Lock', schoolId: SCHOOL_A, ...creds });
    for (let i = 0; i < 5; i++) {
      assert.equal((await login({ email: creds.email, password: 'wrong-wrong-1' })).status, 401);
    }
    const locked = await login(creds);
    assert.equal(locked.status, 401);
    assert.equal(locked.body.error.code, 'INVALID_CREDENTIALS'); // no "locked" leak

    await db.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1`, [creds.email]);
    assert.equal((await login(creds)).status, 200);
    const { rows } = await db.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE email = $1', [creds.email]);
    assert.deepEqual(rows[0], { failed_login_attempts: 0, locked_until: null });
  });

  test('deactivated user: correct password → 403, wrong password → 401', async () => {
    const creds = { email: 'gone@evolviq.test', password: 'Gone-Gone-Gone-1' };
    await createAndLogin(rootToken, { role: 'psychologist', fullName: 'Gone', ...creds });
    await db.query('UPDATE users SET is_active = false WHERE email = $1', [creds.email]);
    assert.equal((await login(creds)).body.error.code, 'ACCOUNT_DISABLED');
    assert.equal((await login({ ...creds, password: 'wrong-wrong-1' })).status, 401);
  });
});

// ──────────────────────────── REGISTER ───────────────────────────
describe('POST /register — authentication & authorisation', () => {
  test('no token, garbage token, forged token → 401', async () => {
    const body = { role: 'teacher', fullName: 'T', email: 't0@evolviq.test', password: 'Teacher-Pass-1', schoolId: SCHOOL_A };
    assert.equal((await register(body)).status, 401);
    assert.equal((await register(body, 'abc.def.ghi')).status, 401);
    const forged = await new SignJWT({ role: 'platform_admin', sid: null })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('00000000-0000-4000-8000-000000000000')
      .setIssuer(config.jwt.issuer).setAudience(config.jwt.audience).setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-secret-some-other-secret-123'));
    assert.equal((await register(body, forged)).status, 401);
    const noneAlg = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ sub: 'x', role: 'platform_admin' })).toString('base64url')}.`;
    assert.equal((await register(body, noneAlg)).status, 401);
  });

  test('teacher, psychologist, parent and student cannot register anyone → 403', async () => {
    const teacher = await createAndLogin(rootToken, { role: 'teacher', fullName: 'T', email: 't1@evolviq.test', password: 'Teacher-Pass-1', schoolId: SCHOOL_A });
    const psych = await createAndLogin(rootToken, { role: 'psychologist', fullName: 'P', email: 'p1@evolviq.test', password: 'Psych-Pass-1!' });
    const parent = await createAndLogin(rootToken, { role: 'parent', fullName: 'Pa', email: 'pa1@evolviq.test', password: 'Parent-Pass-1', schoolId: SCHOOL_A });
    const student = await createAndLogin(rootToken, { role: 'student', fullName: 'S', studentId: 'S-0001', pin: '123456', schoolId: SCHOOL_A });
    for (const { token } of [teacher, psych, parent, student]) {
      const r = await register({ role: 'student', fullName: 'X', studentId: 'X-1', pin: '111111' }, token);
      assert.equal(r.status, 403);
    }
  });

  test('platform admin can create all six roles', async () => {
    const bodies = [
      { role: 'student', fullName: 'S', studentId: 'PA-S1', pin: '246810', schoolId: SCHOOL_B },
      { role: 'parent', fullName: 'Pa', email: 'pa2@evolviq.test', password: 'Parent-Pass-2', schoolId: SCHOOL_B },
      { role: 'teacher', fullName: 'T', email: 't2@evolviq.test', password: 'Teacher-Pass-2', schoolId: SCHOOL_B },
      { role: 'school_admin', fullName: 'SA', email: 'sa2@evolviq.test', password: 'SchoolAdm-Pass-2', schoolId: SCHOOL_B },
      { role: 'psychologist', fullName: 'Ps', email: 'ps2@evolviq.test', password: 'Psych-Pass-2!' },
      { role: 'platform_admin', fullName: 'PA', email: 'pa-admin2@evolviq.test', password: 'Platform-Pass-2' },
    ];
    for (const b of bodies) {
      const r = await register(b, rootToken);
      assert.equal(r.status, 201, `${b.role}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.user.role, b.role);
      assert.equal(r.body.user.schoolId, b.schoolId ?? null);
      assert.deepEqual(Object.keys(r.body.user).sort(), ['createdAt', 'fullName', 'id', 'parentId', 'role', 'schoolId']);
    }
  });

  test('school admin creates student/teacher/parent in own school (schoolId implied)', async () => {
    for (const b of [
      { role: 'teacher', fullName: 'T', email: 't3@evolviq.test', password: 'Teacher-Pass-3' },
      { role: 'parent', fullName: 'Pa', email: 'pa3@evolviq.test', password: 'Parent-Pass-3' },
      { role: 'student', fullName: 'S', studentId: 'SA-S1', pin: '135790', schoolId: SCHOOL_A },
    ]) {
      const r = await register(b, schoolAdminA.token);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.user.schoolId, SCHOOL_A);
    }
  });

  test('school admin cannot create admins/psychologists or users in another school → 403', async () => {
    for (const b of [
      { role: 'school_admin', fullName: 'X', email: 'x1@evolviq.test', password: 'Password-XX-1' },
      { role: 'psychologist', fullName: 'X', email: 'x2@evolviq.test', password: 'Password-XX-1' },
      { role: 'platform_admin', fullName: 'X', email: 'x3@evolviq.test', password: 'Password-XX-1' },
      { role: 'teacher', fullName: 'X', email: 'x4@evolviq.test', password: 'Password-XX-1', schoolId: SCHOOL_B },
    ]) {
      const r = await register(b, schoolAdminA.token);
      assert.equal(r.status, 403, JSON.stringify(b));
      assert.equal(r.body.error.code, 'FORBIDDEN');
    }
  });

  test('deactivated admin with a still-valid token → 401', async () => {
    const sa = await createAndLogin(rootToken, { role: 'school_admin', fullName: 'Temp', email: 'temp.sa@evolviq.test', password: 'Temp-Admin-Pass', schoolId: SCHOOL_B });
    await db.query('UPDATE users SET is_active = false WHERE id = $1', [sa.id]);
    const r = await register({ role: 'teacher', fullName: 'T', email: 't9@evolviq.test', password: 'Teacher-Pass-9' }, sa.token);
    assert.equal(r.status, 401);
    const { rowCount } = await db.query(`SELECT 1 FROM users WHERE email = 't9@evolviq.test'`);
    assert.equal(rowCount, 0);
  });
});

describe('POST /register — validation', () => {
  const cases = [
    ['unknown role', { role: 'superuser', fullName: 'X', email: 'v@e.test', password: 'Password-XX-1' }, 'role'],
    ['missing role', { fullName: 'X', email: 'v@e.test', password: 'Password-XX-1' }, 'role'],
    ['short password', { role: 'psychologist', fullName: 'X', email: 'v@e.test', password: 'short' }, 'password'],
    ['bad email', { role: 'psychologist', fullName: 'X', email: 'not-an-email', password: 'Password-XX-1' }, 'email'],
    ['blank name', { role: 'psychologist', fullName: '   ', email: 'v@e.test', password: 'Password-XX-1' }, 'fullName'],
    ['control chars in name', { role: 'psychologist', fullName: 'A\u0000B', email: 'v@e.test', password: 'Password-XX-1' }, 'fullName'],
    ['4-digit PIN', { role: 'student', fullName: 'X', studentId: 'V-1', pin: '1234', schoolId: SCHOOL_A }, 'pin'],
    ['student with email', { role: 'student', fullName: 'X', studentId: 'V-1', pin: '123456', email: 'v@e.test', schoolId: SCHOOL_A }, 'email'],
    ['schoolId on psychologist', { role: 'psychologist', fullName: 'X', email: 'v@e.test', password: 'Password-XX-1', schoolId: SCHOOL_A }, 'schoolId'],
    ['parentId on teacher', { role: 'teacher', fullName: 'X', email: 'v@e.test', password: 'Password-XX-1', schoolId: SCHOOL_A, parentId: SCHOOL_A }, 'parentId'],
    ['SQL-ish studentId', { role: 'student', fullName: 'X', studentId: "x'; DROP TABLE users;--", pin: '123456', schoolId: SCHOOL_A }, 'studentId'],
    ['platform admin omits schoolId for teacher', { role: 'teacher', fullName: 'X', email: 'v@e.test', password: 'Password-XX-1' }, 'schoolId'],
  ];
  for (const [name, body, field] of cases) {
    test(name, async () => {
      const r = await register(body, rootToken);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'VALIDATION_ERROR');
      assert.equal(r.body.error.details[0].field, field);
    });
  }
});

describe('POST /register — duplicates, references, storage', () => {
  test('duplicate email (different case) → 409 field=email', async () => {
    const b = { role: 'teacher', fullName: 'D', email: 'dup@evolviq.test', password: 'Dup-Pass-12', schoolId: SCHOOL_A };
    assert.equal((await register(b, rootToken)).status, 201);
    const r = await register({ ...b, email: 'DUP@EvolvIQ.test' }, rootToken);
    assert.equal(r.status, 409);
    assert.deepEqual(r.body.error, { code: 'DUPLICATE_ACCOUNT', message: 'An account with this identifier already exists.', details: { field: 'email' } });
  });

  test('duplicate studentId (different case) → 409 field=studentId', async () => {
    const b = { role: 'student', fullName: 'D', studentId: 'dup-1', pin: '111222' };
    assert.equal((await register(b, schoolAdminA.token)).status, 201);
    const r = await register({ ...b, studentId: 'DUP-1' }, schoolAdminA.token);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.details.field, 'studentId');
  });

  test('race: 20 concurrent identical registrations → exactly one 201', async () => {
    const b = { role: 'parent', fullName: 'R', email: 'race@evolviq.test', password: 'Race-Pass-12', schoolId: SCHOOL_A };
    const results = await Promise.all(Array.from({ length: 20 }, () => register(b, rootToken)));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 409).length, 19);
  });

  test('unknown schoolId → 422', async () => {
    const r = await register({ role: 'teacher', fullName: 'X', email: 'ns@evolviq.test', password: 'Password-XX-1', schoolId: '99999999-9999-4999-8999-999999999999' }, rootToken);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.details.field, 'schoolId');
  });

  test('student ↔ parent link: valid parent 201; other-school parent / non-parent / unknown → 422', async () => {
    const parentA = (await register({ role: 'parent', fullName: 'PA', email: 'link.a@evolviq.test', password: 'Parent-Link-1' }, schoolAdminA.token)).body.user.id;
    const parentB = (await register({ role: 'parent', fullName: 'PB', email: 'link.b@evolviq.test', password: 'Parent-Link-1', schoolId: SCHOOL_B }, rootToken)).body.user.id;
    const ok = await register({ role: 'student', fullName: 'C1', studentId: 'L-1', pin: '123123', parentId: parentA }, schoolAdminA.token);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.parentId, parentA);
    const ok2 = await register({ role: 'student', fullName: 'C2', studentId: 'L-2', pin: '123123', parentId: parentA }, schoolAdminA.token);
    assert.equal(ok2.status, 201, 'one parent, many children');

    for (const parentId of [parentB, schoolAdminA.id, '99999999-9999-4999-8999-999999999999']) {
      const r = await register({ role: 'student', fullName: 'C', studentId: `L-X${parentId.slice(0, 4)}`, pin: '123123', parentId }, schoolAdminA.token);
      assert.equal(r.status, 422);
      assert.equal(r.body.error.details.field, 'parentId');
    }
  });

  test('secrets are stored as argon2id hashes and never returned', async () => {
    const b = { role: 'teacher', fullName: 'H', email: 'hash@evolviq.test', password: 'Hash-Me-Pass-1', schoolId: SCHOOL_A };
    const r = await register(b, rootToken);
    assert.ok(!JSON.stringify(r.body).includes(b.password));
    assert.ok(!('secretHash' in r.body.user) && !('password' in r.body.user));
    const { rows } = await db.query('SELECT secret_hash FROM users WHERE email = $1', [b.email]);
    assert.match(rows[0].secret_hash, /^\$argon2id\$v=19\$m=19456,(t=2,p=1|p=1,t=2)\$/);
  });

  test('name is stored trimmed', async () => {
    const r = await register({ role: 'psychologist', fullName: '  Dr. Meena  ', email: 'meena@evolviq.test', password: 'Psych-Pass-99' }, rootToken);
    assert.equal(r.body.user.fullName, 'Dr. Meena');
  });
});
