// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   /api/v1/imports/people   POST (school admin: own school; platform admin: the school named)
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { createImportsRepository } from './imports.repository.js';
import { ImportPeopleBodySchema, ImportReportResponseSchema, MAX_IMPORT_ROWS } from './imports.schemas.js';
import { createImportsService } from './imports.service.js';

export interface ImportsRoutesOptions {
  db: Db;
}

/** 500 rows of a few short cells each fit comfortably; the app's default limit is 16 KiB. */
const IMPORT_BODY_LIMIT = 1024 * 1024;

const importsRoutes: FastifyPluginAsyncZod<ImportsRoutesOptions> = async (app, { db }) => {
  const service = createImportsService({ repository: createImportsRepository(db) });
  const admins = requireRole(Role.SchoolAdmin, Role.PlatformAdmin);

  app.post('/people', {
    onRequest: [app.authenticate, admins],
    bodyLimit: IMPORT_BODY_LIMIT,
    schema: {
      tags: ['Imports'],
      security: [{ bearerAuth: [] }],
      summary: 'Import students, teachers or parents',
      description:
        `${describeRoles(admins.allowedRoles)} School Admins import into their own school; Platform Admins name the school. ` +
        `Up to ${MAX_IMPORT_ROWS} rows. Every row is checked with the same rules as an account made by hand; the report ` +
        'lists each row’s problems. With `dryRun: false` and no problems, everything is created in one transaction ' +
        '(new classes included); otherwise nothing is.',
      body: ImportPeopleBodySchema,
      response: { 200: ImportReportResponseSchema, ...errorResponses(400, 401, 403, 409, 422, 500) },
    },
    handler: async (request) => ({ report: await service.importPeople(actorOf(request), request.body) }),
  });
};

export default importsRoutes;
