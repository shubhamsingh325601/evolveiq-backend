// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/honours              GET (student, parent, teacher, school admin, platform admin)
//                                POST (school admin)
//   /api/v1/honours/:honourId    DELETE (school admin, own school)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createHonoursRepository } from './honours.repository.js';
import {
  CreateHonourBodySchema,
  HonourIdParamsSchema,
  HonourListResponseSchema,
  HonourResponseSchema,
  ListHonoursQuerySchema,
} from './honours.schemas.js';
import { createHonoursService } from './honours.service.js';

export interface HonoursRoutesOptions {
  db: Db;
  now: () => Date;
}

const NO_CONTENT = z.null().meta({ description: 'Done. No body.' });

const honoursRoutes: FastifyPluginAsyncZod<HonoursRoutesOptions> = async (app, { db, now }) => {
  const service = createHonoursService({ repository: createHonoursRepository(db), now });
  const readers = requireRole(Role.Student, Role.Parent, Role.Teacher, Role.SchoolAdmin, Role.PlatformAdmin);
  const schoolAdminOnly = requireRole(Role.SchoolAdmin);
  const docs = { tags: ['Honours'], security: [{ bearerAuth: [] }] };

  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'The celebration wall',
      description:
        `${describeRoles(readers.allowedRoles)} School Admins and Teachers: their school's wall. Parents: the Staff of the Month ` +
        'and their own children’s honours. Students: the Staff of the Month and their own. Platform Admins: every school. ' +
        'Newest month first; filter by `month` and `kind`.',
      querystring: ListHonoursQuerySchema,
      response: { 200: HonourListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  app.post('', {
    onRequest: [app.authenticate, schoolAdminOnly],
    schema: {
      ...docs,
      summary: 'Name a Staff or Student of the Month',
      description:
        `${describeRoles(schoolAdminOnly.allowedRoles)} A teacher (Staff of the Month) or a student (Student of the Month) ` +
        'of the admin’s school (else 422); the current month or an earlier one. The same person twice for the same month -> 409.',
      body: CreateHonourBodySchema,
      response: { 201: HonourResponseSchema, ...errorResponses(400, 401, 403, 409, 422, 500) },
    },
    handler: async (request, reply) => reply.code(201).send({ honour: await service.create(actorOf(request), request.body) }),
  });

  app.delete('/:honourId', {
    onRequest: [app.authenticate, schoolAdminOnly],
    schema: {
      ...docs,
      summary: 'Take an honour down',
      description: `${describeRoles(schoolAdminOnly.allowedRoles)} Own school only (another -> 404).`,
      params: HonourIdParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.honourId);
      return reply.code(204).send(null);
    },
  });
};

export default honoursRoutes;
