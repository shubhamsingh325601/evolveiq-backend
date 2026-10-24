-- EvolvIQ — family consent, wellbeing check-ins, school support plans and the notification marker.
--
--   consents            a parent's yes / no per purpose. No row means "not decided", which is "no".
--   wellness_checkins   one self-reported day per student (mood, energy, optional sleep / activity).
--   support_plans       staff-only adjustments for a student (special-needs workflow).
--   notification_states when a user last opened their notifications; the feed is derived.

BEGIN;

CREATE TYPE consent_purpose AS ENUM ('wellness_tracking', 'wellness_sharing');

CREATE TABLE consents (
  student_id    uuid            NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  purpose       consent_purpose NOT NULL,
  granted       boolean         NOT NULL,
  decided_by_id uuid            NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decided_at    timestamptz(6)  NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, purpose)
);

CREATE TABLE wellness_checkins (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  recorded_by_id uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  day            date           NOT NULL,
  mood           smallint       NOT NULL,
  energy         smallint       NOT NULL,
  sleep_minutes  smallint,
  active_minutes smallint,
  created_at     timestamptz(6) NOT NULL DEFAULT now(),
  updated_at     timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT wellness_checkins_mood_range CHECK (mood BETWEEN 1 AND 5),
  CONSTRAINT wellness_checkins_energy_range CHECK (energy BETWEEN 1 AND 5),
  CONSTRAINT wellness_checkins_sleep_range CHECK (sleep_minutes IS NULL OR sleep_minutes BETWEEN 0 AND 1080),
  CONSTRAINT wellness_checkins_active_range CHECK (active_minutes IS NULL OR active_minutes BETWEEN 0 AND 720)
);
CREATE UNIQUE INDEX wellness_checkins_student_id_day_key ON wellness_checkins (student_id, day);

CREATE TYPE support_category AS ENUM (
  'learning', 'attention', 'speech_language', 'sensory', 'physical_access', 'emotional', 'gifted', 'other'
);
CREATE TYPE support_status AS ENUM ('active', 'in_review', 'closed');

CREATE TABLE support_plans (
  id            uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_by_id uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  category      support_category NOT NULL,
  summary       text             NOT NULL,
  strategies    text,
  status        support_status   NOT NULL DEFAULT 'active',
  review_on     date,
  closed_at     timestamptz(6),
  created_at    timestamptz(6)   NOT NULL DEFAULT now(),
  updated_at    timestamptz(6)   NOT NULL DEFAULT now(),
  CONSTRAINT support_plans_summary_length CHECK (char_length(summary) BETWEEN 1 AND 1000),
  CONSTRAINT support_plans_strategies_length CHECK (strategies IS NULL OR char_length(strategies) BETWEEN 1 AND 2000),
  CONSTRAINT support_plans_closed_state CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX support_plans_student_id_created_at_idx ON support_plans (student_id, created_at);

CREATE TABLE notification_states (
  user_id uuid           PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  seen_at timestamptz(6) NOT NULL DEFAULT now()
);

COMMIT;
