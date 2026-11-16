// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/support-tickets             GET (teacher, school admin, platform admin)
//                                        POST (teacher, school admin)
//   /api/v1/support-tickets/:ticketId   PATCH (school admin: own school's; platform admin: any) — status only
//
// Psychologists have no school (ARCHITECTURE.md) and a ticket always belongs to one, so the role
// is left out here rather than admitted and then always 403'd or always empty.
//
// The IT Help Desk — a gap found against the client's UI prototype (16 Nov 2026), not yet a
// confirmed client request; the project owner asked to build it so it's ready to demo. See
// docs/SCOPE_OF_WORK.md.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createSupportTicketsRepository } from './support-tickets.repository.js';
import {
  CreateSupportTicketBodySchema,
  ListSupportTicketsQuerySchema,
  SupportTicketIdParamsSchema,
  SupportTicketListResponseSchema,
  SupportTicketResponseSchema,
  UpdateSupportTicketStatusBodySchema,
} from './support-tickets.schemas.js';
import { createSupportTicketsService } from './support-tickets.service.js';

export interface SupportTicketsRoutesOptions {
  db: Db;
}

const supportTicketsRoutes: FastifyPluginAsyncZod<SupportTicketsRoutesOptions> = async (app, { db }) => {
  const service = createSupportTicketsService({ repository: createSupportTicketsRepository(db) });
  const raisers = requireRole(Role.Teacher, Role.SchoolAdmin);
  const readers = requireRole(Role.Teacher, Role.SchoolAdmin, Role.PlatformAdmin);
  const managers = requireRole(Role.SchoolAdmin, Role.PlatformAdmin);
  const docs = { tags: ['Support Tickets'], security: [{ bearerAuth: [] }] };
  const manageNote =
    `${describeRoles(managers.allowedRoles)} School Admins change status for their own school's tickets; Platform Admins any. ` +
    'A ticket the caller cannot manage -> 404.';

  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'IT Help Desk tickets',
      description:
        `${describeRoles(readers.allowedRoles)} School Admins see every ticket for their school; Teachers see ` +
        'only the ones they raised; Platform Admins see every school’s, and may filter by `schoolId`. Newest first, paginated.',
      querystring: ListSupportTicketsQuerySchema,
      response: { 200: SupportTicketListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  app.post('', {
    onRequest: [app.authenticate, raisers],
    schema: {
      ...docs,
      summary: 'Raise a ticket',
      description: `${describeRoles(raisers.allowedRoles)} Always for the caller's own school, starting status \`open\`.`,
      body: CreateSupportTicketBodySchema,
      response: { 201: SupportTicketResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request, reply) => reply.code(201).send({ ticket: await service.create(actorOf(request), request.body) }),
  });

  app.patch('/:ticketId', {
    onRequest: [app.authenticate, managers],
    schema: {
      ...docs,
      summary: 'Change a ticket’s status',
      description: manageNote,
      params: SupportTicketIdParamsSchema,
      body: UpdateSupportTicketStatusBodySchema,
      response: { 200: SupportTicketResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ ticket: await service.updateStatus(actorOf(request), request.params.ticketId, request.body) }),
  });
};

export default supportTicketsRoutes;
