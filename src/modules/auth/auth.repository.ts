// All database access for login / register / authentication.
//
// The register insert, the login lookup and the failed-login counter use Prisma's typed
// raw queries ($queryRaw / $executeRaw tagged templates — every ${value} is sent as a bind
// parameter, never interpolated). They are single atomic statements whose guarantees
// (race-safe duplicate handling, DB-clock lock checks, read-modify-write-free counters)
// can't be expressed through the fluent client without extra round trips or locks.
// Simple lookups and updates use the fluent Prisma Client API.
import type { Db } from '../../shared/db/prisma.js';
import type { Role } from '../../shared/rbac/index.js';

export interface InsertUserInput {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly actorSchoolId: string | null;
  readonly schoolId: string | null;
  readonly parentId: string | null;
  readonly role: Role;
  readonly fullName: string;
  readonly email: string | null;
  readonly studentLoginId: string | null;
  readonly secretHash: string;
}

export interface InsertUserRow {
  is_actor_valid: boolean;
  is_parent_valid: boolean;
  id: string | null;
  role: Role | null;
  school_id: string | null;
  parent_id: string | null;
  full_name: string | null;
  created_at: Date | null;
}

export interface LoginUserRow {
  id: string;
  role: Role;
  school_id: string | null;
  full_name: string;
  secret_hash: string;
  is_active: boolean;
  failed_login_attempts: number;
  is_locked: boolean;
  has_lock: boolean;
}

export interface ActorRow {
  role: Role;
  schoolId: string | null;
  isActive: boolean;
}

export function createAuthRepository(db: Db) {
  return {
    // ---------- Register: ONE round trip ----------
    // In a single statement this: (1) re-checks the caller is still an active user with the
    // role/school in their token (a deactivated admin's unexpired JWT stops working),
    // (2) checks a supplied parent is an active parent in the same school, (3) inserts.
    // Duplicates are caught by the unique indexes, never by a SELECT-then-INSERT, so two
    // concurrent requests for the same email cannot both succeed.
    async insertUser(a: InsertUserInput): Promise<InsertUserRow> {
      const rows = await db.$queryRaw<InsertUserRow[]>`
        WITH actor AS (
          SELECT 1 FROM users
          WHERE id = ${a.actorId}::uuid AND role = ${a.actorRole}::user_role AND is_active
            AND school_id IS NOT DISTINCT FROM ${a.actorSchoolId}::uuid
        ),
        parent AS (
          SELECT 1 FROM users
          WHERE id = ${a.parentId}::uuid AND role = 'parent' AND is_active AND school_id = ${a.schoolId}::uuid
        ),
        ins AS (
          INSERT INTO users (role, school_id, parent_id, full_name, email, student_login_id, secret_hash)
          SELECT ${a.role}::user_role, ${a.schoolId}::uuid, ${a.parentId}::uuid,
                 ${a.fullName}, ${a.email}, ${a.studentLoginId}, ${a.secretHash}
          WHERE EXISTS (SELECT 1 FROM actor)
            AND (${a.parentId}::uuid IS NULL OR EXISTS (SELECT 1 FROM parent))
          RETURNING id, role, school_id, parent_id, full_name, created_at
        )
        SELECT EXISTS (SELECT 1 FROM actor)                                    AS is_actor_valid,
               (${a.parentId}::uuid IS NULL OR EXISTS (SELECT 1 FROM parent)) AS is_parent_valid,
               ins.*
        FROM (SELECT 1) AS one LEFT JOIN ins ON true`;
      const row = rows[0];
      if (!row) throw new Error('insertUser returned no row');
      return row;
    },

    // ---------- Login: ONE indexed lookup; lock state evaluated on the DB clock ----------
    async findUserByEmail(email: string): Promise<LoginUserRow | null> {
      const rows = await db.$queryRaw<LoginUserRow[]>`
        SELECT id, role, school_id, full_name, secret_hash, is_active, failed_login_attempts,
               (locked_until IS NOT NULL AND locked_until > now()) AS is_locked,
               (locked_until IS NOT NULL)                          AS has_lock
        FROM users WHERE email = ${email}`;
      return rows[0] ?? null;
    },

    async findUserByStudentId(studentLoginId: string): Promise<LoginUserRow | null> {
      const rows = await db.$queryRaw<LoginUserRow[]>`
        SELECT id, role, school_id, full_name, secret_hash, is_active, failed_login_attempts,
               (locked_until IS NOT NULL AND locked_until > now()) AS is_locked,
               (locked_until IS NOT NULL)                          AS has_lock
        FROM users WHERE student_login_id = ${studentLoginId}`;
      return rows[0] ?? null;
    },

    // Atomic increment (no read-modify-write race). On reaching the limit the account is
    // locked and the counter restarts, so the next window gets the same allowance.
    async recordFailedLogin(userId: string, maxAttempts: number, lockMinutes: number): Promise<void> {
      await db.$executeRaw`
        UPDATE users SET
          failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= ${maxAttempts}::int THEN 0
                                       ELSE failed_login_attempts + 1 END,
          locked_until          = CASE WHEN failed_login_attempts + 1 >= ${maxAttempts}::int
                                       THEN now() + make_interval(mins => ${lockMinutes}::int)
                                       ELSE locked_until END
        WHERE id = ${userId}::uuid`;
    },

    // Only called when there is something to reset — a clean login costs zero writes.
    async resetFailedLogins(userId: string): Promise<void> {
      await db.user.updateMany({
        where: { id: userId },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    },

    // Authentication: is the token's subject still an active user? (primary-key lookup)
    findActor(userId: string): Promise<ActorRow | null> {
      return db.user.findUnique({
        where: { id: userId },
        select: { role: true, schoolId: true, isActive: true },
      });
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
