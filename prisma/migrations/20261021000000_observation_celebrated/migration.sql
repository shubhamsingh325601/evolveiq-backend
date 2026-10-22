-- EvolvIQ — a third observation status: 'celebrated'.
--
-- A positive observation (something good a parent or teacher noticed) is a star for the
-- student. It is not a concern, so it never waits for a psychologist's review: it is
-- 'celebrated' from the moment it is written.
--
-- On its own, outside a transaction block: PostgreSQL will not use an enum value in the same
-- transaction that adds it, and the next migration's constraints use this one.

ALTER TYPE observation_status ADD VALUE IF NOT EXISTS 'celebrated';
