// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/trainings                        GET (teacher, psychologist, school admin, platform admin)
//                                             POST (school admin, platform admin)
//   /api/v1/trainings/:trainingId            PATCH, DELETE (school admin: own school's; platform admin: any)
//   /api/v1/trainings/:trainingId/enrolment  POST (teacher, psychologist) enrol; PATCH mark complete
//
// A gap found against the client's prototype, not yet confirmed scope (SCOPE_OF_WORK.md, 16 Nov
// 2026). Deliberately a dumb CRUD list of two things — no completion-rate or "X% of staff"
// endpoint; that number is the frontend's job from these same list endpoints.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createTrainingsRepository } from './trainings.repository.js';
import {
  CreateTrainingBodySchema,
  EnrolmentResponseSchema,
  ListTrainingsQuerySchema,
  TrainingIdParamsSchema,
  TrainingListResponseSchema,
  TrainingResponseSchema,
  UpdateTrainingBodySchema,
} from './trainings.schemas.js';
import { createTrainingsService } from './trainings.service.js';

export interface TrainingsRoutesOptions {
  db: Db;
  now: () => Date;
}

const NO_CONTENT = z.null().meta({ description: 'Done. No body.' });

const trainingsRoutes: FastifyPluginAsyncZod<TrainingsRoutesOptions> = async (app, { db, now }) => {
  const service = createTrainingsService({ repository: createTrainingsRepository(db), now });
  const readers = requireRole(Role.Teacher, Role.Psychologist, Role.SchoolAdmin, Role.PlatformAdmin);
  const admins = requireRole(Role.SchoolAdmin, Role.PlatformAdmin);
  const enrollers = requireRole(Role.Teacher, Role.Psychologist);
  const docs = { tags: ['Training Hub'], security: [{ bearerAuth: [] }] };
  const manageNote =
    `${describeRoles(admins.allowedRoles)} School Admins manage their own school's trainings; Platform Admins any training. ` +
    'A training the caller cannot manage -> 404.';

  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'Staff trainings on offer',
      description:
        `${describeRoles(readers.allowedRoles)} Teachers and School Admins: their school's trainings and the ones for every ` +
        'school. Psychologists and Platform Admins: every school’s (they work across schools). Newest first. Paginated; ' +
        'filter by `requirement`. Each row carries the caller’s own enrolment, if any — never another staff member’s.',
      querystring: ListTrainingsQuerySchema,
      response: { 200: TrainingListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  app.post('', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Offer a training',
      description: `${manageNote} Unknown school -> 422.`,
      body: CreateTrainingBodySchema,
      response: { 201: TrainingResponseSchema, ...errorResponses(400, 401, 403, 422, 500) },
    },
    handler: async (request, reply) => reply.code(201).send({ training: await service.create(actorOf(request), request.body) }),
  });

  app.patch('/:trainingId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Change a training',
      description: manageNote,
      params: TrainingIdParamsSchema,
      body: UpdateTrainingBodySchema,
      response: { 200: TrainingResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ training: await service.update(actorOf(request), request.params.trainingId, request.body) }),
  });

  app.delete('/:trainingId', {
    onRequest: [app.authenticate, admins],
    schema: {
      ...docs,
      summary: 'Take a training down',
      description: manageNote,
      params: TrainingIdParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.trainingId);
      return reply.code(204).send(null);
    },
  });

  app.post('/:trainingId/enrolment', {
    onRequest: [app.authenticate, enrollers],
    schema: {
      ...docs,
      summary: 'Enrol in a training',
      description:
        `${describeRoles(enrollers.allowedRoles)} The training must be one the caller can see (their school, or every school) ` +
        '-> 404 otherwise. Already enrolled -> 409.',
      params: TrainingIdParamsSchema,
      response: { 201: EnrolmentResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request, reply) =>
      reply.code(201).send({ enrolment: await service.enrol(actorOf(request), request.params.trainingId) }),
  });

  app.patch('/:trainingId/enrolment', {
    onRequest: [app.authenticate, enrollers],
    schema: {
      ...docs,
      summary: 'Mark my enrolment complete',
      description: `${describeRoles(enrollers.allowedRoles)} The caller's own enrolment only; never enrolled -> 404.`,
      params: TrainingIdParamsSchema,
      response: { 200: EnrolmentResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ enrolment: await service.markComplete(actorOf(request), request.params.trainingId) }),
  });
};

export default trainingsRoutes;
