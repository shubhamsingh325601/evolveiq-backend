// HTTP layer only: validation (Zod), RBAC wiring, status codes.
// Parent ↔ student links ("one parent, many children").
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createParentStudentsRepository } from './parent-students.repository.js';
import {
  CreateParentStudentBodySchema,
  ListParentStudentsQuerySchema,
  ParentStudentListResponseSchema,
  ParentStudentResponseSchema,
  StudentIdParamsSchema,
} from './parent-students.schemas.js';
import { createParentStudentsService } from './parent-students.service.js';

export interface ParentStudentsRoutesOptions {
  db: Db;
}

const parentStudentsRoutes: FastifyPluginAsyncZod<ParentStudentsRoutesOptions> = async (app, { db }) => {
  const service = createParentStudentsService({ repository: createParentStudentsRepository(db) });

  const admins = requireRole(Role.PlatformAdmin, Role.SchoolAdmin);
  const readers = requireRole(Role.PlatformAdmin, Role.SchoolAdmin, Role.Parent);
  const docs = { tags: ['Users'], security: [{ bearerAuth: [] }] };

  // POST /api/v1/parent-students — link a parent and a student
  app.post('', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Link a parent to a student',
      description:
        `${describeRoles(admins.allowedRoles)} The student and an active parent must be in the same ` +
        'school; a School Admin only in their own school (otherwise 422 INVALID_REFERENCE, the ' +
        'same as an unknown ID). A student has at most one parent: linking a student who already ' +
        'has one → 409 CONFLICT (unlink first). A parent can have many children.',
      body: CreateParentStudentBodySchema,
      response: { 201: ParentStudentResponseSchema, ...errorResponses(400, 401, 403, 409, 422, 500) },
    },
    handler: async (request, reply) => {
      const link = await service.link(actorOf(request), request.body);
      return reply.code(201).send({ link });
    },
  });

  // GET /api/v1/parent-students — list links
  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'List parent ↔ student links',
      description:
        `${describeRoles(readers.allowedRoles)} Platform Admins see every link, School Admins the ` +
        'links in their school, Parents their own children only. Filter by `parentId` / ' +
        '`studentId`; paginated with `page` / `limit`.',
      querystring: ListParentStudentsQuerySchema,
      response: { 200: ParentStudentListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  // DELETE /api/v1/parent-students/:studentId — unlink a student from their parent
  app.delete('/:studentId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: "Remove a student's parent link",
      description: `${describeRoles(admins.allowedRoles)} A student outside the caller's school, or without a parent, → 404.`,
      params: StudentIdParamsSchema,
      response: { 204: z.null().meta({ description: 'Link removed. No body.' }), ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.unlink(actorOf(request), request.params.studentId);
      return reply.code(204).send(null);
    },
  });
};

export default parentStudentsRoutes;
