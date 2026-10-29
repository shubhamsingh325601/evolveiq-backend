// HTTP layer only: validation (Zod), RBAC wiring, status codes.
// Classes are managed by the School Admin of their school; teachers can read the classes
// they are assigned to. The school always comes from the caller's token.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createClassesRepository } from './classes.repository.js';
import {
  ClassBodySchema,
  ClassDetailResponseSchema,
  ClassIdParamsSchema,
  ClassListResponseSchema,
  ClassResponseSchema,
  ClassStudentParamsSchema,
  ClassTeacherParamsSchema,
  ListClassesQuerySchema,
} from './classes.schemas.js';
import { createClassesService } from './classes.service.js';

export interface ClassesRoutesOptions {
  db: Db;
}

const NO_CONTENT = z.null().meta({ description: 'Done. No body.' });

const classesRoutes: FastifyPluginAsyncZod<ClassesRoutesOptions> = async (app, { db }) => {
  const service = createClassesService({ repository: createClassesRepository(db) });

  const schoolAdminOnly = requireRole(Role.SchoolAdmin);
  const readers = requireRole(Role.SchoolAdmin, Role.Teacher);
  const docs = { tags: ['Classes'], security: [{ bearerAuth: [] }] };
  const adminOnly = { onRequest: [app.authenticate, schoolAdminOnly] };
  const adminNote = `${describeRoles(schoolAdminOnly.allowedRoles)} Own school only; the school comes from the token.`;

  // POST /api/v1/classes — create a class in the caller's school
  app.post('', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Create a class',
      description: `${adminNote} Names are unique within a school ignoring case ("Class A" = "class a") → 409 CONFLICT.`,
      body: ClassBodySchema,
      response: { 201: ClassResponseSchema, ...errorResponses(400, 401, 403, 409, 500) },
    },
    handler: async (request, reply) => {
      const created = await service.create(actorOf(request), request.body);
      return reply.code(201).header('location', `/api/v1/classes/${created.id}`).send({ class: created });
    },
  });

  // GET /api/v1/classes — list
  app.get('', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'List classes',
      description:
        `${describeRoles(readers.allowedRoles)} School Admins see every class of their school, ` +
        'Teachers only the classes they are assigned to. Paginated, sortable (`name`, `createdAt`), ' +
        'filterable by a case-insensitive name substring.',
      querystring: ListClassesQuerySchema,
      response: { 200: ClassListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(actorOf(request), request.query),
  });

  // GET /api/v1/classes/:classId — class with its teachers and students
  app.get('/:classId', {
    onRequest: [app.authenticate, readers],
    schema: {
      ...docs,
      summary: 'View a class with its teachers and students',
      description:
        `${describeRoles(readers.allowedRoles)} A class of another school, or (for a Teacher) a ` +
        'class they are not assigned to → 404.',
      params: ClassIdParamsSchema,
      response: { 200: ClassDetailResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.getDetail(actorOf(request), request.params.classId),
  });

  // PATCH /api/v1/classes/:classId — rename
  app.patch('/:classId', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Rename a class',
      description: `${adminNote} A name already used in the school (any case) → 409.`,
      params: ClassIdParamsSchema,
      body: ClassBodySchema,
      response: { 200: ClassResponseSchema, ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request) => ({ class: await service.rename(actorOf(request), request.params.classId, request.body) }),
  });

  // DELETE /api/v1/classes/:classId — delete a class
  app.delete('/:classId', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Delete a class',
      description:
        `${adminNote} Its teachers are unassigned and its students left without a class (they stay at the school ` +
        'and keep every record). Another school’s class → 404.',
      params: ClassIdParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.remove(actorOf(request), request.params.classId);
      return reply.code(204).send(null);
    },
  });

  // PUT / DELETE /api/v1/classes/:classId/teachers/:teacherId — assign / unassign a teacher
  app.put('/:classId/teachers/:teacherId', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Assign a teacher to a class',
      description: `${adminNote} The teacher must be a teacher of the same school (else 404). Idempotent.`,
      params: ClassTeacherParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.addTeacher(actorOf(request), request.params.classId, request.params.teacherId);
      return reply.code(204).send(null);
    },
  });

  app.delete('/:classId/teachers/:teacherId', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Remove a teacher from a class',
      description: `${adminNote} Not assigned → 404.`,
      params: ClassTeacherParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.removeTeacher(actorOf(request), request.params.classId, request.params.teacherId);
      return reply.code(204).send(null);
    },
  });

  // PUT / DELETE /api/v1/classes/:classId/students/:studentId — add / remove a student
  app.put('/:classId/students/:studentId', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Add a student to a class',
      description:
        `${adminNote} The student must be a student of the same school (else 404). A student ` +
        'belongs to one class: already in this class → 204 (idempotent); in another class → 409 ' +
        '(remove them from it first).',
      params: ClassStudentParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 409, 500) },
    },
    handler: async (request, reply) => {
      await service.addStudent(actorOf(request), request.params.classId, request.params.studentId);
      return reply.code(204).send(null);
    },
  });

  app.delete('/:classId/students/:studentId', {
    ...adminOnly,
    schema: {
      ...docs,
      summary: 'Remove a student from a class',
      description: `${adminNote} Not in this class → 404.`,
      params: ClassStudentParamsSchema,
      response: { 204: NO_CONTENT, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      await service.removeStudent(actorOf(request), request.params.classId, request.params.studentId);
      return reply.code(204).send(null);
    },
  });
};

export default classesRoutes;
