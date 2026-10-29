// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/staff-reviews                    GET (school admin: their school; teacher: their own)
//   /api/v1/staff-reviews/:staffId/:month    PUT, DELETE (school admin)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStaffReviewsRepository } from './staff-reviews.repository.js';
import {
  ListStaffReviewsQuerySchema,
  PutStaffReviewBodySchema,
  StaffMonthParamsSchema,
  StaffReviewListResponseSchema,
  StaffReviewResponseSchema,
} from './staff-reviews.schemas.js';
import { createStaffReviewsService } from './staff-reviews.service.js';

export interface StaffReviewsRoutesOptions {
  db: Db;
  now: () => Date;
}

const NO_CONTENT = z.null().meta({ description: 'Done. No body.' });

const staffReviewsRoutes: FastifyPluginAsyncZod<StaffReviewsRoutesOptions> = async (app, { db, now }) => {
  const service = createStaffReviewsService({ repository: createStaffReviewsRepository(db), now });
  const readers = requireRole(Role.SchoolAdmin, Role.Teacher);
  const schoolAdminOnly = requireRole(Role.SchoolAdmin);
  const docs = { tags: ['Staff reviews'], security: [{ bearerAuth: [] }] };
  const writeNote = `${describeRoles(schoolAdminOnly.allowedRoles)} Teachers of the admin's own school only (another -> 404).`;

  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'Staff reviews',
      description:
        `${describeRoles(readers.allowedRoles)} School Admins: every review in their school. Teachers: their own only ` +
        '(asking for someone else -> 403). Filter by `month` and `staffId`. Paginated.',
      querystring: ListStaffReviewsQuerySchema,
      response: { 200: StaffReviewListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  app.put('/:staffId/:month', {
    onRequest: [app.authenticate, schoolAdminOnly],
    schema: {
      ...docs,
      summary: "Rate a teacher's month",
      description: `${writeNote} Five ratings from 1 to 5 and an optional comment. Writing again replaces the month's review. No future months.`,
      params: StaffMonthParamsSchema,
      body: PutStaffReviewBodySchema,
      response: { 200: StaffReviewResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({
      review: await service.put(actorOf(request), request.params.staffId, request.params.month, request.body),
    }),
  });

  app.delete('/:staffId/:month', {
    onRequest: [app.authenticate, schoolAdminOnly],
    schema: {
      ...docs,
      summary: 'Take a review back',
      description: `${writeNote} No review for that month -> 404.`,
      params: StaffMonthParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.staffId, request.params.month);
      return reply.code(204).send(null);
    },
  });
};

export default staffReviewsRoutes;
