import type { Role } from './roles.js';

/**
 * The authenticated caller. Set on `request.actor` by authentication (auth module);
 * read by the RBAC guard and by services that apply finer-grained rules.
 */
export interface Actor {
  readonly userId: string;
  readonly role: Role;
  /** NULL for platform-level roles (Psychologist, Platform Admin). */
  readonly schoolId: string | null;
}
