// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/students/:studentId/support-plans   GET, POST  (teacher, psychologist)
//   /api/v1/support-plans/:planId               PATCH      (teacher, psychologist)
//
// Staff only. A student outside the caller's scope -> 404, the same as a missing one.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createSupportRepository } from './support.repository.js';
import {
  CreatePlanBodySchema,
  PlanIdParamsSchema,
  StudentIdParamsSchema,
  SupportPlanListResponseSchema,
  SupportPlanResponseSchema,
  UpdatePlanBodySchema,
} from './support.schemas.js';
import { createSupportService } from './support.service.js';

export interface SupportRoutesOptions {
  db: Db;
  now: () => Date;
}

const docs = { tags: ['Support plans'], security: [{ bearerAuth: [] }] };
const staff = requireRole(Role.Teacher, Role.Psychologist);
const scope = `${describeRoles(staff.allowedRoles)} Teachers: students of their classes. Psychologists: any student. Anyone else's student -> 404. Never shown to parents or students.`;

function serviceFor({ db, now }: SupportRoutesOptions) {
  return createSupportService({ repository: createSupportRepository(db), students: createStudentScopeRepository(db), now });
}

export const studentSupportRoutes: FastifyPluginAsyncZod<SupportRoutesOptions> = async (app, options) => {
  const service = serviceFor(options);

  app.get('/:studentId/support-plans', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: "A student's support plans",
      description: `${scope} Open plans first, then closed ones.`,
      params: StudentIdParamsSchema,
      response: { 200: SupportPlanListResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ plans: await service.list(actorOf(request), request.params.studentId) }),
  });

  app.post('/:studentId/support-plans', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: 'Open a support plan',
      description: scope,
      params: StudentIdParamsSchema,
      body: CreatePlanBodySchema,
      response: { 201: SupportPlanResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      const plan = await service.create(actorOf(request), request.params.studentId, request.body);
      return reply.code(201).send({ plan });
    },
  });
};

export const supportPlansRoutes: FastifyPluginAsyncZod<SupportRoutesOptions> = async (app, options) => {
  const service = serviceFor(options);

  app.patch('/:planId', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: 'Update a support plan',
      description: `${scope} Setting the status to closed stamps the time; moving it back clears it. Plans are never deleted.`,
      params: PlanIdParamsSchema,
      body: UpdatePlanBodySchema,
      response: { 200: SupportPlanResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ plan: await service.update(actorOf(request), request.params.planId, request.body) }),
  });
};
