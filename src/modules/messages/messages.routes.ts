// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
// Family side (registered under /students):
//   /api/v1/students/:studentId/contacts   GET (parent)   who the school lists for this child
//   /api/v1/students/:studentId/messages   GET (parent) one thread, POST (parent) write
// Staff side (registered under /messages):
//   /api/v1/messages                       GET (teacher, psychologist, school admin)  my inbox
//   /api/v1/messages/:studentId            GET the thread with that child's parent, POST reply
//
// Who reaches which student is the shared student scope; a student outside it -> 404.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createStudentScopeRepository } from '../users/student-scope.js';
import { createMessagesRepository } from './messages.repository.js';
import {
  ContactsResponseSchema,
  InboxResponseSchema,
  ReplyBodySchema,
  SendFamilyMessageBodySchema,
  SentResponseSchema,
  StudentIdParamsSchema,
  ThreadQuerySchema,
  ThreadResponseSchema,
} from './messages.schemas.js';
import { createMessagesService } from './messages.service.js';

export interface MessagesRoutesOptions {
  db: Db;
  now: () => Date;
}

function build({ db, now }: MessagesRoutesOptions) {
  return createMessagesService({ repository: createMessagesRepository(db), students: createStudentScopeRepository(db), now });
}

const docs = { tags: ['Messages'], security: [{ bearerAuth: [] }] };

export const familyMessagesRoutes: FastifyPluginAsyncZod<MessagesRoutesOptions> = async (app, options) => {
  const service = build(options);
  const parentOnly = requireRole(Role.Parent);

  app.get('/:studentId/contacts', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      ...docs,
      summary: 'School contacts for a child (parent)',
      description:
        `${describeRoles(parentOnly.allowedRoles)} The child's class teachers, the school's admins and the counsellors. ` +
        'Names and roles only: no phone numbers or email addresses are shared.',
      params: StudentIdParamsSchema,
      response: { 200: ContactsResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ contacts: await service.contacts(actorOf(request), request.params.studentId) }),
  });

  app.get('/:studentId/messages', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      ...docs,
      summary: 'A message thread with one contact (parent)',
      description: `${describeRoles(parentOnly.allowedRoles)} Oldest first. Opening it marks the staff member's replies as read.`,
      params: StudentIdParamsSchema,
      querystring: ThreadQuerySchema,
      response: { 200: ThreadResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.familyThread(actorOf(request), request.params.studentId, request.query.contactId),
  });

  app.post('/:studentId/messages', {
    onRequest: [app.authenticate, parentOnly],
    schema: {
      ...docs,
      summary: 'Write to a school contact (parent)',
      description:
        `${describeRoles(parentOnly.allowedRoles)} Starts the thread or adds to it. The contact must be one of ` +
        "the child's contacts (422 INVALID_REFERENCE otherwise). 1 to 1000 characters.",
      params: StudentIdParamsSchema,
      body: SendFamilyMessageBodySchema,
      response: { 201: SentResponseSchema, ...errorResponses(400, 401, 403, 404, 422, 500) },
    },
    handler: async (request, reply) => {
      const message = await service.send(actorOf(request), request.params.studentId, request.body);
      return reply.code(201).send({ message });
    },
  });
};

export const staffMessagesRoutes: FastifyPluginAsyncZod<MessagesRoutesOptions> = async (app, options) => {
  const service = build(options);
  const staff = requireRole(Role.Teacher, Role.Psychologist, Role.SchoolAdmin);

  app.get('', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: 'My message inbox (staff)',
      description: `${describeRoles(staff.allowedRoles)} One row per child, newest activity first, with how many parent messages are unread.`,
      response: { 200: InboxResponseSchema, ...errorResponses(401, 403, 500) },
    },
    handler: async (request) => service.inbox(actorOf(request)),
  });

  app.get('/:studentId', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: "A thread with a child's parent (staff)",
      description: `${describeRoles(staff.allowedRoles)} Only threads the caller is part of; none yet -> 404. Opening it marks the parent's messages as read.`,
      params: StudentIdParamsSchema,
      response: { 200: ThreadResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => service.staffThread(actorOf(request), request.params.studentId),
  });

  app.post('/:studentId', {
    onRequest: [app.authenticate, staff],
    schema: {
      ...docs,
      summary: "Reply to a child's parent (staff)",
      description: `${describeRoles(staff.allowedRoles)} Staff reply in a thread the parent started (404 when there is none); they do not start threads.`,
      params: StudentIdParamsSchema,
      body: ReplyBodySchema,
      response: { 201: SentResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request, reply) => {
      const message = await service.reply(actorOf(request), request.params.studentId, request.body);
      return reply.code(201).send({ message });
    },
  });
};
