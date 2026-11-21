// HTTP layer only: validation (Zod), RBAC wiring, status codes, headers.
// Business rules live in auth.service.ts; SQL lives in the repositories.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { BackgroundTasks } from '../../shared/background/background-tasks.js';
import type { Db } from '../../shared/db/prisma.js';
import { Errors, errorResponses } from '../../shared/errors/index.js';
import type { Mailer } from '../../shared/mail/mailer.js';
import { actorOf, describeRoles, publicAccess, requireRole, Role } from '../../shared/rbac/index.js';
import { REGISTRAR_ROLES } from './auth.policy.js';
import { createAuthRepository } from './auth.repository.js';
import {
  ChangePasswordBodySchema,
  ForgotPasswordBodySchema,
  ForgotPasswordResponseSchema,
  LoginBodySchema,
  LoginResponseSchema,
  LogoutBodySchema,
  RefreshBodySchema,
  RefreshResponseSchema,
  RegisterBodySchema,
  RegisteredUserSchema,
  ResetPasswordBodySchema,
} from './auth.schemas.js';
import { createAuthService } from './auth.service.js';
import { createPasswordResetRepository } from './password-reset.repository.js';
import {
  createPasswordResetService,
  FORGOT_PASSWORD_MESSAGE,
  RESET_CODE_MAX_ATTEMPTS,
  RESET_CODE_TTL_MINUTES,
} from './password-reset.service.js';
import { createRefreshTokenRepository } from './refresh-token.repository.js';
import { createRefreshTokenService } from './refresh-token.service.js';

export interface AuthRoutesOptions {
  db: Db;
  config: AppConfig;
  mailer: Mailer;
  backgroundTasks: BackgroundTasks;
}

const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, { db, config, mailer, backgroundTasks }) => {
  const refreshTokens = createRefreshTokenService({
    repository: createRefreshTokenRepository(db),
    config,
  });
  const service = createAuthService({ repository: createAuthRepository(db), config, refreshTokens });
  const passwordResets = createPasswordResetService({
    repository: createPasswordResetRepository(db),
    mailer,
    backgroundTasks,
  });

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

  // Every signed-in user may end their own session.
  const anyRole = requireRole(
    Role.Student, Role.Parent, Role.Teacher, Role.Psychologist, Role.SchoolAdmin, Role.PlatformAdmin,
  );

  // POST /api/v1/auth/logout — end the caller's session (revoke its refresh tokens)
  app.post('/logout', {
    onRequest: [app.authenticate, anyRole],
    schema: {
      tags: ['Auth'],
      summary: 'Log out (end this session)',
      description:
        `${describeRoles(anyRole.allowedRoles)} Revokes the given refresh token and every token ` +
        'rotated from it, so this session can no longer be refreshed. Other sessions of the same ' +
        'user stay signed in. The refresh token must belong to the caller. The access token ' +
        'itself is not revoked: it stops working when it expires (`expiresIn` from login). ' +
        'Logging out an already-ended session also returns 204.',
      security: [{ bearerAuth: [] }],
      body: LogoutBodySchema,
      response: {
        204: z.null().meta({ description: 'Session ended. No body.' }),
        // 401: UNAUTHENTICATED (access token) or INVALID_REFRESH_TOKEN (body token).
        ...errorResponses(400, 401, 500),
      },
    },
    handler: async (request, reply) => {
      await refreshTokens.logout(actorOf(request).userId, request.body.refreshToken);
      return reply.code(204).send(null);
    },
  });

  // ───── Forgot password (asked for on 21 Nov 2026) ─────

  // POST /api/v1/auth/forgot-password — email a 6-digit code to an adult who forgot their password
  app.post('/forgot-password', {
    config: publicAccess(), // whoever forgot their password is signed out, by definition
    schema: {
      tags: ['Auth'],
      summary: 'Forgot password: email a reset code (adults)',
      description:
        'Emails a 6-digit code to the account with this email, if it is an active adult account. The code ' +
        `works for ${RESET_CODE_TTL_MINUTES} minutes, ${RESET_CODE_MAX_ATTEMPTS} tries, once, and only the newest ` +
        'code of an account works. At most one code a minute and five an hour per account. Always 202 with the ' +
        'same body, registered or not. Students have no email: their parent or School Admin sets a new PIN.',
      body: ForgotPasswordBodySchema,
      response: {
        202: ForgotPasswordResponseSchema,
        ...errorResponses(400, 500),
      },
    },
    handler: async (request, reply) => {
      passwordResets.requestReset(request.body.email);
      return reply.code(202).send({ message: FORGOT_PASSWORD_MESSAGE });
    },
  });

  // POST /api/v1/auth/reset-password — set a new password with the emailed code
  app.post('/reset-password', {
    config: publicAccess(), // the emailed code is the credential
    schema: {
      tags: ['Auth'],
      summary: 'Forgot password: set a new password with the code',
      description:
        'Checks the code from /auth/forgot-password and sets the new password (10–128 characters). The code is ' +
        "then used up, the account's login lockout is cleared and every session ends (refresh tokens revoked): " +
        'sign in again with the new password. A wrong, expired, used or replaced code and an unknown email all ' +
        'return the same 400 `INVALID_RESET_CODE`. Every try counts toward the limit.',
      body: ResetPasswordBodySchema,
      response: {
        204: z.null().meta({ description: 'Password changed. No body.' }),
        ...errorResponses(400, 500),
      },
    },
    handler: async (request, reply) => {
      await passwordResets.resetPassword(request.body);
      reply.header('cache-control', 'no-store');
      return reply.code(204).send(null);
    },
  });

  // Adults change their own password. A student's PIN is set by their parent or School Admin.
  const adults = requireRole(Role.Parent, Role.Teacher, Role.Psychologist, Role.SchoolAdmin, Role.PlatformAdmin);

  // POST /api/v1/auth/change-password — change the caller's own password
  app.post('/change-password', {
    onRequest: [app.authenticate, adults],
    schema: {
      tags: ['Auth'],
      summary: 'Change your password',
      description:
        `${describeRoles(adults.allowedRoles)} Needs the current password. Ends every session of the account and ` +
        'returns a new access and refresh token for this one: this device stays signed in, other devices can no ' +
        'longer refresh (their access token stops working when it expires). A wrong current password returns 400 ' +
        '`INVALID_CURRENT_PASSWORD` and counts toward the login lockout; while the account is locked the answer is ' +
        'the same.',
      security: [{ bearerAuth: [] }],
      body: ChangePasswordBodySchema,
      response: {
        200: RefreshResponseSchema,
        ...errorResponses(400, 401, 403, 500),
      },
    },
    handler: async (request, reply) => {
      const result = await service.changePassword(actorOf(request), request.body);
      reply.header('cache-control', 'no-store');
      return result;
    },
  });
};

export default authRoutes;
