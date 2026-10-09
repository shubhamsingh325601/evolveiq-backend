// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/activities                      library: Psychologist (write, archive), Teacher (browse)
//   /api/v1/assignments                     Teacher: direct assignment; Student: own assignments
//   /api/v1/activity-completions            Student: submit an answer
//   /api/v1/students/:studentId/assignments Teacher (own classes), Psychologist: with answers
//   /api/v1/family/children/:studentId/assignments  Parent: done / not done only
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createActivitiesRepository } from './activities.repository.js';
import {
  ActivityIdParamsSchema,
  ActivityListResponseSchema,
  ActivityResponseSchema,
  CompletionResponseSchema,
  CreateActivityBodySchema,
  CreateAssignmentBodySchema,
  CreateCompletionBodySchema,
  FamilyAssignmentListResponseSchema,
  ListActivitiesQuerySchema,
  ListAssignmentsQuerySchema,
  StaffAssignmentListResponseSchema,
  StaffAssignmentResponseSchema,
  StudentAssignmentListResponseSchema,
  StudentIdParamsSchema,
  UpdateActivityBodySchema,
} from './activities.schemas.js';
import { createActivitiesService } from './activities.service.js';

export interface ActivitiesRoutesOptions {
  db: Db;
}

function serviceFor(db: Db) {
  return createActivitiesService({ repository: createActivitiesRepository(db), students: createStudentScopeRepository(db) });
}

const security = [{ bearerAuth: [] }];

