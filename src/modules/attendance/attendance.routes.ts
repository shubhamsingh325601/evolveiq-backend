// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/classes/:classId/attendance        GET  (teacher, school admin)
//   /api/v1/classes/:classId/attendance/:day   PUT  (teacher, school admin)
//
// Teachers reach the classes they teach, School Admins every class of their school; any other
// class -> 404.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createClassScopeRepository } from '../schools/class-scope.js';
import { createAttendanceRepository } from './attendance.repository.js';
import {
  AttendanceQuerySchema,
  BACKFILL_DAYS,
  ClassAttendanceResponseSchema,
  ClassDayParamsSchema,
  ClassIdParamsSchema,
  MarkAttendanceBodySchema,
  MAX_RANGE_DAYS,
} from './attendance.schemas.js';
import { createAttendanceService } from './attendance.service.js';

export interface AttendanceRoutesOptions {
  db: Db;
  now: () => Date;
}

const attendanceRoutes: FastifyPluginAsyncZod<AttendanceRoutesOptions> = async (app, { db, now }) => {
  const service = createAttendanceService({
    repository: createAttendanceRepository(db),
    classes: createClassScopeRepository(db),
    now,
  });
  const staff = requireRole(Role.Teacher, Role.SchoolAdmin);
  const docs = { tags: ['Attendance'], security: [{ bearerAuth: [] }] };
  const scope = `${describeRoles(staff.allowedRoles)} Teachers: classes they teach. School Admins: their school's classes. Another class -> 404.`;

  app.get('/:classId/attendance', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: "A class's attendance over a range of days",
      description:
        `${scope} Defaults to this month so far. At most ${MAX_RANGE_DAYS} days; no future days. ` +
        'Each student carries their present, late and absent counts and the status of every recorded day.',
      params: ClassIdParamsSchema,
      querystring: AttendanceQuerySchema,
      response: { 200: ClassAttendanceResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({
      attendance: await service.forClass(actorOf(request), request.params.classId, request.query),
    }),
  });

  app.put('/:classId/attendance/:day', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: "Take or correct a day's register",
      description:
        `${scope} Today, or up to ${BACKFILL_DAYS} days back. Every student listed must be in the class (else 422); ` +
        'students left out keep whatever they had. Returns the day as GET would.',
      params: ClassDayParamsSchema,
      body: MarkAttendanceBodySchema,
      response: { 200: ClassAttendanceResponseSchema, ...errorResponses(400, 401, 403, 404, 422, 500) },
    },
    handler: async (request) => ({
      attendance: await service.mark(actorOf(request), request.params.classId, request.params.day, request.body),
    }),
  });
};

export default attendanceRoutes;
