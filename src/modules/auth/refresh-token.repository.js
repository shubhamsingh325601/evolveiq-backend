// SQL for refresh-token storage. Static, parameterised statements only.

// Login: start a new token family (family_id = first token's jti).
export async function insertRefreshToken(db, { jti, userId, familyId, expiresAt }) {
  await db.query(
    `INSERT INTO refresh_tokens (jti, user_id, family_id, expires_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, to_timestamp($4))`,
    [jti, userId, familyId, expiresAt],
  );
}

// Refresh: ONE statement that
//   1. revokes the presented token only if it is live (not revoked, not expired),
//   2. reads the user's CURRENT role / school / active flag,
//   3. inserts the successor token in the same family — only if 1 succeeded and the
//      user is active.
// Step 1 is a conditional UPDATE: under concurrent use of the same token, Postgres
// row-locks it and re-checks `revoked_at IS NULL` for the waiter, so exactly one
// request can win the rotation. No SELECT-then-UPDATE race.
const ROTATE_SQL = `
WITH cur AS (
  UPDATE refresh_tokens SET revoked_at = now()
  WHERE jti = $1::uuid AND user_id = $2::uuid
    AND revoked_at IS NULL AND expires_at > now()
  RETURNING family_id
),
usr AS (
  SELECT id, role, school_id, is_active FROM users WHERE id = $2::uuid
),
ins AS (
  INSERT INTO refresh_tokens (jti, user_id, family_id, expires_at)
  SELECT $3::uuid, $2::uuid, cur.family_id, to_timestamp($4)
  FROM cur, usr
  WHERE usr.is_active
  RETURNING jti
)
SELECT EXISTS (SELECT 1 FROM cur) AS token_ok,
       EXISTS (SELECT 1 FROM ins) AS rotated,
       usr.id, usr.role, usr.school_id, usr.is_active
FROM (SELECT 1) AS one LEFT JOIN usr ON true`;

export async function rotateRefreshToken(db, { jti, userId, newJti, expiresAt }) {
  const { rows } = await db.query(ROTATE_SQL, [jti, userId, newJti, expiresAt]);
  return rows[0];
}

// Rejected-token path only. If the presented token exists but was already revoked
// (rotated or explicitly revoked), someone is replaying it: revoke every live token
// in its family, which also logs out whoever received the successor token.
// Unknown or merely expired tokens match nothing and change nothing.
export async function revokeFamilyOfRevokedToken(db, { jti, userId }) {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE revoked_at IS NULL
       AND family_id = (SELECT family_id FROM refresh_tokens
                        WHERE jti = $1::uuid AND user_id = $2::uuid AND revoked_at IS NOT NULL)`,
    [jti, userId],
  );
}
