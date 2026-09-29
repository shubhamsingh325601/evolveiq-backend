// One error type with a stable machine-readable code. Messages are safe to show clients.
export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  validation: (details, message = 'Request validation failed.') =>
    new AppError(400, 'VALIDATION_ERROR', message, details),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required.'),
  // Deliberately identical for unknown user, wrong secret and locked account (anti-enumeration).
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials.'),
  // One answer for malformed, forged, expired, unknown, revoked and re-used refresh tokens.
  invalidRefreshToken: () =>
    new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.'),
  accountDisabled:() => new AppError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated.'),
  forbidden: (message = 'You are not allowed to perform this action.') =>
    new AppError(403, 'FORBIDDEN', message),
  duplicate: (field) =>
    new AppError(409, 'DUPLICATE_ACCOUNT', 'An account with this identifier already exists.', { field }),
  invalidReference: (field, message) =>
    new AppError(422, 'INVALID_REFERENCE', message, { field }),
};
