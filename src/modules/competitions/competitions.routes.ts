// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/competitions                                          GET (teacher, psychologist, school admin, platform admin)
//                                                                  POST (school admin, platform admin)
//   /api/v1/competitions/:competitionId                           PATCH, DELETE (school admin: own school's; platform admin: any)
//   /api/v1/competitions/:competitionId/nominations                POST (teacher)
//   /api/v1/competitions/:competitionId/nominations/:studentId     DELETE (the nominating teacher, school admin, platform admin)
//
// Events & Competitions: a gap found against the client's prototype, not yet confirmed scope
// (see docs/SCOPE_OF_WORK.md, 16 Nov 2026).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createCompetitionsRepository } from './competitions.repository.js';
import {
  CompetitionIdParamsSchema,
  CompetitionListResponseSchema,
  CompetitionResponseSchema,
  CreateCompetitionBodySchema,
  ListCompetitionsQuerySchema,
  NominateBodySchema,
  NominationParamsSchema,
  NominationResponseSchema,
  UpdateCompetitionBodySchema,
} from './competitions.schemas.js';
import { createCompetitionsService } from './competitions.service.js';

export interface CompetitionsRoutesOptions {
  db: Db;
}

const NO_CONTENT = z.null().meta({ description: 'Done. No body.' });

const competitionsRoutes: FastifyPluginAsyncZod<CompetitionsRoutesOptions> = async (app, { db }) => {
  const service = createCompetitionsService({
    repository: createCompetitionsRepository(db),
    students: createStudentScopeRepository(db),
  });
  const readers = requireRole(Role.Teacher, Role.Psychologist, Role.SchoolAdmin, Role.PlatformAdmin);
  const admins = requireRole(Role.SchoolAdmin, Role.PlatformAdmin);
  const teachersOnly = requireRole(Role.Teacher);
  const nominationRemovers = requireRole(Role.Teacher, Role.SchoolAdmin, Role.PlatformAdmin);
  const docs = { tags: ['Competitions'], security: [{ bearerAuth: [] }] };
  const manageNote =
    `${describeRoles(admins.allowedRoles)} School Admins manage their own school's competitions; Platform Admins any. ` +
    'A competition the caller cannot manage -> 404.';

  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'National / State / Inter-School / Intra-School competitions',
      description:
        `${describeRoles(readers.allowedRoles)} Teachers, Psychologists and School Admins see their own school's competitions ` +
        'only; Platform Admins see every school\'s, filterable by `schoolId`. Each competition carries its own nominations list. ' +
        'Standard pagination.',
      querystring: ListCompetitionsQuerySchema,
      response: { 200: CompetitionListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  app.post('', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Enter the school into a competition',
      description:
        `${manageNote} A competition always belongs to exactly one school: Platform Admins must name a real, existing ` +
        '`schoolId` (422 INVALID_REFERENCE for an unknown one) — there is no "every school" option, unlike Notices.',
      body: CreateCompetitionBodySchema,
      response: { 201: CompetitionResponseSchema, ...errorResponses(400, 401, 403, 422, 500) },
    },
    handler: async (request, reply) => reply.code(201).send({ competition: await service.create(actorOf(request), request.body) }),
  });

  app.patch('/:competitionId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Change a competition',
      description: manageNote,
      params: CompetitionIdParamsSchema,
      body: UpdateCompetitionBodySchema,
      response: { 200: CompetitionResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ competition: await service.update(actorOf(request), request.params.competitionId, request.body) }),
  });

  app.delete('/:competitionId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Withdraw a competition',
      description: manageNote,
      params: CompetitionIdParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.competitionId);
      return reply.code(204).send(null);
    },
  });

  app.post('/:competitionId/nominations', {
    onRequest: [app.authenticate, teachersOnly],
    schema: {
      ...docs,
      summary: 'Nominate a student',
      description:
        `${describeRoles(teachersOnly.allowedRoles)} The student must be the teacher's own, by the shared student scope ` +
        '(422 INVALID_REFERENCE otherwise). The competition must belong to the teacher\'s school (404 otherwise). ' +
        'Nominating the same student twice -> 409.',
      params: CompetitionIdParamsSchema,
      body: NominateBodySchema,
      response: { 201: NominationResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 422, 500) },
    },
    handler: async (request, reply) => {
      const nomination = await service.nominate(actorOf(request), request.params.competitionId, request.body);
      return reply.code(201).send({ nomination });
    },
  });

  app.delete('/:competitionId/nominations/:studentId', {
    onRequest: [app.authenticate, nominationRemovers],
    schema: {
      ...docs,
      summary: 'Remove a nomination',
      description:
        `${describeRoles(nominationRemovers.allowedRoles)} The teacher who made the nomination, or School Admin (own school) / ` +
        'Platform Admin, may remove it (a different teacher trying to remove it -> 403). 404 if the nomination or the ' +
        "competition is out of the caller's scope.",
      params: NominationParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.removeNomination(actorOf(request), request.params.competitionId, request.params.studentId);
      return reply.code(204).send(null);
    },
  });
};

export default competitionsRoutes;
