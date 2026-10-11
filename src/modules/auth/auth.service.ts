import type { AppConfig } from '../../config.js';
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import { signAccessToken } from './access-token.js';
import { authorizeRegistration } from './auth.policy.js';
import type { AuthRepository } from './auth.repository.js';
import type { LoginBody, RegisterBody } from './auth.schemas.js';
import { getDummyHash, hashSecret, verifySecret } from './password.js';
import type { RefreshTokenService } from './refresh-token.service.js';

// Database constraint → API error. Constraint names come from prisma/migrations.
const UNIQUE_FIELD: Readonly<Record<string, string>> = {
  users_email_key: 'email',
  users_student_login_id_key: 'studentId',
};
const FK_FIELD: Readonly<Record<string, readonly [field: string, message: string]>> = {
  users_school_id_fkey: ['schoolId', 'School not found.'],
  users_parent_id_fkey: ['parentId', 'Parent not found in this school.'],
};
const PARENT_NOT_FOUND = FK_FIELD.users_parent_id_fkey!;

export interface RegisteredUser {
  id: string;
  role: string;
  fullName: string;
  schoolId: string | null;
  parentId: string | null;
  createdAt: string;
}

export function createAuthService(deps: {
  repository: AuthRepository;
  config: AppConfig;
  refreshTokens: RefreshTokenService;
}) {
  const { repository: repo, config, refreshTokens } = deps;

  async function register(actor: Actor, body: RegisterBody): Promise<RegisteredUser> {
    // 1. Business-rule authorisation (pure, no I/O) — "may this actor create this account
    //    in this school?". Route-level role access was already enforced by the RBAC guard.
    const schoolId = authorizeRegistration(actor, body);

    // 2. Normalise. The Zod schema already guaranteed shape and format.
    const secret = body.role === 'student' ? body.pin : body.password;

    // 3. Hash (thread pool, non-blocking) then 4. single-statement insert.
    const secretHash = await hashSecret(secret);

    let row;
    try {
      row = await repo.insertUser({
        actorId: actor.userId,
        actorRole: actor.role,
        actorSchoolId: actor.schoolId,
        schoolId,
        parentId: body.role === 'student' ? (body.parentId ?? null) : null,
        role: body.role,
        fullName: body.fullName.trim(),
        email: body.role === 'student' ? null : body.email.toLowerCase(),
        studentLoginId: body.role === 'student' ? body.studentId.toUpperCase() : null,
        secretHash,
      });
    } catch (err) {
      const violation = constraintViolation(err);
      const field = violation?.constraint && UNIQUE_FIELD[violation.constraint];
      if (violation?.kind === 'unique' && field) throw Errors.duplicate(field);
      const fk = violation?.constraint && FK_FIELD[violation.constraint];
      if (violation?.kind === 'foreign_key' && fk) throw Errors.invalidReference(...fk);
      throw err; // unexpected → generic 500 from the error handler
    }

    if (!row.is_actor_valid) throw Errors.unauthenticated(); // token owner deactivated/changed
    if (!row.is_parent_valid) throw Errors.invalidReference(...PARENT_NOT_FOUND);
    if (!row.id || !row.role || !row.full_name || !row.created_at) {
      throw new Error('insertUser: insert reported success but returned no row');
    }

    return {
      id: row.id,
      role: row.role,
      fullName: row.full_name,
      schoolId: row.school_id,
      parentId: row.parent_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  async function login(body: LoginBody) {
    const isStudent = 'studentId' in body;
    const secret = isStudent ? body.pin : body.password;

    const user = isStudent
      ? await repo.findUserByStudentId(body.studentId.trim().toUpperCase())
      : await repo.findUserByEmail(body.email.trim().toLowerCase());

    // Always run one argon2 verify — against a dummy hash when the user doesn't exist —
    // so response time does not reveal whether an identifier is registered.
    const isSecretValid = await verifySecret(user?.secret_hash ?? getDummyHash(), secret);

    // Unknown user and locked account get the same answer as a wrong password.
    if (!user || user.is_locked) throw Errors.invalidCredentials();

    if (!isSecretValid) {
      await repo.recordFailedLogin(user.id, config.login.maxAttempts, config.login.lockMinutes);
      throw Errors.invalidCredentials();
    }

    // Only revealed to someone who already proved they hold the correct secret.
    if (!user.is_active) throw Errors.accountDisabled();

    if (user.failed_login_attempts > 0 || user.has_lock) {
      await repo.resetFailedLogins(user.id);
    }

    const [accessToken, { refreshToken, refreshExpiresIn }] = await Promise.all([
      signAccessToken(config.jwt, { id: user.id, role: user.role, schoolId: user.school_id }),
      refreshTokens.issue(user.id),
    ]);
    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn: config.jwt.ttlSeconds,
      refreshToken,
      refreshExpiresIn,
      user: {
        id: user.id,
        role: user.role,
        fullName: user.full_name,
        schoolId: user.school_id,
      },
    };
  }

  return { register, login };
}

export type AuthService = ReturnType<typeof createAuthService>;