// ───────────────────────────── /api/v1/activities ─────────────────────────────
export const activitiesRoutes: FastifyPluginAsyncZod<ActivitiesRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const psychologistOnly = requireRole(Role.Psychologist);
  const browsers = requireRole(Role.Psychologist, Role.Teacher);
  const docs = { tags: ['Activities'], security };

  app.post('', {
    onRequest: [app.authenticate, psychologistOnly],
    schema: {
      ...docs,
      summary: 'Create an activity',
      description: `${describeRoles(psychologistOnly.allowedRoles)} Adds to the one global library. \`content\` is one of the five types.`,
      body: CreateActivityBodySchema,
      response: { 201: ActivityResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request, reply) => {
      const activity = await service.createActivity(actorOf(request), request.body);
      return reply.code(201).header('location', `/api/v1/activities/${activity.id}`).send({ activity });
    },
  });

  app.get('', {
    onRequest: [app.authenticate, browsers],
    schema: {
      ...docs,
      summary: 'Browse the activity library',
      description:
        `${describeRoles(browsers.allowedRoles)} Active activities by default. Psychologists can ` +
        'list archived ones with `isArchived=true` (Teachers → 403). Filter by `type` and title.',
      querystring: ListActivitiesQuerySchema,
      response: { 200: ActivityListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.listActivities(actorOf(request), request.query),
  });

  app.get('/:activityId', {
    onRequest: [app.authenticate, browsers],
    schema: {
      ...docs,
      summary: 'View an activity',
      description: `${describeRoles(browsers.allowedRoles)} Archived activities are visible to Psychologists only (404 for Teachers).`,
      params: ActivityIdParamsSchema,
      response: { 200: ActivityResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ activity: await service.getActivity(actorOf(request), request.params.activityId) }),
  });

  app.patch('/:activityId', {
    onRequest: [app.authenticate, psychologistOnly],
    schema: {
      ...docs,
      summary: 'Edit an activity',
      description:
        `${describeRoles(psychologistOnly.allowedRoles)} Change the title and/or replace the content. ` +
        "Once assigned, the type and options can't change (409): archive it and create a new one.",
      params: ActivityIdParamsSchema,
      body: UpdateActivityBodySchema,
      response: { 200: ActivityResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request) => ({
      activity: await service.updateActivity(actorOf(request), request.params.activityId, request.body),
    }),
  });

  app.post('/:activityId/archive', {
    onRequest: [app.authenticate, psychologistOnly],
    schema: {
      ...docs,
      summary: 'Archive an activity',
      description:
        `${describeRoles(psychologistOnly.allowedRoles)} Activities are never deleted. An archived ` +
        'activity can no longer be assigned; existing assignments keep working. Idempotent.',
      params: ActivityIdParamsSchema,
      response: { 200: ActivityResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ activity: await service.archiveActivity(actorOf(request), request.params.activityId) }),
  });
};

// ───────────────────────────── /api/v1/assignments ─────────────────────────────
export const assignmentsRoutes: FastifyPluginAsyncZod<ActivitiesRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const teacherOnly = requireRole(Role.Teacher);
  const studentOnly = requireRole(Role.Student);
  const docs = { tags: ['Assignments'], security };

  app.post('', {
    onRequest: [app.authenticate, teacherOnly],
    schema: {
      ...docs,
      summary: 'Assign an activity (teacher, direct)',
      description:
        `${describeRoles(teacherOnly.allowedRoles)} To a student of one of the teacher's classes ` +
        '(otherwise 422, the same as an unknown student). The activity must not be archived (422). ' +
        'Psychologists assign through an observation review instead.',
      body: CreateAssignmentBodySchema,
      response: { 201: StaffAssignmentResponseSchema, ...errorResponses(400, 401, 403, 422, 500) },
    },
    handler: async (request, reply) => {
      const assignment = await service.assignDirect(actorOf(request), request.body);
      return reply.code(201).send({ assignment });
    },
  });

  app.get('/mine', {
    onRequest: [app.authenticate, studentOnly],
    schema: {
      ...docs,
      summary: 'My assignments (student)',
      description: `${describeRoles(studentOnly.allowedRoles)} The student's own assignments with the activity to do and their own answer. Newest first.`,
      querystring: ListAssignmentsQuerySchema,
      response: { 200: StudentAssignmentListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.listMine(actorOf(request), request.query),
  });
};

// ───────────────────────────── /api/v1/activity-completions ─────────────────────────────
export const activityCompletionsRoutes: FastifyPluginAsyncZod<ActivitiesRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const studentOnly = requireRole(Role.Student);

  app.post('', {
    onRequest: [app.authenticate, studentOnly],
    schema: {
      tags: ['Assignments'],
      security,
      summary: 'Complete an assignment (student)',
      description:
        `${describeRoles(studentOnly.allowedRoles)} Answer one of your own assignments (someone ` +
        "else's → 404). One completion per assignment: no reattempts (409). `answer.type` must " +
        "match the activity's type, and an `optionId` must be one of its options (400).",
      body: CreateCompletionBodySchema,
      response: { 201: CompletionResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request, reply) => {
      const completion = await service.complete(actorOf(request), request.body);
      return reply.code(201).send({ completion });
    },
  });
};

// ───────────────────────────── /api/v1/students/:studentId/assignments ─────────────────────────────
export const studentAssignmentsRoutes: FastifyPluginAsyncZod<ActivitiesRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const staff = requireRole(Role.Teacher, Role.Psychologist);

  app.get('/:studentId/assignments', {
    onRequest: [app.authenticate, staff],
    schema: {
      tags: ['Assignments'],
      security,
      summary: "A student's assignments (teacher, psychologist)",
      description:
        `${describeRoles(staff.allowedRoles)} With the student's answers. Teachers only for ` +
        'students of their own classes (anyone else → 404).',
      params: StudentIdParamsSchema,
      querystring: ListAssignmentsQuerySchema,
      response: { 200: StaffAssignmentListResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.listForStaff(actorOf(request), request.params.studentId, request.query),
  });
};

// ───────────────────────────── /api/v1/family/children ─────────────────────────────
export const familyAssignmentsRoutes: FastifyPluginAsyncZod<ActivitiesRoutesOptions> = async (app, { db }) => {
  const service = serviceFor(db);
  const parentOnly = requireRole(Role.Parent);

  app.get('/:studentId/assignments', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      tags: ['Family'],
      security,
      summary: "My child's activities (parent)",
      description:
        `${describeRoles(parentOnly.allowedRoles)} Each activity's title and whether it is done. ` +
        "Never the child's answers. Only the parent's own children (anyone else → 404).",
      params: StudentIdParamsSchema,
      querystring: ListAssignmentsQuerySchema,
      response: { 200: FamilyAssignmentListResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.listForParent(actorOf(request), request.params.studentId, request.query),
  });
};
