// Login + Register API integration tests (ported 1:1 from the previous node:test suite;
// every case and assertion is preserved). Supertest over HTTP against a real PostgreSQL.
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

let ctx: TestContext;
let rootToken: string;
let schoolAdminA: { id: string; token: string };

const login = (b: unknown) => ctx.login(b);
const register = (b: unknown, t?: string) => ctx.register(b, t);

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await login(ADMIN)).body.accessToken;
  schoolAdminA = await createAndLogin(ctx, rootToken, {
    role: 'school_admin', fullName: 'Admin A', email: 'admin.a@evolviq.test',
    password: 'School-Admin-A-1', schoolId: SCHOOL_A,
  });
});

afterAll(async () => {
  await ctx?.close();
});

// ───────────────────────────── LOGIN ─────────────────────────────
describe('POST /login', () => {
  test('success returns a token and only minimal user fields', async () => {
    const r = await login(ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.tokenType).toBe('Bearer');
    expect(r.body.expiresIn).toBe(3600);
    expect(r.body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(Object.keys(r.body.user).sort()).toEqual(['fullName', 'id', 'role', 'schoolId']);
    expect(r.body.user.role).toBe('platform_admin');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test('email is case-insensitive and trimmed', async () => {
    const r = await login({ email: '  ROOT@EvolvIQ.test ', password: ADMIN.password });
    expect(r.status).toBe(200);
  });

  test('wrong password and unknown user return the identical 401', async () => {
    const wrong = await login({ email: ADMIN.email, password: 'nope-nope-nope' });
    const unknown = await login({ email: 'ghost@evolviq.test', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' } });
    await ctx.pg.query(`UPDATE users SET failed_login_attempts = 0 WHERE email = $1`, [ADMIN.email]);
  });

  test('unknown-user and wrong-password latency are comparable (dummy-hash verify)', async () => {
    const time = async (body: unknown) => {
      const t = process.hrtime.bigint();
      await login(body);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 4; i++) {
      known.push(await time({ email: ADMIN.email, password: `wrong-${i}` }));
      unknown.push(await time({ email: `ghost${i}@evolviq.test`, password: `wrong-${i}` }));
    }
    await ctx.pg.query(`UPDATE users SET failed_login_attempts = 0 WHERE email = $1`, [ADMIN.email]);
    // Without the dummy verify, "unknown" would be ~1 ms vs ~25+ ms. Loose bound to avoid flakiness.
    expect(median(unknown), `known=${median(known)} unknown=${median(unknown)}`).toBeGreaterThan(median(known) * 0.5);
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
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('malformed JSON → 400, wrong content type → 415', async () => {
    const bad = await request(ctx.baseUrl).post('/api/v1/auth/login')
      .set('content-type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
    const txt = await request(ctx.baseUrl).post('/api/v1/auth/login')
      .set('content-type', 'application/x-www-form-urlencoded').send('email=a');
    expect(txt.status).toBe(415);
  });

  test('student logs in with student ID + PIN (ID case-insensitive)', async () => {
    await register({ role: 'student', fullName: 'Kid One', studentId: 'a-1001', pin: '482913' }, schoolAdminA.token);
    const r = await login({ studentId: 'A-1001', pin: '482913' });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('student');
    expect(r.body.user.schoolId).toBe(SCHOOL_A);
    expect((await login({ studentId: 'A-1001', pin: '000000' })).status).toBe(401);
  });

  test('lockout after 5 failures hides even the correct password; resets after expiry', async () => {
    const creds = { email: 'lock@evolviq.test', password: 'Lock-Me-Out-1' };
    await createAndLogin(ctx, rootToken, { role: 'teacher', fullName: 'Lock', schoolId: SCHOOL_A, ...creds });
    for (let i = 0; i < 5; i++) {
      expect((await login({ email: creds.email, password: 'wrong-wrong-1' })).status).toBe(401);
    }
    const locked = await login(creds);
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('INVALID_CREDENTIALS'); // no "locked" leak

    await ctx.pg.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1`, [creds.email]);
    expect((await login(creds)).status).toBe(200);
    const { rows } = await ctx.pg.query(
      'SELECT failed_login_attempts, locked_until FROM users WHERE email = $1', [creds.email]);
    expect(rows[0]).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  test('deactivated user: correct password → 403, wrong password → 401', async () => {
    const creds = { email: 'gone@evolviq.test', password: 'Gone-Gone-Gone-1' };
    await createAndLogin(ctx, rootToken, { role: 'psychologist', fullName: 'Gone', ...creds });
    await ctx.pg.query('UPDATE users SET is_active = false WHERE email = $1', [creds.email]);
    expect((await login(creds)).body.error.code).toBe('ACCOUNT_DISABLED');
    expect((await login({ ...creds, password: 'wrong-wrong-1' })).status).toBe(401);
  });
});

// ──────────────────────────── REGISTER ───────────────────────────
describe('POST /register — authentication & authorisation', () => {
  test('no token, garbage token, forged token → 401', async () => {
    const body = { role: 'teacher', fullName: 'T', email: 't0@evolviq.test', password: 'Teacher-Pass-1', schoolId: SCHOOL_A };
    expect((await register(body)).status).toBe(401);
    expect((await register(body, 'abc.def.ghi')).status).toBe(401);
    const forged = await new SignJWT({ role: 'platform_admin', sid: null })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('00000000-0000-4000-8000-000000000000')
      .setIssuer(ctx.config.jwt.issuer).setAudience(ctx.config.jwt.audience).setExpirationTime('1h')
      .sign(new TextEncoder().encode('some-other-secret-some-other-secret-123'));
    expect((await register(body, forged)).status).toBe(401);
    const noneAlg = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ sub: 'x', role: 'platform_admin' })).toString('base64url')}.`;
    expect((await register(body, noneAlg)).status).toBe(401);
  });

  test('teacher, psychologist, parent and student cannot register anyone → 403', async () => {
    const teacher = await createAndLogin(ctx, rootToken, { role: 'teacher', fullName: 'T', email: 't1@evolviq.test', password: 'Teacher-Pass-1', schoolId: SCHOOL_A });
    const psych = await createAndLogin(ctx, rootToken, { role: 'psychologist', fullName: 'P', email: 'p1@evolviq.test', password: 'Psych-Pass-1!' });
    const parent = await createAndLogin(ctx, rootToken, { role: 'parent', fullName: 'Pa', email: 'pa1@evolviq.test', password: 'Parent-Pass-1', schoolId: SCHOOL_A });
    const student = await createAndLogin(ctx, rootToken, { role: 'student', fullName: 'S', studentId: 'S-0001', pin: '123456', schoolId: SCHOOL_A });
    for (const { token } of [teacher, psych, parent, student]) {
      const r = await register({ role: 'student', fullName: 'X', studentId: 'X-1', pin: '111111' }, token);
      expect(r.status).toBe(403);
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
      expect(r.status, `${b.role}: ${JSON.stringify(r.body)}`).toBe(201);
      expect(r.body.user.role).toBe(b.role);
      expect(r.body.user.schoolId).toBe(b.schoolId ?? null);
      expect(Object.keys(r.body.user).sort()).toEqual(['createdAt', 'fullName', 'id', 'parentId', 'role', 'schoolId']);
    }
  });

  test('school admin creates student/teacher/parent in own school (schoolId implied)', async () => {
    for (const b of [
      { role: 'teacher', fullName: 'T', email: 't3@evolviq.test', password: 'Teacher-Pass-3' },
      { role: 'parent', fullName: 'Pa', email: 'pa3@evolviq.test', password: 'Parent-Pass-3' },
      { role: 'student', fullName: 'S', studentId: 'SA-S1', pin: '135790', schoolId: SCHOOL_A },
    ]) {
      const r = await register(b, schoolAdminA.token);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.user.schoolId).toBe(SCHOOL_A);
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
      expect(r.status, JSON.stringify(b)).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN');
    }
  });

  test('deactivated admin with a still-valid token → 401', async () => {
    const sa = await createAndLogin(ctx, rootToken, { role: 'school_admin', fullName: 'Temp', email: 'temp.sa@evolviq.test', password: 'Temp-Admin-Pass', schoolId: SCHOOL_B });
    await ctx.pg.query('UPDATE users SET is_active = false WHERE id = $1', [sa.id]);
    const r = await register({ role: 'teacher', fullName: 'T', email: 't9@evolviq.test', password: 'Teacher-Pass-9' }, sa.token);
    expect(r.status).toBe(401);
    const { rowCount } = await ctx.pg.query(`SELECT 1 FROM users WHERE email = 't9@evolviq.test'`);
    expect(rowCount).toBe(0);
  });
});

describe('POST /register — validation', () => {
  const cases: [string, Record<string, unknown>, string][] = [
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
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.details[0].field).toBe(field);
    });
  }
});

describe('POST /register — duplicates, references, storage', () => {
  test('duplicate email (different case) → 409 field=email', async () => {
    const b = { role: 'teacher', fullName: 'D', email: 'dup@evolviq.test', password: 'Dup-Pass-12', schoolId: SCHOOL_A };
    expect((await register(b, rootToken)).status).toBe(201);
    const r = await register({ ...b, email: 'DUP@EvolvIQ.test' }, rootToken);
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({ code: 'DUPLICATE_ACCOUNT', message: 'An account with this identifier already exists.', details: { field: 'email' } });
  });

  test('duplicate studentId (different case) → 409 field=studentId', async () => {
    const b = { role: 'student', fullName: 'D', studentId: 'dup-1', pin: '111222' };
    expect((await register(b, schoolAdminA.token)).status).toBe(201);
    const r = await register({ ...b, studentId: 'DUP-1' }, schoolAdminA.token);
    expect(r.status).toBe(409);
    expect(r.body.error.details.field).toBe('studentId');
  });

  test('race: 20 concurrent identical registrations → exactly one 201', async () => {
    const b = { role: 'parent', fullName: 'R', email: 'race@evolviq.test', password: 'Race-Pass-12', schoolId: SCHOOL_A };
    const results = await Promise.all(Array.from({ length: 20 }, () => register(b, rootToken)));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(19);
  });

  test('unknown schoolId → 422', async () => {
    const r = await register({ role: 'teacher', fullName: 'X', email: 'ns@evolviq.test', password: 'Password-XX-1', schoolId: '99999999-9999-4999-8999-999999999999' }, rootToken);
    expect(r.status).toBe(422);
    expect(r.body.error.details.field).toBe('schoolId');
  });

  test('student ↔ parent link: valid parent 201; other-school parent / non-parent / unknown → 422', async () => {
    const parentA = (await register({ role: 'parent', fullName: 'PA', email: 'link.a@evolviq.test', password: 'Parent-Link-1' }, schoolAdminA.token)).body.user.id;
    const parentB = (await register({ role: 'parent', fullName: 'PB', email: 'link.b@evolviq.test', password: 'Parent-Link-1', schoolId: SCHOOL_B }, rootToken)).body.user.id;
    const ok = await register({ role: 'student', fullName: 'C1', studentId: 'L-1', pin: '123123', parentId: parentA }, schoolAdminA.token);
    expect(ok.status).toBe(201);
    expect(ok.body.user.parentId).toBe(parentA);
    const ok2 = await register({ role: 'student', fullName: 'C2', studentId: 'L-2', pin: '123123', parentId: parentA }, schoolAdminA.token);
    expect(ok2.status, 'one parent, many children').toBe(201);

    for (const parentId of [parentB, schoolAdminA.id, '99999999-9999-4999-8999-999999999999']) {
      const r = await register({ role: 'student', fullName: 'C', studentId: `L-X${parentId.slice(0, 4)}`, pin: '123123', parentId }, schoolAdminA.token);
      expect(r.status).toBe(422);
      expect(r.body.error.details.field).toBe('parentId');
    }
  });

  test('secrets are stored as argon2id hashes and never returned', async () => {
    const b = { role: 'teacher', fullName: 'H', email: 'hash@evolviq.test', password: 'Hash-Me-Pass-1', schoolId: SCHOOL_A };
    const r = await register(b, rootToken);
    expect(JSON.stringify(r.body)).not.toContain(b.password);
    expect('secretHash' in r.body.user || 'password' in r.body.user).toBe(false);
    const { rows } = await ctx.pg.query('SELECT secret_hash FROM users WHERE email = $1', [b.email]);
    expect(rows[0].secret_hash).toMatch(/^\$argon2id\$v=19\$m=19456,(t=2,p=1|p=1,t=2)\$/);
  });

  test('name is stored trimmed', async () => {
    const r = await register({ role: 'psychologist', fullName: '  Dr. Meena  ', email: 'meena@evolviq.test', password: 'Psych-Pass-99' }, rootToken);
    expect(r.body.user.fullName).toBe('Dr. Meena');
  });
});
