// Refresh-token storage. Rotation is ONE atomic SQL statement (see below), issued through
// Prisma's parameterised $queryRaw; plain inserts use the fluent client.
import type { Db } from '../../shared/db/prisma.js';
import type { Role } from '../../shared/rbac/index.js';

export interface RotateResultRow {
  /** The presented token was live (not revoked, not expired) and is now revoked. */
  was_token_live: boolean;
  /** A successor token was inserted. */
  is_rotated: boolean;
  id: string | null;
  role: Role | null;
  school_id: string | null;
  is_active: boolean | null;
}

export function createRefreshTokenRepository(db: Db) {
  return {
    // Login: start a new token family (family_id = first token's jti).
    async insertRefreshToken(t: { jti: string; userId: string; familyId: string; expiresAt: number }) {
      await db.refreshToken.create({
        data: {
          jti: t.jti,
          userId: t.userId,
          familyId: t.familyId,
          expiresAt: new Date(t.expiresAt * 1000),
        },
        select: { jti: true },
      });
    },

    // Refresh: ONE statement that
    //   1. revokes the presented token only if it is live (not revoked, not expired),
    //   2. reads the user's CURRENT role / school / active flag,
    //   3. inserts the successor token in the same family — only if 1 succeeded and the
    //      user is active.
    // Step 1 is a conditional UPDATE: under concurrent use of the same token, Postgres
    // row-locks it and re-checks `revoked_at IS NULL` for the waiter, so exactly one
    // request can win the rotation. No SELECT-then-UPDATE race.
    async rotateRefreshToken(a: { jti: string; userId: string; newJti: string; expiresAt: number }) {
      const rows = await db.$queryRaw<RotateResultRow[]>`
        WITH cur AS (
          UPDATE refresh_tokens SET revoked_at = now()
          WHERE jti = ${a.jti}::uuid AND user_id = ${a.userId}::uuid
            AND revoked_at IS NULL AND expires_at > now()
          RETURNING family_id
        ),
        usr AS (
          SELECT id, role, school_id, is_active FROM users WHERE id = ${a.userId}::uuid
        ),
        ins AS (
          INSERT INTO refresh_tokens (jti, user_id, family_id, expires_at)
          SELECT ${a.newJti}::uuid, ${a.userId}::uuid, cur.family_id,
                 to_timestamp(${a.expiresAt}::double precision)
          FROM cur, usr
          WHERE usr.is_active
          RETURNING jti
        )
        SELECT EXISTS (SELECT 1 FROM cur) AS was_token_live,
               EXISTS (SELECT 1 FROM ins) AS is_rotated,
               usr.id, usr.role, usr.school_id, usr.is_active
        FROM (SELECT 1) AS one LEFT JOIN usr ON true`;
      const row = rows[0];
      if (!row) throw new Error('rotateRefreshToken returned no row');
      return row;
    },

    // Rejected-token path only. If the presented token exists but was already revoked
    // (rotated or explicitly revoked), someone is replaying it: revoke every live token
    // in its family, which also logs out whoever received the successor token.
    // Unknown or merely expired tokens match nothing and change nothing.
    async revokeFamilyOfRevokedToken(a: { jti: string; userId: string }): Promise<void> {
      await db.$executeRaw`
        UPDATE refresh_tokens SET revoked_at = now()
        WHERE revoked_at IS NULL
          AND family_id = (SELECT family_id FROM refresh_tokens
                           WHERE jti = ${a.jti}::uuid AND user_id = ${a.userId}::uuid
                             AND revoked_at IS NOT NULL)`;
    },
  };
}

export type RefreshTokenRepository = ReturnType<typeof createRefreshTokenRepository>;
