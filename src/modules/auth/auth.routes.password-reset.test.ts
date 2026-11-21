// Forgot password (asked for on 21 Nov 2026): POST /auth/forgot-password and /auth/reset-password.
// Supertest over HTTP against a real PostgreSQL; mail is captured by the harness, not sent.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

let ctx: TestContext;
let rootToken: string;

const forgot = (body: unknown) => ctx.post('/api/v1/auth/forgot-password', body);
const reset = (body: unknown) => ctx.post('/api/v1/auth/reset-password', body);

const SAME_ANSWER = {
  message: 'If an account uses this email, a 6-digit code is on its way. It works for 15 minutes.',
};
const INVALID_CODE = {
  error: { code: 'INVALID_RESET_CODE', message: 'The code is wrong or has expired. Ask for a new one.' },
};

let accounts = 0;
/** A fresh active adult, so each test starts with no codes and no throttle. */
async function newTeacher(): Promise<{ id: string; email: string; password: string }> {
  accounts += 1;
  const email = `reset.teacher.${accounts}@evolviq.test`;
  const password = `Old-Password-${accounts}`;
  const { id } = await createAndLogin(ctx, rootToken, { role: 'teacher', fullName: `Asha Teacher ${accounts}`, email, password, schoolId: SCHOOL_A });
  return { id, email, password };
}

/** Asks for a code and returns the one that was mailed. */
async function requestCode(email: string): Promise<string> {
  const before = ctx.mail.to(email).length;
  const r = await forgot({ email });
  expect(r.status).toBe(202);
  await ctx.settle();
  const sent = ctx.mail.to(email);
  expect(sent.length).toBe(before + 1);
  const code = /\b(\d{6})\b/.exec(sent.at(-1)!.text)?.[1];
  if (!code) throw new Error('no code in the email');
  return code;
}

/** Moves every code of the account back in time, past the one-a-minute throttle. */
const ageCodes = (userId: string, interval: string) =>
  ctx.pg.query(`UPDATE password_reset_codes SET created_at = created_at - $2::interval WHERE user_id = $1`, [userId, interval]);

const otherThan = (code: string) => (code === '000000' ? '111111' : '000000');

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
});

afterAll(async () => {
  await ctx?.close();
});

