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
        { name: 'Auth', description: 'Login, token refresh and admin-created registration.' },
        { name: 'Schools', description: 'School management — Platform Admin only.' },
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
