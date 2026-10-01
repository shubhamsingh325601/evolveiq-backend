// Unit tests for the shared typed-error → HTTP mapping (src/shared/errors), using a tiny
// Fastify app with the real error handler and Zod compilers — no database.
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, Errors, constraintViolation, errorHandler, mapPrismaError } from './index.js';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('db error with "secret_internal_constraint"', {
    code,
    clientVersion: 'test',
    ...(meta && { meta }),
  });

let app: FastifyInstance;
let toThrow: unknown;

beforeAll(async () => {
  const f = Fastify().withTypeProvider<ZodTypeProvider>();
  f.setValidatorCompiler(validatorCompiler);
  f.setSerializerCompiler(serializerCompiler);
  f.setErrorHandler(errorHandler);
  f.post('/validate', {
    schema: { body: z.strictObject({ name: z.string().min(1), nested: z.strictObject({ n: z.number() }).optional() }) },
    handler: async () => ({ ok: true }),
  });
  f.get('/throw', async () => {
    throw toThrow;
  });
  await f.ready();
  app = f;
});

afterAll(async () => {
  await app.close();
});

const call = async (err: unknown) => {
  toThrow = err;
  const r = await app.inject({ method: 'GET', url: '/throw' });
  return { status: r.statusCode, body: r.json() };
};

describe('error handler', () => {
  test('AppError → its status and { error: { code, message, details } }', async () => {
    expect(await call(Errors.notFound('School'))).toEqual({
      status: 404, body: { error: { code: 'NOT_FOUND', message: 'School not found.' } },
    });
    expect(await call(Errors.invalidReference('schoolId', 'School not found.'))).toEqual({
      status: 422, body: { error: { code: 'INVALID_REFERENCE', message: 'School not found.', details: { field: 'schoolId' } } },
    });
    expect((await call(Errors.forbidden())).status).toBe(403);
    expect((await call(Errors.unauthenticated())).status).toBe(401);
  });

  test('Zod validation → 400 VALIDATION_ERROR with field paths; unknown keys named', async () => {
    const r = await app.inject({ method: 'POST', url: '/validate', payload: { name: '', nested: { n: 'x' }, extra: 1 } });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    const fields = body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'nested.n', 'extra']));
    expect(body.error.details.find((d: { field: string }) => d.field === 'extra').message).toBe('is not allowed');
  });

  test('non-object body → 400 with field "body"', async () => {
    const r = await app.inject({ method: 'POST', url: '/validate', payload: [] });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details[0].field).toBe('body');
  });

  test('Prisma unique violation (not handled by a service) → 409 CONFLICT, no internals leaked', async () => {
    const r = await call(known('P2002'));
    expect(r).toEqual({ status: 409, body: { error: { code: 'CONFLICT', message: expect.any(String) } } });
    expect(JSON.stringify(r.body)).not.toContain('secret_internal_constraint');
  });

  test('Prisma record-not-found → 404', async () => {
    expect((await call(known('P2025'))).status).toBe(404);
  });

  test('other database errors → 500 INTERNAL_ERROR with a generic message', async () => {
    for (const err of [known('P1001'), known('P2010', { driverAdapterError: { cause: { originalCode: '57014' } } })]) {
      const r = await call(err);
      expect(r).toEqual({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } } });
    }
  });

  test('unexpected JS errors → 500 without the message or stack', async () => {
    const r = await call(new Error('ECONNREFUSED 10.0.0.5:5432'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('ECONNREFUSED');
  });
});

describe('constraintViolation', () => {
  test('raw-query unique violation (P2010 + SQLSTATE 23505) exposes the constraint name', () => {
    const err = known('P2010', {
      driverAdapterError: { cause: { originalCode: '23505', constraint: { index: 'users_email_key' } } },
    });
    expect(constraintViolation(err)).toEqual({ kind: 'unique', constraint: 'users_email_key' });
    expect(mapPrismaError(err)).toBeInstanceOf(AppError);
  });

  test('foreign-key violation (SQLSTATE 23503)', () => {
    const err = known('P2010', {
      driverAdapterError: { cause: { originalCode: '23503', constraint: { index: 'users_school_id_fkey' } } },
    });
    expect(constraintViolation(err)).toEqual({ kind: 'foreign_key', constraint: 'users_school_id_fkey' });
  });

  test('non-Prisma errors are not constraint violations', () => {
    expect(constraintViolation(new Error('x'))).toBeNull();
    expect(mapPrismaError(new Error('x'))).toBeNull();
  });
});
