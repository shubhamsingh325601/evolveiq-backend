// HTTP layer only: validation (Zod), RBAC wiring, status codes, headers.
// Business rules live in auth.service.ts; SQL lives in the repositories.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../shared/db/prisma.js';
import { Errors, errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, publicAccess, requireRole } from '../../shared/rbac/index.js';
import { REGISTRAR_ROLES } from './auth.policy.js';
import { createAuthRepository } from './auth.repository.js';
import {
  LoginBodySchema,
  LoginResponseSchema,
  RefreshBodySchema,
  RefreshResponseSchema,
  RegisterBodySchema,
  RegisteredUserSchema,
} from './auth.schemas.js';
import { createAuthService } from './auth.service.js';
import { createRefreshTokenRepository } from './refresh-token.repository.js';
import { createRefreshTokenService } from './refresh-token.service.js';

export interface AuthRoutesOptions {
  db: Db;
  config: AppConfig;
}

const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, { db, config }) => {
  const refreshTokens = createRefreshTokenService({
    repository: createRefreshTokenRepository(db),
    config,
  });
  const service = createAuthService({ repository: createAuthRepository(db), config, refreshTokens });

  // Shared RBAC guard: Platform Admin or School Admin may call /register at all. Which
  // accounts each may create is a business rule enforced by the service.
  const registrarsOnly = requireRole(...REGISTRAR_ROLES);

  // POST /api/v1/auth/register — admin-created accounts (see auth.policy.ts)
  app.post('/register', {
    onRequest: [app.authenticate, registrarsOnly],
    schema: {
      tags: ['Auth'],
      summary: 'Create a user account',
      description:
        `${describeRoles(registrarsOnly.allowedRoles)} Platform Admins can create every role ` +
        '(schoolId required for school-scoped roles). School Admins can create students, ' +
        'teachers and parents in their own school only.',
      security: [{ bearerAuth: [] }],
      body: RegisterBodySchema,
      response: {
        201: z.object({ user: RegisteredUserSchema }),
        ...errorResponses(400, 401, 403, 409, 422, 500),
      },
    },
    handler: async (request, reply) => {
      const user = await service.register(actorOf(request), request.body);
      return reply.code(201).send({ user });
    },
  });

  // POST /api/v1/auth/login — one endpoint for all six roles (PRD §2)
  app.post('/login', {
    config: publicAccess(), // anyone may try to log in
    schema: {
      tags: ['Auth'],
      summary: 'Log in (all roles)',
      description:
        'Adults: `email` + `password`. Students: `studentId` + `pin`. Returns an access token ' +
        'and a refresh token. Wrong secret, unknown user and locked account all return the ' +
        'same 401.',
      body: LoginBodySchema,
      response: {
        200: LoginResponseSchema,
        ...errorResponses(400, 401, 403, 500),
      },
    },
    // Union errors are noisy; replace them with one clear message.
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

  // POST /api/v1/auth/refresh — exchange a refresh token for a new access token.
  // The refresh token is rotated: the one presented is revoked, a new one is returned.
  app.post('/refresh', {
    config: publicAccess(), // the refresh token in the body is the credential
    schema: {
      tags: ['Auth'],
      summary: 'Rotate a refresh token',
      description:
        'Returns a new access token and a NEW refresh token; the presented refresh token is ' +
        'revoked. Re-using a rotated token revokes its whole family.',
      body: RefreshBodySchema,
      response: {
        200: RefreshResponseSchema,
        ...errorResponses(400, 401, 403, 500),
      },
    },
    handler: async (request, reply) => {
      const result = await refreshTokens.refresh(request.body.refreshToken);
      reply.header('cache-control', 'no-store');
      return result;
    },
  });
};

export default authRoutes;
