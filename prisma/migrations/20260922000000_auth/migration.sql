-- EvolvIQ — authentication schema (Login + Register only)
-- Requires PostgreSQL 13+ (gen_random_uuid() is built in).

BEGIN;

-- The six roles defined in PRD §3. Stored as an enum: 4 bytes, validated by the DB.
CREATE TYPE user_role AS ENUM (
  'student', 'parent', 'teacher', 'school_admin', 'psychologist', 'platform_admin'
);

-- Minimal schools table so school-scoped users have a real foreign key.
-- "Add schools" (Platform Admin, PRD §3) is a separate API and is NOT built here.
CREATE TABLE schools (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role                  user_role   NOT NULL,
  school_id             uuid        REFERENCES schools(id) ON DELETE RESTRICT,
  -- PRD §6: "one parent, many children is the only relationship".
  parent_id             uuid        REFERENCES users(id) ON DELETE RESTRICT,
  full_name             text        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 100),
  -- Adults sign in with email + password; students with student ID + PIN (PRD §3, A1).
  email                 text,
  student_login_id      text,
  -- argon2id hash of the password (adults) or PIN (students). Never plain text.
  secret_hash           text        NOT NULL,
  -- PRD §3: Platform Admin can deactivate every user type.
  is_active             boolean     NOT NULL DEFAULT true,
  -- Brute-force protection (assumption — see README).
  failed_login_attempts smallint    NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_normalized       CHECK (email = lower(email)),
  CONSTRAINT users_student_id_normalized  CHECK (student_login_id = upper(student_login_id)),
  -- Exactly one credential identifier, chosen by role.
  CONSTRAINT users_credential_by_role CHECK (
       (role =  'student' AND student_login_id IS NOT NULL AND email IS NULL)
    OR (role <> 'student' AND email IS NOT NULL AND student_login_id IS NULL)
  ),
  -- Psychologist and Platform Admin are platform-level; everyone else belongs to a school.
  CONSTRAINT users_school_scope_by_role CHECK (
    (role IN ('psychologist', 'platform_admin')) = (school_id IS NULL)
  ),
  CONSTRAINT users_parent_only_on_students CHECK (parent_id IS NULL OR role = 'student')
);

-- Login lookups. Partial unique indexes: they enforce uniqueness (race-safe duplicate
-- prevention) AND serve the login query, and skip rows where the column is NULL.
CREATE UNIQUE INDEX users_email_key            ON users (email)            WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_student_login_id_key ON users (student_login_id) WHERE student_login_id IS NOT NULL;

COMMIT;
