// HTTP layer only: validation (Zod), RBAC wiring, status codes.
// Accounts are created through POST /api/v1/auth/register (same rules); this module lists,
// views, edits, deactivates and reactivates them.
//   Request → authenticate (401) → requireRole(...) (403) → route → service (school scope) → repository
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createUsersRepository } from './users.repository.js';
import {
  ListUsersQuerySchema,
  UpdateUserBodySchema,
  UserIdParamsSchema,
  UserListResponseSchema,
  UserResponseSchema,
} from './users.schemas.js';
import { createUsersService } from './users.service.js';

export interface UsersRoutesOptions {
  db: Db;
}

const SCOPE_NOTE =
  'Platform Admins see every user. School Admins see only students, teachers and parents ' +
  'of their own school.';

const usersRoutes: FastifyPluginAsyncZod<UsersRoutesOptions> = async (app, { db }) => {
  const service = createUsersService({ repository: createUsersRepository(db) });

  const userManagers = requireRole(Role.PlatformAdmin, Role.SchoolAdmin);
  const docs = { tags: ['Users'], security: [{ bearerAuth: [] }] };

  // GET /api/v1/users — paginated, sortable, filterable list
  app.get('', {
    onRequest: [app.authenticate, userManagers],
    schema: {
      ...docs,
      summary: 'List users',
      description:
        `${describeRoles(userManagers.allowedRoles)} ${SCOPE_NOTE} A School Admin who filters by ` +
        'another school or by a role they do not manage gets 403. Paginated in the database ' +
        '(`page`, `limit` ≤ 100), sortable by an allowlist (`sortBy`, `sortOrder`), filterable by ' +
        '`role`, `schoolId`, `isActive` and a case-insensitive name substring (`name`).',
      querystring: ListUsersQuerySchema,
      response: { 200: UserListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  // GET /api/v1/users/:userId — view one user
  app.get('/:userId', {
    onRequest: [app.authenticate, userManagers],
    schema: {
      ...docs,
      summary: 'View a user',
      description: `${describeRoles(userManagers.allowedRoles)} ${SCOPE_NOTE} Users outside the caller's reach return 404.`,
      params: UserIdParamsSchema,
      response: { 200: UserResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ user: await service.getById(actorOf(request), request.params.userId) }),
  });

  // PATCH /api/v1/users/:userId — edit name and login identifier
  app.patch('/:userId', {
    onRequest: [app.authenticate, userManagers],
    schema: {
      ...docs,
      summary: 'Edit a user',
      description:
        `${describeRoles(userManagers.allowedRoles)} ${SCOPE_NOTE} Adults: \`fullName\`, \`email\`. ` +
        'Students: `fullName`, `studentId`. Role, school, parent and passwords/PINs cannot be ' +
        'changed here (any other field → 400). A taken email or student ID → 409 ' +
        '`DUPLICATE_ACCOUNT`. Users outside the reach of the caller return 404.',
      params: UserIdParamsSchema,
      body: UpdateUserBodySchema,
      response: { 200: UserResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request) => ({
      user: await service.update(actorOf(request), request.params.userId, request.body),
    }),
  });

  // POST /api/v1/users/:userId/deactivate — deactivate an account
  app.post('/:userId/deactivate', {
    onRequest: [app.authenticate, userManagers],
    schema: {
      ...docs,
      summary: 'Deactivate a user',
      description:
        `${describeRoles(userManagers.allowedRoles)} ${SCOPE_NOTE} The user can no longer log in ` +
        '(403 ACCOUNT_DISABLED), their existing access tokens stop working on the next request, ' +
        'and all their refresh tokens are revoked. Deactivating an inactive user returns 200 ' +
        'unchanged. Nobody can deactivate their own account (403). Users outside the reach of the caller ' +
        'return 404.',
      params: UserIdParamsSchema,
      response: { 200: UserResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ user: await service.deactivate(actorOf(request), request.params.userId) }),
  });

  // DELETE /api/v1/users/:userId — remove an account that has no records
  app.delete('/:userId', {
    onRequest: [app.authenticate, userManagers],
    schema: {
      ...docs,
      summary: 'Remove a user',
      description:
        `${describeRoles(userManagers.allowedRoles)} ${SCOPE_NOTE} Removes the account with its class place, parent ` +
        'link, health profile and sessions. An account that anything else points at (observations, activities, ' +
        'attendance, reviews, honours…) is kept → 409 `HAS_RECORDS`: deactivate it instead. Nobody can remove their ' +
        'own account (403). Users outside the reach of the caller return 404.',
      params: UserIdParamsSchema,
      response: { 204: z.null().meta({ description: 'Removed. No body.' }), ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.userId);
      return reply.code(204).send(null);
    },
  });

  // POST /api/v1/users/:userId/reactivate — reactivate an account
  app.post('/:userId/reactivate', {
    onRequest: [app.authenticate, userManagers],
    schema: {
      ...docs,
      summary: 'Reactivate a user',
      description:
        `${describeRoles(userManagers.allowedRoles)} ${SCOPE_NOTE} The user can log in again ` +
        '(normal lockout rules apply); sessions revoked at deactivation stay revoked. ' +
        'Reactivating an active user returns 200 unchanged. Nobody can reactivate their own ' +
        'account (403). Users outside the reach of the caller return 404.',
      params: UserIdParamsSchema,
      response: { 200: UserResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ user: await service.reactivate(actorOf(request), request.params.userId) }),
  });
};

export default usersRoutes;
