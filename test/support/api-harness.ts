// Shared harness for API integration tests: real app + real PostgreSQL + Supertest over HTTP.
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import request from 'supertest';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { hashSecret } from '../../src/modules/auth/password.js';
import { createPrismaClient, type Db } from '../../src/shared/db/prisma.js';
import { assertTestDatabase } from './global-setup.js';

export const SCHOOL_A = '11111111-1111-4111-8111-111111111111';
export const SCHOOL_B = '22222222-2222-4222-8222-222222222222';
export const ADMIN = { email: 'root@evolviq.test', password: 'Root-Password-1' } as const;

export interface ApiResponse {
  status: number;
  // Tests assert on arbitrary JSON shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Record<string, string>;
}

export interface TestContext {
  app: FastifyInstance;
  config: AppConfig;
  /** Plain pg pool for assertions / fixtures that inspect the database directly. */
  pg: pg.Pool;
  prisma: Db;
  baseUrl: string;
  send(method: 'GET' | 'POST' | 'PATCH', url: string, opts?: { body?: unknown; token?: string | undefined }): Promise<ApiResponse>;
  get(url: string, token?: string): Promise<ApiResponse>;
  post(url: string, body: unknown, token?: string): Promise<ApiResponse>;
  patch(url: string, body: unknown, token?: string): Promise<ApiResponse>;
  login(body: unknown): Promise<ApiResponse>;
  register(body: unknown, token?: string): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** Empties every table and re-seeds the demo schools + one Platform Admin ("root"). */
async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE refresh_tokens, users, schools CASCADE');
  await pool.query(await readFile(new URL('../../prisma/seed.dev.sql', import.meta.url), 'utf8'));
  await pool.query(
    `INSERT INTO users (role, full_name, email, secret_hash) VALUES ('platform_admin', 'Root', $1, $2)`,
    [ADMIN.email, await hashSecret(ADMIN.password)],
  );
}

export async function createTestContext(): Promise<TestContext> {
  const url = assertTestDatabase(process.env.TEST_DATABASE_URL);
  process.env.DATABASE_URL = url;
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  await resetData(pool);

  const prisma = createPrismaClient({ databaseUrl: url, poolMax: 10 });
  const app = await buildApp({ config, db: prisma });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const send: TestContext['send'] = async (method, url, { body, token } = {}) => {
    let req = request(baseUrl)[method.toLowerCase() as 'get' | 'post' | 'patch'](url);
    if (token) req = req.set('authorization', `Bearer ${token}`);
    const res = body === undefined ? await req : await req.send(body as object);
    return { status: res.status, body: res.body, headers: res.headers as Record<string, string> };
  };

  return {
    app,
    config,
    pg: pool,
    prisma,
    baseUrl,
    send,
    get: (url, token) => send('GET', url, { token }),
    post: (url, body, token) => send('POST', url, { body, token }),
    patch: (url, body, token) => send('PATCH', url, { body, token }),
    login: (body) => send('POST', '/api/v1/auth/login', { body }),
    register: (body, token) => send('POST', '/api/v1/auth/register', { body, token }),
    async close() {
      await app.close();
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/** Registers a user with `token` and logs them in; returns their id + access token. */
export async function createAndLogin(
  ctx: TestContext,
  token: string,
  body: Record<string, unknown>,
): Promise<{ id: string; token: string; refreshToken: string }> {
  const r = await ctx.register(body, token);
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  const creds =
    body.role === 'student'
      ? { studentId: body.studentId, pin: body.pin }
      : { email: body.email, password: body.password };
  const l = await ctx.login(creds);
  if (l.status !== 200) throw new Error(`login failed: ${l.status} ${JSON.stringify(l.body)}`);
  return { id: r.body.user.id, token: l.body.accessToken, refreshToken: l.body.refreshToken };
}
