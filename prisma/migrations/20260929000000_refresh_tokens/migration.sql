-- EvolvIQ — refresh-token storage, rotation and revocation.
-- The raw refresh token is NEVER stored: only its JTI (a random UUID that is useless
-- without the signing secret) plus the metadata needed to expire and revoke it.

BEGIN;

CREATE TABLE refresh_tokens (
  jti        uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- All tokens descended from one login share a family. Re-use of a rotated token
  -- revokes the whole family (theft detection).
  family_id  uuid        NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lookup by JTI uses the primary key. This partial index serves family-wide revocation
-- and only covers live tokens, so it stays small.
CREATE INDEX refresh_tokens_family_active_idx
  ON refresh_tokens (family_id) WHERE revoked_at IS NULL;

COMMIT;
