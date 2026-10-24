// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/students/:studentId/consents                    GET (student, parent)
//   /api/v1/students/:studentId/consents/:purpose           PUT (parent)
//   /api/v1/students/:studentId/wellness-checkins           GET (student, parent, teacher, psychologist), POST (student, parent)
//
// Who reaches which student is the shared student scope; a student outside it -> 404.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createWellbeingRepository } from './wellbeing.repository.js';
import {
  CheckinBodySchema,
  CheckinResponseSchema,
  CheckinsQuerySchema,
  CheckinsResponseSchema,
  ConsentBodySchema,
  ConsentListResponseSchema,
  ConsentParamsSchema,
  ConsentResponseSchema,
  StudentIdParamsSchema,
} from './wellbeing.schemas.js';
import { createWellbeingService } from './wellbeing.service.js';

export interface WellbeingRoutesOptions {
  db: Db;
  /** The clock (injectable so business-date rules can be tested at any instant). */
  now: () => Date;
}

const wellbeingRoutes: FastifyPluginAsyncZod<WellbeingRoutesOptions> = async (app, { db, now }) => {
  const service = createWellbeingService({
    repository: createWellbeingRepository(db),
    students: createStudentScopeRepository(db),
    now,
  });

  const family = requireRole(Role.Student, Role.Parent);
  const parentOnly = requireRole(Role.Parent);
  const everyone = requireRole(Role.Student, Role.Parent, Role.Teacher, Role.Psychologist);
  const docs = { tags: ['Wellbeing'], security: [{ bearerAuth: [] }] };

  app.get('/:studentId/consents', {
    onRequest: [app.authenticate, family],
    schema: {
      ...docs,
      summary: 'Where the family stands on consent',
      description:
        `${describeRoles(family.allowedRoles)} Every purpose is listed; one nobody has decided is ` +
        '`granted: false` with `decidedAt: null`.',
      params: StudentIdParamsSchema,
      response: { 200: ConsentListResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ consents: await service.listConsents(actorOf(request), request.params.studentId) }),
  });

  app.put('/:studentId/consents/:purpose', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      ...docs,
      summary: 'Allow or withdraw a purpose (parent)',
      description:
        `${describeRoles(parentOnly.allowedRoles)} A parent decides for their own child; it can be changed ` +
        'at any time. Withdrawing tracking hides the check-ins from everyone; the records are kept.',
      params: ConsentParamsSchema,
      body: ConsentBodySchema,
      response: { 200: ConsentResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({
      consent: await service.setConsent(actorOf(request), request.params.studentId, request.params.purpose, request.body.granted),
    }),
  });

  app.get('/:studentId/wellness-checkins', {
    onRequest: [app.authenticate, everyone],
    schema: {
      ...docs,
      summary: 'Wellbeing check-ins',
      description:
        `${describeRoles(everyone.allowedRoles)} The student and their parent see the check-ins once tracking ` +
        'is allowed. Teachers and psychologists see them only when the family also allows sharing with the school; ' +
        'otherwise `isVisible` is false and the list is empty. Oldest first, with plain averages.',
      params: StudentIdParamsSchema,
      querystring: CheckinsQuerySchema,
      response: { 200: CheckinsResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.listCheckins(actorOf(request), request.params.studentId, request.query),
  });

  app.post('/:studentId/wellness-checkins', {
    onRequest: [app.authenticate, family],
    schema: {
      ...docs,
      summary: 'Record a wellbeing check-in',
      description:
        `${describeRoles(family.allowedRoles)} One per day; a second for the same day replaces the first. ` +
        'Needs the family to have allowed tracking (403 CONSENT_REQUIRED). `day` is today or up to 30 days back.',
      params: StudentIdParamsSchema,
      body: CheckinBodySchema,
      response: { 201: CheckinResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      const checkin = await service.recordCheckin(actorOf(request), request.params.studentId, request.body);
      return reply.code(201).send({ checkin });
    },
  });
};

export default wellbeingRoutes;
