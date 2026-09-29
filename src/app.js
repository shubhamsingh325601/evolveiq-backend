import Fastify from 'fastify';
import { AppError } from './lib/errors.js';
import { initDummyHash } from './lib/password.js';
import authRoutes from './modules/auth/auth.routes.js';

function validationDetails(errors) {
  return errors.map((e) => {
    if (e.keyword === 'discriminator') {
      return { field: 'role', message: 'must be one of: student, parent, teacher, school_admin, psychologist, platform_admin' };
    }
    const field =
      e.params?.missingProperty ??
      e.params?.additionalProperty ??
      (e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : 'body');
    const message = e.keyword === 'additionalProperties' ? 'is not allowed' : e.message;
    return { field, message };
  });
}

const CLIENT_ERROR_CODES = { 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE' };

export async function buildApp({ config, db, logger = false }) {
  await initDummyHash();

  const app = Fastify({
    logger: logger && {
      level: config.env === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization'], // never log tokens
    },
    bodyLimit: 16 * 1024, // auth payloads are tiny; reject anything larger early
    ajv: {
      customOptions: {
        discriminator: true,
        removeAdditional: false, // unknown fields are rejected, not silently dropped
        coerceTypes: false,      // "123" stays a string; 123 is a type error
        allErrors: false,        // stop at the first error — cheaper
      },
    },
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
      });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed.', details: validationDetails(err.validation) },
      });
    }
    if (err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify's own client errors (bad JSON, wrong content-type, too large) — safe messages.
      return reply.code(err.statusCode).send({
        error: { code: CLIENT_ERROR_CODES[err.statusCode] ?? 'BAD_REQUEST', message: err.message },
      });
    }
    request.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  app.register(authRoutes, { prefix: '/api/v1/auth', db, config });
  return app;
}
