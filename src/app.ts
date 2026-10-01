import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import authRoutes from './modules/auth/auth.routes.js';
import { createAuthenticate } from './modules/auth/authenticate.js';
import { initDummyHash } from './modules/auth/password.js';
import schoolsRoutes from './modules/schools/schools.routes.js';
import type { Db } from './shared/db/prisma.js';
import { errorHandler } from './shared/errors/index.js';
import { assertRouteDeclaresAccess } from './shared/rbac/index.js';
import { registerApiDocs } from './shared/openapi/register-api-docs.js';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  isLoggerEnabled?: boolean;
}

export async function buildApp({ config, db, isLoggerEnabled = false }: BuildAppOptions): Promise<FastifyInstance> {
  await initDummyHash();

  const app = Fastify({
    logger: isLoggerEnabled && {
      level: config.env === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization'], // never log tokens
    },
    bodyLimit: 16 * 1024, // payloads are tiny; reject anything larger early
  }).withTypeProvider<ZodTypeProvider>();

  // Zod at the route boundary: request validation + response serialisation.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // Authentication: available to every module as `app.authenticate`; it populates
  // `request.actor`, which the shared RBAC guard (src/shared/rbac) reads.
  app.decorateRequest('actor', null);
  app.decorate('authenticate', createAuthenticate({ jwt: config.jwt, repository: createAuthRepository(db) }));

  // Every /api route must declare its allowed roles (or be explicitly public) — checked at
  // startup for each route registered below.
  app.addHook('onRoute', assertRouteDeclaresAccess);

  if (config.docs.isEnabled) await registerApiDocs(app);

  await app.register(authRoutes, { prefix: '/api/v1/auth', db, config });
  await app.register(schoolsRoutes, { prefix: '/api/v1/schools', db });

  return app;
}
