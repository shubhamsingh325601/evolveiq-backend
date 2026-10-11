// AUTHENTICATION (who is calling?) — the only place Bearer access tokens are verified.
// Authorisation (may this role call this route?) is the shared RBAC guard's job:
//   onRequest: [app.authenticate, requireRole(...)]
//
// Runs as an onRequest hook, i.e. BEFORE the body is parsed or validated, so anonymous
// callers are rejected with no parsing, hashing or business work.
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { JwtConfig } from '../../config.js';
import { Errors } from '../../shared/errors/index.js';
import { isRole } from '../../shared/rbac/index.js';
import { verifyAccessToken } from './access-token.js';
import type { AuthRepository } from './auth.repository.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuthenticate(deps: {
  jwt: JwtConfig;
  repository: AuthRepository;
}): onRequestAsyncHookHandler {
  const { jwt, repository } = deps;

  return async function authenticate(request: FastifyRequest): Promise<void> {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (!match?.[1]) throw Errors.unauthenticated();

    let claims;
    try {
      claims = await verifyAccessToken(jwt, match[1]);
    } catch {
      throw Errors.unauthenticated(); // never echo why a token failed
    }
    const { sub, role } = claims;
    const schoolId = typeof claims.sid === 'string' ? claims.sid : null;
    if (typeof sub !== 'string' || !UUID.test(sub) || !isRole(role)) {
      throw Errors.unauthenticated();
    }

    // The token must still describe a live account: a deactivated, deleted, re-roled or
    // moved user's unexpired token stops working immediately (one primary-key lookup).
    const current = await repository.findActor(sub);
    if (!current || !current.isActive || current.role !== role || current.schoolId !== schoolId) {
      throw Errors.unauthenticated();
    }

    request.actor = { userId: sub, role, schoolId };
  };
}
