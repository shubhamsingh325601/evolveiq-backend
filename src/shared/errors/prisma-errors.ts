// Prisma Client errors → typed AppErrors.
//
// Repositories/services translate the cases they expect (e.g. "school not found",
// "duplicate email") explicitly. mapPrismaError is the safety net in the global error
// handler so an unexpected constraint violation never surfaces with driver details, and
// never leaks SQL or constraint names to the client.
import { Prisma } from '../../generated/prisma/client.js';
import { AppError, Errors } from './app-error.js';

export function isPrismaKnownError(
  err: unknown,
  code?: string,
): err is Prisma.PrismaClientKnownRequestError {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && (code === undefined || err.code === code)
  );
}

export interface ConstraintViolation {
  readonly kind: 'unique' | 'foreign_key';
  /** Postgres constraint / index name, e.g. "users_email_key". */
  readonly constraint: string | null;
}

interface DriverAdapterCause {
  originalCode?: unknown;
  constraint?: { index?: unknown } | null;
}

const PG_KIND: Readonly<Record<string, ConstraintViolation['kind']>> = {
  '23505': 'unique',
  '23503': 'foreign_key',
};

/**
 * Unique / foreign-key violations from either the fluent client (P2002 / P2003) or a raw
 * query (P2010, Postgres SQLSTATE in the driver-adapter cause), with the constraint name.
 */
export function constraintViolation(err: unknown): ConstraintViolation | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (err.meta?.driverAdapterError as { cause?: DriverAdapterCause } | undefined)?.cause;
  const pgCode = typeof cause?.originalCode === 'string' ? cause.originalCode : undefined;
  const kind =
    (pgCode && PG_KIND[pgCode]) ??
    (err.code === 'P2002' ? 'unique' : err.code === 'P2003' ? 'foreign_key' : undefined);
  if (!kind) return null;
  const index = cause?.constraint?.index;
  return { kind, constraint: typeof index === 'string' ? index : null };
}

export function mapPrismaError(err: unknown): AppError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const violation = constraintViolation(err);
  if (violation?.kind === 'unique') return Errors.conflict();
  if (err.code === 'P2025') return new AppError(404, 'NOT_FOUND', 'Resource not found.');
  return null; // everything else is an unexpected server/database error → 500
}
