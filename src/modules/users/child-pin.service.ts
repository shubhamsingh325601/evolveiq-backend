// A parent sets a new PIN for their own child who forgot it (asked for on 21 Nov 2026). Students
// have no email, so this — or their School Admin (POST /users/:userId/set-password) — is how a
// forgotten PIN is replaced. Which children a parent reaches is the shared student scope
// (student-scope.ts): their own, linked children only; anyone else's is "not found".
import { Errors } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import { hashSecret } from '../auth/password.js';
import type { StudentScopeRepository } from './student-scope.js';
import type { UsersRepository } from './users.repository.js';

export function createChildPinService(deps: { students: StudentScopeRepository; users: UsersRepository }) {
  /** The child's login lockout is cleared and every session of theirs ends. */
  async function setPin(actor: Actor, studentId: string, pin: string): Promise<void> {
    const student = await deps.students.findStudent(actor, studentId);
    if (!student) throw Errors.notFound('Student');
    if (!(await deps.users.setSecret(student.id, await hashSecret(pin)))) throw Errors.notFound('Student');
  }

  return { setPin };
}
