// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/observations          Teacher (write + own list), Psychologist (queue, detail, review)
//   /api/v1/family/observations   Parent (write + own list) — parent-safe responses only
//
// Every route declares exactly one response shape for its audience (see observations.schemas.ts).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createObservationsRepository } from './observations.repository.js';
import {
  ListOwnObservationsQuerySchema,
  ObservationDetailResponseSchema,
  ObservationIdParamsSchema,
  ParentObservationBodySchema,
  ParentObservationListResponseSchema,
  ParentObservationResponseSchema,
  ReviewBodySchema,
  ReviewQueueQuerySchema,
  ReviewQueueResponseSchema,
  ReviewResponseSchema,
  TeacherObservationBodySchema,
  TeacherObservationListResponseSchema,
  TeacherObservationResponseSchema,
} from './observations.schemas.js';
import { createObservationsService } from './observations.service.js';

export interface ObservationsRoutesOptions {
  db: Db;
}

function serviceFor(db: Db) {
  return createObservationsService({
    repository: createObservationsRepository(db),
    students: createStudentScopeRepository(db),
  });
}

const docs = { tags: ['Observations'], security: [{ bearerAuth: [] }] };

export const observationsRoutes: FastifyPluginAsyncZod<ObservationsRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const teacherOnly = requireRole(Role.Teacher);
  const psychologistOnly = requireRole(Role.Psychologist);

  // POST /api/v1/observations — a teacher writes an observation
  app.post('', {
    onRequest: [app.authenticate, teacherOnly],
    schema: {
      ...docs,
      summary: 'Write an observation (teacher)',
      description:
        `${describeRoles(teacherOnly.allowedRoles)} About a student of one of the teacher's classes ` +
        '(otherwise 422 INVALID_REFERENCE, the same as an unknown student). `tone` defaults to ' +
        '"concern" (status "pending", for review); "positive" is a star for the student (status ' +
        '"celebrated", never reviewed) and takes no `level` (400). `level` and ' +
        '`learningBehaviourArea` are optional. Parents use POST /api/v1/family/observations.',
      body: TeacherObservationBodySchema,
      response: { 201: TeacherObservationResponseSchema, ...errorResponses(400, 401, 403, 422, 500) },
    },
    handler: async (request, reply) => {
      const observation = await service.createAsTeacher(actorOf(request), request.body);
      return reply.code(201).send({ observation });
    },
  });

  // GET /api/v1/observations/mine — the teacher's own observations
  app.get('/mine', {
    onRequest: [app.authenticate, teacherOnly],
    schema: {
      ...docs,
      summary: 'My observations (teacher)',
      description:
        `${describeRoles(teacherOnly.allowedRoles)} Only observations this teacher wrote — never other ` +
        "teachers' or parents' — with status, when it was reviewed and the psychologist's " +
        'teacher-only note. Newest first.',
      querystring: ListOwnObservationsQuerySchema,
      response: { 200: TeacherObservationListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.listOwnAsTeacher(actorOf(request), request.query),
  });

  // GET /api/v1/observations — the psychologist's review queue
  app.get('', {
    onRequest: [app.authenticate, psychologistOnly],
    schema: {
      ...docs,
      summary: 'Review queue (psychologist)',
      description:
        `${describeRoles(psychologistOnly.allowedRoles)} Every school. Filters: \`status\` ` +
        '(Pending / Reviewed), `level=significant` (Significant), `authorRole=parent` (From ' +
        'parents), `schoolId` (by school), `studentId`, `area`, `tone` ("concern" leaves the ' +
        "students' stars out). Paginated; by creation time.",
      querystring: ReviewQueueQuerySchema,
      response: { 200: ReviewQueueResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.queue(actorOf(request), request.query),
  });

  // GET /api/v1/observations/:observationId — detail + the student's history
  app.get('/:observationId', {
    onRequest: [app.authenticate, psychologistOnly],
    schema: {
      ...docs,
      summary: 'Observation detail with history (psychologist)',
      description: `${describeRoles(psychologistOnly.allowedRoles)} The observation and the student's other observations (newest first, up to 20).`,
      params: ObservationIdParamsSchema,
      response: { 200: ObservationDetailResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.detail(actorOf(request), request.params.observationId),
  });

  // POST /api/v1/observations/:observationId/review — review (and assign) in one transaction
  app.post('/:observationId/review', {
    onRequest: [app.authenticate, psychologistOnly],
    schema: {
      ...docs,
      summary: 'Review an observation (psychologist)',
      description:
        `${describeRoles(psychologistOnly.allowedRoles)} \`outcome: "assigned"\` ("Assign & mark ` +
        'reviewed") assigns the given activities to the student as recommended assignments; ' +
        '`"no_action"` ("No action needed") assigns nothing. Both mark the observation Reviewed. ' +
        'Everything happens in ONE database transaction: if any part fails, nothing is saved. ' +
        '`developmentArea` is required when the observation is Significant (400). A review cannot ' +
        'be changed: reviewing again → 409. A positive observation is never reviewed → 409. ' +
        'Unknown or archived activity → 422.',
      params: ObservationIdParamsSchema,
      body: ReviewBodySchema,
      response: { 200: ReviewResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 422, 500) },
    },
    handler: async (request) => ({
      observation: await service.review(actorOf(request), request.params.observationId, request.body),
    }),
  });
};

export const familyObservationsRoutes: FastifyPluginAsyncZod<ObservationsRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const parentOnly = requireRole(Role.Parent);
  const familyDocs = { ...docs, tags: ['Family'] };

  // POST /api/v1/family/observations — a parent writes an observation
  app.post('', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      ...familyDocs,
      summary: 'Write an observation (parent)',
      description:
        `${describeRoles(parentOnly.allowedRoles)} About one of the parent's own children (otherwise ` +
        '422 INVALID_REFERENCE). `tone` defaults to "concern"; "positive" is a star for the child, ' +
        'celebrated at once. Parents cannot send `level` or `learningBehaviourArea` (400). ' +
        'The response contains only what the parent wrote and its status.',
      body: ParentObservationBodySchema,
      response: { 201: ParentObservationResponseSchema, ...errorResponses(400, 401, 403, 422, 500) },
    },
    handler: async (request, reply) => {
      const observation = await service.createAsParent(actorOf(request), request.body);
      return reply.code(201).send({ observation });
    },
  });

  // GET /api/v1/family/observations — the parent's own observations
  app.get('', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      ...familyDocs,
      summary: 'My observations (parent)',
      description:
        `${describeRoles(parentOnly.allowedRoles)} Only observations this parent wrote, with their ` +
        'status. Never teacher observations, levels, development areas, notes or reviewer details.',
      querystring: ListOwnObservationsQuerySchema,
      response: { 200: ParentObservationListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.listOwnAsParent(actorOf(request), request.query),
  });
};
