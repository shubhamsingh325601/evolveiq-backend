// CORS: with CORS_ORIGINS set, only the listed browser origins get CORS headers back.
// No database needed: building the app and answering a preflight never runs a query.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPrismaClient, type Db } from './shared/db/prisma.js';

let app: FastifyInstance;
let db: Db;
const ALLOWED = 'https://teacher.evolviq.in';

beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
  const base = loadConfig();
  const config = { ...base, cors: { origins: [ALLOWED, 'https://family.evolviq.in'] } };
  db = createPrismaClient({ databaseUrl: config.databaseUrl, poolMax: 1 });
  app = await buildApp({ config, db });
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
});

const preflight = (origin: string) =>
  app.inject({
    method: 'OPTIONS',
    url: '/api/v1/auth/login',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
  });

describe('CORS allowlist', () => {
  test('a listed origin gets its own origin echoed back', async () => {
    const r = await preflight(ALLOWED);
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(r.headers['access-control-allow-methods']).toContain('POST');
  });

  test('an unlisted origin gets no CORS headers, so the browser blocks the call', async () => {
    const r = await preflight('https://evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a look-alike subdomain of an allowed origin is not allowed', async () => {
    const r = await preflight('https://teacher.evolviq.in.evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});
