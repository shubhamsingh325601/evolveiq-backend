-- EvolvIQ — Forgot password (asked for on 21 Nov 2026).
--
--   password_reset_codes  a 6-digit code emailed to an adult who forgot their password. Only the
--                         newest code of an account works, for 15 minutes, 5 tries, once. The code
--                         itself is never stored: only its argon2id hash, like a password.
--
-- Students have no email; their parent or School Admin sets a new PIN instead (no table needed).

BEGIN;

CREATE TABLE password_reset_codes (
  id         uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text           NOT NULL,
  -- Tries so far, wrong or right. Taken before each check, so parallel guesses can't exceed the limit.
  attempts   smallint       NOT NULL DEFAULT 0,
  expires_at timestamptz(6) NOT NULL,
  used_at    timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_codes_attempts_not_negative CHECK (attempts >= 0)
);
-- The newest code of an account, and the per-account throttle (codes in the last minute / hour).
CREATE INDEX password_reset_codes_user_id_created_at_idx ON password_reset_codes (user_id, created_at DESC);

COMMIT;
