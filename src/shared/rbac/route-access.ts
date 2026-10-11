// Enforces the CLAUDE.md non-negotiable "every route must declare its allowed roles
// explicitly": at startup, every /api route must EITHER carry a requireRole(...) guard in
// its onRequest hooks OR be explicitly marked public. A route with neither makes the app
// fail to boot, so an unprotected endpoint can't ship by accident.
//
//   app.post('/x', { onRequest: [app.authenticate, requireRole(Role.PlatformAdmin)], ... })
//   app.post('/login', { config: publicAccess(), ... })      // deliberately unauthenticated
import type { RouteOptions } from 'fastify';
import type { RoleGuard } from './require-role.js';

const API_PREFIX = '/api/';

/** Route `config` for endpoints that are deliberately reachable without a token. */
export function publicAccess(): { isPublic: true } {
  return { isPublic: true };
}

function isRoleGuard(hook: unknown): hook is RoleGuard {
  return typeof hook === 'function' && Array.isArray((hook as Partial<RoleGuard>).allowedRoles);
}

/** onRoute hook: throws (aborting startup) when an /api route doesn't declare its access. */
export function assertRouteDeclaresAccess(route: RouteOptions): void {
  if (!route.url.startsWith(API_PREFIX)) return; // /docs etc. are not API routes

  const hooks: unknown[] = route.onRequest === undefined ? [] : [route.onRequest].flat();
  const hasRoleGuard = hooks.some(isRoleGuard);
  const isPublic = (route.config as { isPublic?: unknown } | undefined)?.isPublic === true;
  const label = `${[route.method].flat().join(',')} ${route.url}`;

  if (hasRoleGuard && isPublic) {
    throw new Error(`Route ${label} is marked public but also has a role guard — pick one.`);
  }
  if (!hasRoleGuard && !isPublic) {
    throw new Error(
      `Route ${label} must declare its allowed roles: add requireRole(...) to onRequest ` +
        '(after app.authenticate), or `config: publicAccess()` for an unauthenticated endpoint.',
    );
  }
}
