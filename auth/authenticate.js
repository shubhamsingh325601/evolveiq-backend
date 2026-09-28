import { Errors } from '../../lib/errors.js';
import { verifyAccessToken } from '../../lib/token.js';
import { ROLES, canRegister } from './auth.policy.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

// onRequest hook for the Register route. Runs BEFORE the body is parsed or validated,
// so anonymous or non-admin callers are rejected with no parsing, hashing or DB work.
export function requireRegistrar(jwtConfig) {
  return async function (request) {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match) throw Errors.unauthenticated();

    let claims;
    try {
      claims = await verifyAccessToken(jwtConfig, match[1]);
    } catch {
      throw Errors.unauthenticated(); // never echo why a token failed
    }
    if (typeof claims.sub !== 'string' || !ROLES.includes(claims.role)) {
      throw Errors.unauthenticated();
    }

    if (!canRegister(claims.role)) throw Errors.forbidden();

    request.actor = {
      userId: claims.sub,
      role: claims.role,
      schoolId: typeof claims.sid === 'string' ? claims.sid : null,
    };
  };
}
