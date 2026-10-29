// The project's single API documentation system:
//   @fastify/swagger builds the OpenAPI 3.1 document from the routes' Zod schemas,
//   Scalar serves the interactive reference (with "Try it" + Bearer auth) at /docs.
//
//   GET /docs               → Scalar API reference
//   GET /docs/openapi.json  → OpenAPI document (JSON)   GET /docs/openapi.yaml → (YAML)
//
// Must be registered BEFORE the routes it documents.
import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

export const DOCS_PREFIX = '/docs';

export async function registerApiDocs(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'EvolvIQ API',
        version: '1.0.0',
        description:
          'EvolvIQ backend REST API (v1).\n\n' +
          '**Authentication:** call `POST /api/v1/auth/login`, then send the returned ' +
          '`accessToken` as `Authorization: Bearer <token>` (in this reference: the ' +
          '"Authentication" box → bearerAuth).\n\n' +
          '**Authorisation (RBAC):** every protected endpoint states its allowed roles. ' +
          'Missing/invalid token → `401 UNAUTHENTICATED`; valid token with a role that is not ' +
          'allowed → `403 FORBIDDEN`.\n\n' +
          '**Errors** always have the shape `{ "error": { "code", "message", "details"? } }`.',
      },
      tags: [
        { name: 'Auth', description: 'Login, token refresh, logout and admin-created registration.' },
        { name: 'Schools', description: 'School management — Platform Admin only.' },
        { name: 'Users', description: 'User management — Platform Admin (all users) and School Admin (own school), parent ↔ student links.' },
        { name: 'Classes', description: 'Classes and their teachers / students — School Admin (own school); Teachers read their own classes.' },
        { name: 'Observations', description: 'Teacher observations and the psychologist review queue (Observe → Review).' },
        { name: 'Activities', description: 'The one global activity library — Psychologists write, Teachers browse.' },
        { name: 'Assignments', description: 'Assigning activities and completing them (Assign → Do).' },
        { name: 'Progress', description: 'Growth areas, streaks and monthly summaries — parent-safe for every audience.' },
        { name: 'Family', description: 'Parent-facing endpoints. Responses contain only what parents may see.' },
        { name: 'Health', description: 'A student’s health and care needs — written by the family or the School Admin, read by school staff.' },
        { name: 'Attendance', description: 'Class registers: present, late or absent, one per student per day.' },
        { name: 'Notices', description: 'The notice board: events, activities, trainings, policy updates and emergency contacts.' },
        { name: 'Staff reviews', description: 'A School Admin’s monthly ratings of each teacher. Private to the admin and the teacher.' },
        { name: 'Honours', description: 'The celebration wall: Staff of the Month and Student of the Month.' },
        { name: 'Imports', description: 'Students, teachers and parents from a spreadsheet, checked row by row.' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access token from POST /api/v1/auth/login or /api/v1/auth/refresh.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(scalarApiReference, {
    routePrefix: DOCS_PREFIX,
    configuration: {
      pageTitle: 'EvolvIQ API Reference',
      persistAuth: true,
      authentication: { preferredSecurityScheme: 'bearerAuth' },
    },
  });
}
