import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppConfig } from './config.js';
import {
  activitiesRoutes,
  activityCompletionsRoutes,
  assignmentsRoutes,
  familyAssignmentsRoutes,
  studentAssignmentsRoutes,
} from './modules/activities/activities.routes.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import authRoutes from './modules/auth/auth.routes.js';
import { createAuthenticate } from './modules/auth/authenticate.js';
import { initDummyHash } from './modules/auth/password.js';
import { familyObservationsRoutes, observationsRoutes } from './modules/observations/observations.routes.js';
import progressRoutes from './modules/progress/progress.routes.js';
import classesRoutes from './modules/schools/classes.routes.js';
import schoolsRoutes from './modules/schools/schools.routes.js';
import parentStudentsRoutes from './modules/users/parent-students.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import type { Db } from './shared/db/prisma.js';
import { errorHandler } from './shared/errors/index.js';
import { assertRouteDeclaresAccess, publicAccess } from './shared/rbac/index.js';
import { registerApiDocs } from './shared/openapi/register-api-docs.js';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  isLoggerEnabled?: boolean;
  /** Clock for business-date rules (streaks, monthly summaries). Tests may fix it. */
  now?: () => Date;
}

export async function buildApp({ config, db, isLoggerEnabled = false, now = () => new Date() }: BuildAppOptions): Promise<FastifyInstance> {
  await initDummyHash();

  const app = Fastify({
    logger: isLoggerEnabled && {
      level: config.env === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization'], // never log tokens
    },
    bodyLimit: 16 * 1024, // payloads are tiny; reject anything larger early
  }).withTypeProvider<ZodTypeProvider>();

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

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

  app.addHook('onRequest', (req, _reply, done) => {
    const url = req.raw.url ?? '';
    if (
      url &&
      !url.startsWith('/api/v1') &&
      !url.startsWith('/docs') &&
      url !== '/' &&
      url !== '/health'
    ) {
      req.raw.url = `/api/v1${url}`;
    }
    done();
  });

  app.get('/', { config: publicAccess() }, async () => ({ status: 'ok', service: 'evolviq-backend' }));
  app.get('/health', { config: publicAccess() }, async () => ({ status: 'ok', service: 'evolviq-backend' }));

  if (config.docs.isEnabled) await registerApiDocs(app);

  await app.register(authRoutes, { prefix: '/api/v1/auth', db, config });
  await app.register(schoolsRoutes, { prefix: '/api/v1/schools', db });
  await app.register(usersRoutes, { prefix: '/api/v1/users', db });
  await app.register(parentStudentsRoutes, { prefix: '/api/v1/parent-students', db });
  await app.register(classesRoutes, { prefix: '/api/v1/classes', db });
  await app.register(observationsRoutes, { prefix: '/api/v1/observations', db });
  await app.register(activitiesRoutes, { prefix: '/api/v1/activities', db });
  await app.register(assignmentsRoutes, { prefix: '/api/v1/assignments', db });
  await app.register(activityCompletionsRoutes, { prefix: '/api/v1/activity-completions', db });
  await app.register(studentAssignmentsRoutes, { prefix: '/api/v1/students', db });
  await app.register(progressRoutes, { prefix: '/api/v1/students', db, now });
  // Family app (parents): parent-safe responses only.
  await app.register(familyObservationsRoutes, { prefix: '/api/v1/family/observations', db });
  await app.register(familyAssignmentsRoutes, { prefix: '/api/v1/family/children', db });

  return app;
}
