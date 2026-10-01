// The single error response format used by every endpoint:
//   { "error": { "code": "...", "message": "...", "details"?: [...] | {...} } }
// Declared once as a Zod schema so routes can document it in OpenAPI and the serializer
// enforces it.
import { z } from 'zod';

const FieldIssueSchema = z.object({
  field: z.string().meta({ example: 'name' }),
  message: z.string().meta({ example: 'Too small: expected string to have >=1 characters' }),
});

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'VALIDATION_ERROR' }),
      message: z.string().meta({ example: 'Request validation failed.' }),
      details: z
        .union([z.array(FieldIssueSchema), z.record(z.string(), z.unknown())])
        .optional()
        .meta({ description: 'Per-field problems (validation) or extra context (e.g. { field }).' }),
    }),
  })
  .meta({ id: 'ErrorResponse' });

const DESCRIPTIONS = {
  400: 'Invalid request (VALIDATION_ERROR, BAD_REQUEST).',
  401: 'Missing, invalid or expired access token (UNAUTHENTICATED).',
  403: 'Authenticated, but the role is not allowed (FORBIDDEN).',
  404: 'Resource not found (NOT_FOUND).',
  409: 'Conflict with existing data.',
  422: 'A referenced resource does not exist (INVALID_REFERENCE).',
  500: 'Unexpected server or database error (INTERNAL_ERROR).',
} as const;

export type DocumentedErrorStatus = keyof typeof DESCRIPTIONS;

interface ErrorResponseSpec {
  description: string;
  content: { 'application/json': { schema: typeof ErrorResponseSchema } };
}

/** Response entries for the given error statuses, for a route's `schema.response`. */
export function errorResponses<S extends DocumentedErrorStatus>(
  ...statuses: S[]
): Record<S, ErrorResponseSpec> {
  const out = {} as Record<S, ErrorResponseSpec>;
  for (const status of statuses) {
    out[status] = {
      description: DESCRIPTIONS[status],
      content: { 'application/json': { schema: ErrorResponseSchema } },
    };
  }
  return out;
}
