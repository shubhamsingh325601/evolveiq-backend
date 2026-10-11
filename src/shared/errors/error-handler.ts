// The one place errors become HTTP responses. Every response uses the same shape:
//   { error: { code, message, details? } }
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, type FieldIssue } from './app-error.js';
import { mapPrismaError } from './prisma-errors.js';

const CLIENT_ERROR_CODES: Readonly<Record<number, string>> = {
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

interface ValidationIssue {
  keyword: string;
  instancePath: string;
  message?: string | undefined;
  params: Record<string, unknown>;
}

/** Zod issues → [{ field, message }], with dotted field paths ("user.email"). */
function toFieldIssues(issues: readonly ValidationIssue[], context: string): FieldIssue[] {
  return issues.flatMap((issue): FieldIssue[] => {
    const path = issue.instancePath.split('/').filter(Boolean).join('.');
    if (issue.keyword === 'unrecognized_keys') {
      // Unknown fields are rejected, not silently dropped — name each one.
      const keys = Array.isArray(issue.params.keys) ? (issue.params.keys as string[]) : [];
      return keys.map((key) => ({ field: path ? `${path}.${key}` : key, message: 'is not allowed' }));
    }
    return [{ field: path || context, message: issue.message ?? 'is invalid' }];
  });
}

function send(reply: FastifyReply, err: AppError): FastifyReply {
  return reply.code(err.statusCode).send({
    error: { code: err.code, message: err.message, ...(err.details && { details: err.details }) },
  });
}

export function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) return send(reply, err);

  if (hasZodFastifySchemaValidationErrors(err)) {
    const context = err.validationContext ?? 'body';
    return send(
      reply,
      new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', toFieldIssues(err.validation, context)),
    );
  }

  const mapped = mapPrismaError(err);
  if (mapped) {
    request.log.warn({ err }, 'database error mapped to client error');
    return send(reply, mapped);
  }

  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    // Fastify's own client errors (bad JSON, wrong content-type, too large) — safe messages.
    return send(
      reply,
      new AppError(err.statusCode, CLIENT_ERROR_CODES[err.statusCode] ?? 'BAD_REQUEST', err.message),
    );
  }

  // Unexpected (incl. database/driver errors and response-schema mismatches): log the
  // details server-side, return nothing internal to the client.
  request.log.error(err);
  return send(reply, new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.'));
}
