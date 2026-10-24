// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/students/:studentId/growth-areas
//   /api/v1/students/:studentId/streak
//   /api/v1/students/:studentId/stars
//   /api/v1/students/:studentId/monthly-summaries/:month
//   /api/v1/students/:studentId/holistic-index
//   /api/v1/students/:studentId/growth-moments
//
// The same parent-safe responses for every allowed audience; who reaches which student is the
// shared student scope (a student outside it → 404).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createProgressRepository } from './progress.repository.js';
import {
  GrowthAreasResponseSchema,
  GrowthMomentListResponseSchema,
  GrowthMomentsQuerySchema,
  HolisticIndexResponseSchema,
  MonthlySummaryParamsSchema,
  MonthlySummaryResponseSchema,
  StarListResponseSchema,
  StarsQuerySchema,
  StreakResponseSchema,
  StudentIdParamsSchema,
} from './progress.schemas.js';
import { createProgressService } from './progress.service.js';

export interface ProgressRoutesOptions {
  db: Db;
  /** The clock (injectable so business-date rules can be tested at any instant). */
  now: () => Date;
}

const progressRoutes: FastifyPluginAsyncZod<ProgressRoutesOptions> = async (app, { db, now }) => {
  const service = createProgressService({
    repository: createProgressRepository(db),
    students: createStudentScopeRepository(db),
    now,
  });

  const viewers = requireRole(Role.Student, Role.Parent, Role.Teacher, Role.Psychologist);
  const scope =
    `${describeRoles(viewers.allowedRoles)} Students: themselves. Parents: their own children. ` +
    'Teachers: students of their classes. Psychologists: any student. Anyone else → 404.';
  const docs = { tags: ['Progress'], security: [{ bearerAuth: [] }] };

  app.get('/:studentId/growth-areas', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'Growth areas',
      description:
        `${scope} Derived from the development areas of the student's "Assign & mark reviewed" ` +
        'reviews: the five most recent, newest first (older ones drop off). Names only.',
      params: StudentIdParamsSchema,
      response: { 200: GrowthAreasResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.growthAreas(actorOf(request), request.params.studentId),
  });

  app.get('/:studentId/streak', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'Activity streak',
      description:
        `${scope} Consecutive calendar days (Asia/Kolkata) with at least one completed activity. ` +
        'All seven days count. If today has no completion yet, it counts from yesterday.',
      params: StudentIdParamsSchema,
      response: { 200: StreakResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.streak(actorOf(request), request.params.studentId),
  });

  app.get('/:studentId/stars', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'Stars',
      description:
        `${scope} One star for every positive observation about the student — something good a ` +
        'teacher or their parent noticed — with the giver\'s own words, name and role. Newest ' +
        'first; paginated (`pagination.total` is the student\'s star count). Nothing clinical: a ' +
        'positive observation has no Level or review, and its learning-behaviour area is left out.',
      params: StudentIdParamsSchema,
      querystring: StarsQuerySchema,
      response: { 200: StarListResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.stars(actorOf(request), request.params.studentId, request.query),
  });

  app.get('/:studentId/monthly-summaries/:month', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'Monthly summary',
      description:
        `${scope} Plain-language template text, parent-safe. Months are Asia/Kolkata calendar ` +
        'months. The current month is built live each time (`isFinal: false`); a finished month ' +
        'is stored on first request and never changes afterwards (`isFinal: true`). A future ' +
        "month → 400; a month before the student's account existed → 404.",
      params: MonthlySummaryParamsSchema,
      response: { 200: MonthlySummaryResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.monthlySummary(actorOf(request), request.params.studentId, request.params.month),
  });

  app.get('/:studentId/holistic-index', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'EvolvIQ Holistic Index',
      description:
        `${scope} A 0–100 development index across five pillars (education, skills, physical, wellbeing, ` +
        'character), worked out from what teachers and parents have noticed and from the activities the child ' +
        'has finished: a documented formula, not a model. Includes the trend by school year and by month, a skill ' +
        'profile, strengths, a playbook, and for each pillar an explainable insight (why, contributing factors, ' +
        'recommended action, confidence). Parent-safe: nothing clinical, no concern counts or Levels.',
      params: StudentIdParamsSchema,
      response: { 200: HolisticIndexResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.holisticIndex(actorOf(request), request.params.studentId),
  });

  app.get('/:studentId/growth-moments', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'Growth moments',
      description:
        `${scope} The child's good days as a timeline, newest first: stars (teacher appreciation and things ` +
        'noticed at home), activities finished, and milestones such as the first star or the tenth activity. ' +
        'Paginated. Parent-safe: a moment never carries an answer, Level or review.',
      params: StudentIdParamsSchema,
      querystring: GrowthMomentsQuerySchema,
      response: { 200: GrowthMomentListResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.growthMoments(actorOf(request), request.params.studentId, request.query),
  });
};

export default progressRoutes;
