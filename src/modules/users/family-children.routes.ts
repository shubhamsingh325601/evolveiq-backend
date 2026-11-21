// HTTP layer only: a parent sets a new PIN for their own child (asked for on 21 Nov 2026).
// Parent-only endpoints live under /api/v1/family/ (ARCHITECTURE.md).
//   Request → authenticate (401) → requireRole(parent) (403) → route → service (student scope) → repository
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createChildPinService } from './child-pin.service.js';
import { createStudentScopeRepository } from './student-scope.js';
import { createUsersRepository } from './users.repository.js';
import { SetPinBodySchema, StudentIdParamsSchema } from './users.schemas.js';

export interface FamilyChildrenRoutesOptions {
  db: Db;
}

const familyChildrenRoutes: FastifyPluginAsyncZod<FamilyChildrenRoutesOptions> = async (app, { db }) => {
  const service = createChildPinService({
    students: createStudentScopeRepository(db),
    users: createUsersRepository(db),
  });

  const parentsOnly = requireRole(Role.Parent);

  // POST /api/v1/family/children/:studentId/set-pin — a new PIN for the parent's own child
  app.post('/:studentId/set-pin', {
    onRequest: [app.authenticate, parentsOnly],
    schema: {
      tags: ['Family'],
      summary: "Set a new PIN for your child",
      description:
        `${describeRoles(parentsOnly.allowedRoles)} For a child who forgot their PIN: \`pin\` is 6 digits. Clears ` +
        "the child's login lockout and ends every session of theirs. Only the parent's own children; any other " +
        'student returns 404.',
      security: [{ bearerAuth: [] }],
      params: StudentIdParamsSchema,
      body: SetPinBodySchema,
      response: {
        204: z.null().meta({ description: 'Set. No body.' }),
        ...errorResponses(400, 401, 403, 404, 500),
      },
    },
    handler: async (request, reply) => {
      await service.setPin(actorOf(request), request.params.studentId, request.body.pin);
      return reply.code(204).send(null);
    },
  });
};

export default familyChildrenRoutes;
