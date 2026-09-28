import { Errors } from '../../lib/errors.js';
import { loginSchema, registerSchema } from './auth.schemas.js';
import { requireRegistrar } from './authenticate.js';
import { createAuthService } from './auth.service.js';

export default async function authRoutes(app, { db, config }) {
  const service = createAuthService({ db, config });

  // POST /api/v1/auth/register — admin-created accounts (see auth.policy.js)
  app.post('/register', {
    schema: registerSchema,
    onRequest: requireRegistrar(config.jwt),
    handler: async (request, reply) => {
      const user = await service.register(request.actor, request.body);
      return reply.code(201).send({ user });
    },
  });

  // POST /api/v1/auth/login — one endpoint for all six roles (PRD §2)
  app.post('/login', {
    schema: loginSchema,
    // oneOf errors are noisy; replace them with one clear message.
    attachValidation: true,
    handler: async (request, reply) => {
      if (request.validationError) {
        throw Errors.validation(undefined, 'Provide either "email" and "password", or "studentId" and "pin".');
      }
      const result = await service.login(request.body);
      reply.header('cache-control', 'no-store');
      return result;
    },
  });
}