describe('POST /auth/forgot-password', () => {
  test('always 202 with the same body; a code is mailed only to an active adult', async () => {
    const active = await newTeacher();
    const deactivated = await newTeacher();
    expect((await ctx.post(`/api/v1/users/${deactivated.id}/deactivate`, {}, rootToken)).status).toBe(200);
    ctx.mail.clear();

    for (const email of [active.email, 'ghost@evolviq.test', deactivated.email]) {
      const r = await forgot({ email });
      expect(r.status).toBe(202);
      expect(r.body).toEqual(SAME_ANSWER);
    }
    await ctx.settle();

    expect(ctx.mail.messages.map((m) => m.to)).toEqual([active.email]);
    const [message] = ctx.mail.messages;
    expect(message!.subject).toBe('Your EvolvIQ password reset code');
    expect(message!.text).toMatch(/^Hello Asha,/);
    expect(message!.text).toMatch(/Your EvolvIQ password reset code is \d{6}\b/);
    expect(message!.html).toContain('15 minutes');

    const rows = await ctx.pg.query(`SELECT user_id, code_hash FROM password_reset_codes WHERE user_id = ANY($1::uuid[])`, [[active.id, deactivated.id]]);
    expect(rows.rows.map((r) => r.user_id)).toEqual([active.id]);
    // Only a hash is stored, never the code.
    const code = /\b(\d{6})\b/.exec(message!.text)![1]!;
    expect(rows.rows[0].code_hash).toMatch(/^\$argon2id\$/);
    expect(rows.rows[0].code_hash).not.toContain(code);
  });

  test('a student ID gets no code (students sign in with a PIN, set by their parent or school)', async () => {
    ctx.mail.clear();
    await createAndLogin(ctx, rootToken, { role: 'student', fullName: 'Kid A', studentId: 'RESET-1', pin: '123456', schoolId: SCHOOL_A });
    expect((await forgot({ email: 'RESET-1' })).status).toBe(202);
    await ctx.settle();
    expect(ctx.mail.messages).toEqual([]);
  });

  test('the email is trimmed and case-insensitive', async () => {
    const t = await newTeacher();
    ctx.mail.clear();
    expect((await forgot({ email: `  ${t.email.toUpperCase()} ` })).status).toBe(202);
    await ctx.settle();
    expect(ctx.mail.messages.map((m) => m.to)).toEqual([t.email]);
  });

  test('throttle: one code a minute, five an hour, and still the same 202', async () => {
    const t = await newTeacher();
    await requestCode(t.email);

    // Straight away again: answered the same, nothing sent.
    expect((await forgot({ email: t.email })).body).toEqual(SAME_ANSWER);
    await ctx.settle();
    expect(ctx.mail.to(t.email)).toHaveLength(1);

    // A minute apart, up to five in the hour…
    for (let n = 2; n <= 5; n++) {
      await ageCodes(t.id, '61 seconds');
      await requestCode(t.email);
    }
    // …then no sixth.
    await ageCodes(t.id, '61 seconds');
    expect((await forgot({ email: t.email })).status).toBe(202);
    await ctx.settle();
    expect(ctx.mail.to(t.email)).toHaveLength(5);

    // An hour on, codes flow again.
    await ageCodes(t.id, '1 hour');
    await requestCode(t.email);
    expect(ctx.mail.to(t.email)).toHaveLength(6);
  });

  test('malformed bodies → 400 VALIDATION_ERROR', async () => {
    for (const body of [{}, { email: '' }, { email: 'a@b.c', extra: 1 }, { email: 42 }]) {
      const r = await forgot(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('POST /auth/reset-password', () => {
  test('the right code sets the new password, ends every session, and works once', async () => {
    const t = await newTeacher();
    const session = await ctx.login({ email: t.email, password: t.password });
    const code = await requestCode(t.email);

    const wrong = await reset({ email: t.email, code: otherThan(code), newPassword: 'Brand-New-Password-1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual(INVALID_CODE);

    const r = await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' });
    expect(r.status).toBe(204);
    expect(r.headers['cache-control']).toBe('no-store');

    expect((await ctx.login({ email: t.email, password: t.password })).status).toBe(401);
    expect((await ctx.login({ email: t.email, password: 'Brand-New-Password-1' })).status).toBe(200);
    // The session opened with the old password can no longer be refreshed.
    const refresh = await ctx.post('/api/v1/auth/refresh', { refreshToken: session.body.refreshToken });
    expect(refresh.status).toBe(401);

    // Used up.
    const again = await reset({ email: t.email, code, newPassword: 'Another-Password-2' });
    expect(again.body).toEqual(INVALID_CODE);
  });

  test('an unknown email and a wrong code get the identical answer', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    const unknown = await reset({ email: 'ghost@evolviq.test', code: '123456', newPassword: 'Brand-New-Password-1' });
    const wrong = await reset({ email: t.email, code: otherThan(code), newPassword: 'Brand-New-Password-1' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual(wrong.body);
  });

  test('five tries per code: after five wrong ones even the right code fails', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    for (let i = 0; i < 5; i++) {
      expect((await reset({ email: t.email, code: otherThan(code), newPassword: 'Brand-New-Password-1' })).body).toEqual(INVALID_CODE);
    }
    expect((await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' })).body).toEqual(INVALID_CODE);
    expect((await ctx.login({ email: t.email, password: t.password })).status).toBe(200);
  });

  test('parallel guesses cannot take more than five tries', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    await Promise.all(
      Array.from({ length: 12 }, () => reset({ email: t.email, code: otherThan(code), newPassword: 'Brand-New-Password-1' })),
    );
    const { rows } = await ctx.pg.query(`SELECT attempts FROM password_reset_codes WHERE user_id = $1`, [t.id]);
    expect(rows[0].attempts).toBe(5);
    expect((await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' })).body).toEqual(INVALID_CODE);
  });

  test('two right answers at once: exactly one wins', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    const results = await Promise.all([
      reset({ email: t.email, code, newPassword: 'Winner-Password-1' }),
      reset({ email: t.email, code, newPassword: 'Winner-Password-2' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
  });

  test('an expired code fails', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    await ctx.pg.query(`UPDATE password_reset_codes SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [t.id]);
    expect((await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' })).body).toEqual(INVALID_CODE);
  });

  test('only the newest code works', async () => {
    const t = await newTeacher();
    const first = await requestCode(t.email);
    await ageCodes(t.id, '2 minutes');
    const second = await requestCode(t.email);
    if (first !== second) {
      expect((await reset({ email: t.email, code: first, newPassword: 'Brand-New-Password-1' })).body).toEqual(INVALID_CODE);
    }
    expect((await reset({ email: t.email, code: second, newPassword: 'Brand-New-Password-1' })).status).toBe(204);
  });

  test('a reset clears a login lockout', async () => {
    const t = await newTeacher();
    for (let i = 0; i < 5; i++) await ctx.login({ email: t.email, password: 'wrong-wrong-wrong' });
    expect((await ctx.login({ email: t.email, password: t.password })).status).toBe(401); // locked

    const code = await requestCode(t.email);
    expect((await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' })).status).toBe(204);
    expect((await ctx.login({ email: t.email, password: 'Brand-New-Password-1' })).status).toBe(200);
  });

  test('a code stops working once the account is deactivated', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    expect((await ctx.post(`/api/v1/users/${t.id}/deactivate`, {}, rootToken)).status).toBe(200);
    expect((await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' })).body).toEqual(INVALID_CODE);
  });

  test('the new password follows the registration rules; a rejected body takes no try', async () => {
    const t = await newTeacher();
    const code = await requestCode(t.email);
    const short = await reset({ email: t.email, code, newPassword: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('VALIDATION_ERROR');
    for (const body of [{ email: t.email, code: '12345', newPassword: 'Brand-New-Password-1' }, { email: t.email, code, newPassword: 'Brand-New-Password-1', extra: true }]) {
      expect((await reset(body)).status).toBe(400);
    }
    const { rows } = await ctx.pg.query(`SELECT attempts FROM password_reset_codes WHERE user_id = $1`, [t.id]);
    expect(rows[0].attempts).toBe(0);
    expect((await reset({ email: t.email, code, newPassword: 'Brand-New-Password-1' })).status).toBe(204);
  });
});
