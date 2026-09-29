import { Errors } from '../../lib/errors.js';
import { hashSecret, verifySecret, getDummyHash } from '../../lib/password.js';
import { signAccessToken } from '../../lib/token.js';
import { authorizeRegistration } from './auth.policy.js';
import * as repo from './auth.repository.js';

// Postgres error → API error. Constraint names come from db/migrations/001_auth.sql.
const UNIQUE_FIELD = {
  users_email_key: 'email',
  users_student_login_id_key: 'studentId',
};
const FK_FIELD = {
  users_school_id_fkey: ['schoolId', 'School not found.'],
  users_parent_id_fkey: ['parentId', 'Parent not found in this school.'],
};

export function createAuthService({ db, config, refreshTokens }) {
  async function register(actor, body) {
    // 1. Authorisation (pure, no I/O) — cheapest check first.
    const schoolId = authorizeRegistration(actor, body);

    // 2. Normalise. Schema already guaranteed shape and format.
    const isStudent = body.role === 'student';
    const secret = isStudent ? body.pin : body.password;

    // 3. Hash (thread pool, non-blocking) then 4. single-statement insert.
    const secretHash = await hashSecret(secret);

    let row;
    try {
      row = await repo.insertUser(db, {
        actorId: actor.userId,
        actorRole: actor.role,
        actorSchoolId: actor.schoolId,
        schoolId,
        parentId: body.parentId ?? null,
        role: body.role,
        fullName: body.fullName.trim(),
        email: isStudent ? null : body.email.toLowerCase(),
        studentLoginId: isStudent ? body.studentId.toUpperCase() : null,
        secretHash,
      });
    } catch (err) {
      if (err.code === '23505' && UNIQUE_FIELD[err.constraint]) {
        throw Errors.duplicate(UNIQUE_FIELD[err.constraint]);
      }
      if (err.code === '23503' && FK_FIELD[err.constraint]) {
        throw Errors.invalidReference(...FK_FIELD[err.constraint]);
      }
      throw err; // unexpected → generic 500 from the error handler
    }

    if (!row.actor_ok) throw Errors.unauthenticated(); // token owner deactivated/changed
    if (!row.parent_ok) throw Errors.invalidReference(...FK_FIELD.users_parent_id_fkey);

    return {
      id: row.id,
      role: row.role,
      fullName: row.full_name,
      schoolId: row.school_id,
      parentId: row.parent_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  async function login(body) {
    const isStudent = body.studentId !== undefined;
    const secret = isStudent ? body.pin : body.password;

    const user = isStudent
      ? await repo.findUserByStudentId(db, body.studentId.trim().toUpperCase())
      : await repo.findUserByEmail(db, body.email.trim().toLowerCase());

    // Always run one argon2 verify — against a dummy hash when the user doesn't exist —
    // so response time does not reveal whether an identifier is registered.
    const ok = await verifySecret(user?.secret_hash ?? getDummyHash(), secret);

    // Unknown user and locked account get the same answer as a wrong password.
    if (!user || user.is_locked) throw Errors.invalidCredentials();

    if (!ok) {
      await repo.recordFailedLogin(db, user.id, config.login.maxAttempts, config.login.lockMinutes);
      throw Errors.invalidCredentials();
    }

    // Only revealed to someone who already proved they hold the correct secret.
    if (!user.is_active) throw Errors.accountDisabled();

    if (user.failed_login_attempts > 0 || user.has_lock) {
      await repo.resetFailedLogins(db, user.id);
    }

    const [accessToken, { refreshToken, refreshExpiresIn }] = await Promise.all([
      signAccessToken(config.jwt, user),
      refreshTokens.issue(user.id),
    ]);
    return {
      accessToken,
      tokenType: 'Bearer',
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
