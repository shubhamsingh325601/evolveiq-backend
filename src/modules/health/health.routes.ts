// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/students/:studentId/health   GET (parent, teacher, psychologist, school admin)
//                                        PUT (parent, school admin)
//   /api/v1/classes/:classId/health      GET (teacher, school admin)
//
// A student or class outside the caller's scope -> 404, the same as a missing one.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createClassScopeRepository } from '../schools/class-scope.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createHealthRepository } from './health.repository.js';
import {
  ClassHealthResponseSchema,
  ClassIdParamsSchema,
  HealthProfileResponseSchema,
  PutHealthBodySchema,
  StudentIdParamsSchema,
} from './health.schemas.js';
import { createHealthService } from './health.service.js';

export interface HealthRoutesOptions {
  db: Db;
}

const docs = { tags: ['Health'], security: [{ bearerAuth: [] }] };

function serviceFor({ db }: HealthRoutesOptions) {
  return createHealthService({
    repository: createHealthRepository(db),
    students: createStudentScopeRepository(db),
    classes: createClassScopeRepository(db),
  });
}

export const studentHealthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, options) => {
  const service = serviceFor(options);
  const readers = requireRole(Role.Parent, Role.Teacher, Role.Psychologist, Role.SchoolAdmin);
  const writers = requireRole(Role.Parent, Role.SchoolAdmin);
  const scope =
    'Parents: their own children. Teachers: students of their classes. School Admins: their school. Psychologists: any student. Anyone else’s student -> 404.';

  app.get('/:studentId/health', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: "A student's health and care profile",
      description: `${describeRoles(readers.allowedRoles)} ${scope} Nothing recorded yet -> an empty profile with updatedAt null.`,
      params: StudentIdParamsSchema,
      response: { 200: HealthProfileResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ health: await service.get(actorOf(request), request.params.studentId) }),
  });

  app.put('/:studentId/health', {
    onRequest: [app.authenticate, writers],
    schema: {
      ...docs,
      summary: "Record a student's health and care profile",
      description: `${describeRoles(writers.allowedRoles)} ${scope} Replaces the whole profile.`,
      params: StudentIdParamsSchema,
      body: PutHealthBodySchema,
      response: { 200: HealthProfileResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ health: await service.put(actorOf(request), request.params.studentId, request.body) }),
  });
};

export const classHealthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = async (app, options) => {
  const service = serviceFor(options);
  const staff = requireRole(Role.Teacher, Role.SchoolAdmin);

  app.get('/:classId/health', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: 'Health and care profiles of a class',
      description:
        `${describeRoles(staff.allowedRoles)} Teachers: classes they teach. School Admins: their school's classes. ` +
        'Only students with something recorded. Another class -> 404.',
      params: ClassIdParamsSchema,
      response: { 200: ClassHealthResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ profiles: await service.forClass(actorOf(request), request.params.classId) }),
  });
};
