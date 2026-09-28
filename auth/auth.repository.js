// All SQL for the auth module. Static, parameterised statements only.

// ---------- Register: ONE round trip ----------
// In a single statement this: (1) re-checks the caller is still an active user with the
// role/school in their token (a deactivated admin's unexpired JWT stops working),
// (2) checks a supplied parent is an active parent in the same school, (3) inserts.
// Duplicates are caught by the unique indexes, never by a SELECT-then-INSERT, so two
// concurrent requests for the same email cannot both succeed.
const INSERT_USER_SQL = `
WITH actor AS (
  SELECT 1 FROM users
  WHERE id = $1::uuid AND role = $2::user_role AND is_active
    AND school_id IS NOT DISTINCT FROM $3::uuid
),
parent AS (
  SELECT 1 FROM users
  WHERE id = $5::uuid AND role = 'parent' AND is_active AND school_id = $4::uuid
),
ins AS (
  INSERT INTO users (role, school_id, parent_id, full_name, email, student_login_id, secret_hash)
  SELECT $6::user_role, $4::uuid, $5::uuid, $7, $8, $9, $10
  WHERE EXISTS (SELECT 1 FROM actor)
    AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM parent))
  RETURNING id, role, school_id, parent_id, full_name, created_at
)
SELECT EXISTS (SELECT 1 FROM actor)                        AS actor_ok,
       ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM parent)) AS parent_ok,
       ins.*
FROM (SELECT 1) AS one LEFT JOIN ins ON true`;

export async function insertUser(db, a) {
  const { rows } = await db.query(INSERT_USER_SQL, [
    a.actorId, a.actorRole, a.actorSchoolId,
    a.schoolId, a.parentId,
    a.role, a.fullName, a.email, a.studentLoginId, a.secretHash,
  ]);
  return rows[0];
}

// ---------- Login: ONE indexed lookup ----------
const LOGIN_COLUMNS = `
  id, role, school_id, full_name, secret_hash, is_active, failed_login_attempts,
  (locked_until IS NOT NULL AND locked_until > now()) AS is_locked,
  (locked_until IS NOT NULL)                          AS has_lock`;

const FIND_BY_EMAIL_SQL = `SELECT ${LOGIN_COLUMNS} FROM users WHERE email = $1`;
const FIND_BY_STUDENT_ID_SQL = `SELECT ${LOGIN_COLUMNS} FROM users WHERE student_login_id = $1`;

export async function findUserByEmail(db, email) {
  const { rows } = await db.query(FIND_BY_EMAIL_SQL, [email]);
  return rows[0] ?? null;
}

export async function findUserByStudentId(db, studentLoginId) {
  const { rows } = await db.query(FIND_BY_STUDENT_ID_SQL, [studentLoginId]);
  return rows[0] ?? null;
}

// Atomic increment (no read-modify-write race). On reaching the limit the account is
// locked and the counter restarts, so the next window gets the same allowance.
const RECORD_FAILURE_SQL = `
UPDATE users SET
  failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $2 THEN 0
                               ELSE failed_login_attempts + 1 END,
  locked_until          = CASE WHEN failed_login_attempts + 1 >= $2
                               THEN now() + make_interval(mins => $3)
                               ELSE locked_until END
WHERE id = $1`;

export async function recordFailedLogin(db, userId, maxAttempts, lockMinutes) {
  await db.query(RECORD_FAILURE_SQL, [userId, maxAttempts, lockMinutes]);
}

// Only called when there is something to reset — a clean login costs zero writes.
export async function resetFailedLogins(db, userId) {
  await db.query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
    [userId],
  );
}
