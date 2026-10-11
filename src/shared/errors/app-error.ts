// Typed application errors. Every error a client can see is an AppError with a stable,
// machine-readable code; the error handler maps it to the HTTP status it carries.
// Messages are safe to show to clients.

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export type ErrorDetails = readonly FieldIssue[] | Readonly<Record<string, unknown>>;

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (details?: readonly FieldIssue[], message = 'Request validation failed.') =>
    new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required.'),
  // Deliberately identical for unknown user, wrong secret and locked account (anti-enumeration).
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials.'),
  // One answer for malformed, forged, expired, unknown, revoked and re-used refresh tokens.
  invalidRefreshToken: () =>
    new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.'),
  accountDisabled: () => new AppError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated.'),
  forbidden: (message = 'You are not allowed to perform this action.') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (resource: string) => new AppError(404, 'NOT_FOUND', `${resource} not found.`),
  duplicate: (field: string) =>
    new AppError(409, 'DUPLICATE_ACCOUNT', 'An account with this identifier already exists.', { field }),
  conflict: (message = 'The request conflicts with the current state of the resource.') =>
    new AppError(409, 'CONFLICT', message),
  invalidReference: (field: string, message: string) =>
    new AppError(422, 'INVALID_REFERENCE', message, { field }),
  internal: () => new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.'),
} as const;
