// The shared RBAC guard. ONE place that decides "may this role call this route?".
//
// Authentication and authorisation stay separate:
//   onRequest: [app.authenticate, requireRole(Role.PlatformAdmin)]
//                └ who are you? (401)  └ are you allowed here? (403)
//
// The guard never parses tokens or touches the database; it only reads the actor that
// authentication attached to the request. Finer, data-dependent rules (e.g. "a School Admin
// may only create users in their own school") belong in services, not here.
import type { FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { Errors } from '../errors/app-error.js';
import type { Actor } from './actor.js';
import { ROLE_LABELS, type Role } from './roles.js';

export interface RoleGuard extends onRequestAsyncHookHandler {
  /** The roles this guard admits — exposed for API documentation and tests. */
  readonly allowedRoles: readonly Role[];
}

export function requireRole(...allowed: readonly [Role, ...Role[]]): RoleGuard {
  const allowedSet: ReadonlySet<Role> = new Set(allowed);

  const guard = async function rbacGuard(request: FastifyRequest): Promise<void> {
    const actor = request.actor;
    // Defensive: a route that forgot `app.authenticate` must fail closed, not open.
    if (!actor) throw Errors.unauthenticated();
    if (!allowedSet.has(actor.role)) throw Errors.forbidden();
  };

  return Object.assign(guard, { allowedRoles: Object.freeze([...allowedSet]) });
}

/** The authenticated actor of a guarded route (fails closed if authentication didn't run). */
export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw Errors.unauthenticated();
  return request.actor;
}

/** "Requires role: Platform Admin" — for route descriptions in the API docs. */
export function describeRoles(roles: readonly Role[]): string {
  return `Requires a Bearer access token. Allowed role(s): ${roles.map((r) => ROLE_LABELS[r]).join(', ')}.`;
}
