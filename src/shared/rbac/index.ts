export type { Actor } from './actor.js';
export { actorOf, describeRoles, requireRole, type RoleGuard } from './require-role.js';
export { Role, ROLES, ROLE_LABELS, isRole } from './roles.js';
export { assertRouteDeclaresAccess, publicAccess } from './route-access.js';
