// HTTP layer only: validation (Zod), RBAC wiring, status codes, headers.
//   Request → authenticate (401) → requireRole(...) (403) → route → service → repository
// Create and rename: Platform Admin. List: Platform Admin and Psychologist. View: every role,
// limited by the service to the caller's own school (Platform Admin and Psychologist: any).
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createSchoolsRepository } from './schools.repository.js';
import {
  CreateSchoolBodySchema,
  ListSchoolsQuerySchema,
  RenameSchoolBodySchema,
  SchoolIdParamsSchema,
  SchoolListResponseSchema,
  SchoolResponseSchema,
} from './schools.schemas.js';
import { createSchoolsService } from './schools.service.js';

export interface SchoolsRoutesOptions {
  db: Db;
}

const schoolsRoutes: FastifyPluginAsyncZod<SchoolsRoutesOptions> = async (app, { db }) => {
  const service = createSchoolsService({ repository: createSchoolsRepository(db) });

  const platformAdminOnly = requireRole(Role.PlatformAdmin);
  const listers = requireRole(Role.PlatformAdmin, Role.Psychologist);
  const viewers = requireRole(
    Role.PlatformAdmin, Role.Psychologist, Role.SchoolAdmin, Role.Teacher, Role.Parent, Role.Student,
  );
  const guarded = { onRequest: [app.authenticate, platformAdminOnly] };
  const docs = {
    tags: ['Schools'],
    security: [{ bearerAuth: [] }],
    description: describeRoles(platformAdminOnly.allowedRoles),
  };

  // POST /api/v1/schools — create a school
  app.post('', {
    ...guarded,
    schema: {
      ...docs,
      summary: 'Create a school',
      body: CreateSchoolBodySchema,
      response: { 201: SchoolResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request, reply) => {
      const school = await service.create(request.body);
      return reply.code(201).header('location', `/api/v1/schools/${school.id}`).send({ school });
    },
  });

  // GET /api/v1/schools — paginated, sortable, filterable list
  app.get('', {
    onRequest: [app.authenticate, listers],
    schema: {
      ...docs,
      summary: 'List schools',
      description:
        `${describeRoles(listers.allowedRoles)} Psychologists read it to filter the review queue ` +
        'by school. Paginated in the database (`page`, `limit` ≤ 100), sortable by ' +
        'an allowlist of fields (`sortBy`, `sortOrder`), filterable by a case-insensitive name ' +
        'substring (`name`).',
      querystring: ListSchoolsQuerySchema,
      response: { 200: SchoolListResponseSchema, ...errorResponses(400, 401, 403, 500) },
    },
    handler: async (request) => service.list(request.query),
  });

  // GET /api/v1/schools/:schoolId — view one school
  app.get('/:schoolId', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'View a school',
      description:
        `${describeRoles(viewers.allowedRoles)} Platform Admins and Psychologists can view any ` +
        "school; everyone else only their own (another school → 404, the same as a missing one).",
      params: SchoolIdParamsSchema,
      response: { 200: SchoolResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ school: await service.getById(actorOf(request), request.params.schoolId) }),
  });

  // PATCH /api/v1/schools/:schoolId — rename a school
  app.patch('/:schoolId', {
    ...guarded,
    schema: {
      ...docs,
      summary: 'Rename a school',
      params: SchoolIdParamsSchema,
      body: RenameSchoolBodySchema,
      response: { 200: SchoolResponseSchema, ...errorResponses(400, 401, 403, 404, 500) },
    },
    handler: async (request) => ({ school: await service.rename(request.params.schoolId, request.body) }),
  });
};

export default schoolsRoutes;
