// Change password (asked for on 21 Nov 2026): POST /auth/change-password.
// Supertest over HTTP against a real PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, createAndLogin, createTestContext, type TestContext } from '../../../test/support/api-harness.js';

let ctx: TestContext;
let rootToken: string;

const change = (body: unknown, token?: string) => ctx.post('/api/v1/auth/change-password', body, token);

let accounts = 0;
async function newParent(): Promise<{ id: string; email: string; password: string; token: string; refreshToken: string }> {
  accounts += 1;
  const email = `change.parent.${accounts}@evolviq.test`;
  const password = `Old-Password-${accounts}`;
  const user = await createAndLogin(ctx, rootToken, { role: 'parent', fullName: `Pia Parent ${accounts}`, email, password, schoolId: SCHOOL_A });
  return { ...user, email, password };
}

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
});

afterAll(async () => {
  await ctx?.close();
});

describe('POST /auth/change-password', () => {
  test('no token → 401; a student → 403 (their PIN is set by their parent or school)', async () => {
    expect((await change({ currentPassword: 'x', newPassword: 'Brand-New-Password-1' })).status).toBe(401);
    const kid = await createAndLogin(ctx, rootToken, { role: 'student', fullName: 'Kid', studentId: 'CHANGE-1', pin: '123456', schoolId: SCHOOL_A });
    const r = await change({ currentPassword: '123456', newPassword: 'Brand-New-Password-1' }, kid.token);
    expect(r.status).toBe(403);
  });

  test('success: this device gets new tokens, every other session ends, the new password works', async () => {
    const p = await newParent();
    const otherDevice = await ctx.login({ email: p.email, password: p.password });

    const r = await change({ currentPassword: p.password, newPassword: 'Brand-New-Password-1' }, p.token);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, refreshExpiresIn: 604800 });
    expect(Object.keys(r.body).sort()).toEqual(['accessToken', 'expiresIn', 'refreshExpiresIn', 'refreshToken', 'tokenType']);

    // Old sessions — this device's and the other one — can no longer be refreshed.
    for (const refreshToken of [p.refreshToken, otherDevice.body.refreshToken]) {
      expect((await ctx.post('/api/v1/auth/refresh', { refreshToken })).status).toBe(401);
    }
    // The new pair works: the access token is accepted, the refresh token rotates.
    expect((await ctx.post('/api/v1/auth/logout', { refreshToken: otherDevice.body.refreshToken }, r.body.accessToken)).status).toBe(204);
    expect((await ctx.post('/api/v1/auth/refresh', { refreshToken: r.body.refreshToken })).status).toBe(200);

    expect((await ctx.login({ email: p.email, password: p.password })).status).toBe(401);
    expect((await ctx.login({ email: p.email, password: 'Brand-New-Password-1' })).status).toBe(200);
  });

  test('a wrong current password → 400 INVALID_CURRENT_PASSWORD, and it counts toward the lockout', async () => {
    const p = await newParent();
    for (let i = 0; i < 5; i++) {
      const r = await change({ currentPassword: 'not-my-password', newPassword: 'Brand-New-Password-1' }, p.token);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Your current password is not correct.' } });
    }
    // Locked now: even the right current password gets the same answer, and login is locked too.
    const locked = await change({ currentPassword: p.password, newPassword: 'Brand-New-Password-1' }, p.token);
    expect(locked.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect((await ctx.login({ email: p.email, password: p.password })).status).toBe(401);
  });

  test('a successful change clears earlier failed attempts', async () => {
    const p = await newParent();
    for (let i = 0; i < 3; i++) await change({ currentPassword: 'not-my-password', newPassword: 'Brand-New-Password-1' }, p.token);
    expect((await change({ currentPassword: p.password, newPassword: 'Brand-New-Password-1' }, p.token)).status).toBe(200);
    const { rows } = await ctx.pg.query(`SELECT failed_login_attempts, locked_until FROM users WHERE id = $1`, [p.id]);
    expect(rows[0]).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  test('the new password follows the registration rules; unknown fields are rejected', async () => {
    const p = await newParent();
    for (const body of [
      { currentPassword: p.password, newPassword: 'short' },
      { currentPassword: p.password },
      { currentPassword: '', newPassword: 'Brand-New-Password-1' },
      { currentPassword: p.password, newPassword: 'Brand-New-Password-1', role: 'platform_admin' },
    ]) {
      const r = await change(body, p.token);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await ctx.login({ email: p.email, password: p.password })).status).toBe(200);
  });
});
