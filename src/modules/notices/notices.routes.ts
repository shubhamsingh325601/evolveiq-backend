// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/notices             GET (every role), POST (school admin, platform admin)
//   /api/v1/notices/:noticeId   PATCH, DELETE (school admin: own school's; platform admin: any)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createNoticesRepository } from './notices.repository.js';
import {
  CreateNoticeBodySchema,
  ListNoticesQuerySchema,
  NoticeIdParamsSchema,
  NoticeListResponseSchema,
  NoticeResponseSchema,
  UpdateNoticeBodySchema,
} from './notices.schemas.js';
import { createNoticesService } from './notices.service.js';

export interface NoticesRoutesOptions {
  db: Db;
}

const NO_CONTENT = z.null().meta({ description: 'Done. No body.' });

const noticesRoutes: FastifyPluginAsyncZod<NoticesRoutesOptions> = async (app, { db }) => {
  const service = createNoticesService({ repository: createNoticesRepository(db) });
  const everyone = requireRole(Role.Student, Role.Parent, Role.Teacher, Role.Psychologist, Role.SchoolAdmin, Role.PlatformAdmin);
  const admins = requireRole(Role.SchoolAdmin, Role.PlatformAdmin);
  const docs = { tags: ['Notices'], security: [{ bearerAuth: [] }] };
  const manageNote =
    `${describeRoles(admins.allowedRoles)} School Admins manage their own school's notices; Platform Admins any notice. ` +
    'A notice the caller cannot manage -> 404.';

  app.get('', {
    onRequest: [app.authenticate, everyone],
    schema: {
      ...docs,
      summary: 'The notice board',
      description:
        `${describeRoles(everyone.allowedRoles)} Each person sees their school's notices and the ones for every school, ` +
        'for their audience: staff see "everyone" and "staff", parents and students "everyone" and "families", admins all. ' +
        'Psychologists see every school’s staff notices. Pinned first, then newest. Paginated; filter by `category`.',
      querystring: ListNoticesQuerySchema,
      response: { 200: NoticeListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  app.post('', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Post a notice',
      description: `${manageNote} An emergency contact needs a phone number (400). Unknown school -> 422.`,
      body: CreateNoticeBodySchema,
      response: { 201: NoticeResponseSchema, ...errorResponses(400, 401, 403, 422, 500) },
    },
    handler: async (request, reply) => reply.code(201).send({ notice: await service.create(actorOf(request), request.body) }),
  });

  app.patch('/:noticeId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Change a notice',
      description: manageNote,
      params: NoticeIdParamsSchema,
      body: UpdateNoticeBodySchema,
      response: { 200: NoticeResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ notice: await service.update(actorOf(request), request.params.noticeId, request.body) }),
  });

  app.delete('/:noticeId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Take a notice down',
      description: manageNote,
      params: NoticeIdParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.noticeId);
      return reply.code(204).send(null);
    },
  });
};

export default noticesRoutes;
