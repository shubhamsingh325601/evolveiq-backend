-- EvolvIQ — Staff Training & Development Hub: a gap found against the client's prototype, not
-- yet confirmed scope (SCOPE_OF_WORK.md, 16 Nov 2026).
--
--   trainings            a workshop or course a school offers its staff. NULL school_id = every
--                        school (Platform Admin), exactly like the notice board.
--   training_enrolments  one row per staff member enrolled in a training.

BEGIN;

CREATE TYPE training_requirement AS ENUM ('mandatory', 'recommended', 'optional');

CREATE TABLE trainings (
  id            uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: offered by a Platform Admin to every school.
  school_id     uuid                 REFERENCES schools (id) ON DELETE CASCADE,
  title         text                 NOT NULL,
  description   text,
  scheduled_on  date,
  requirement   training_requirement NOT NULL,
  credits       smallint             NOT NULL,
  created_by_id uuid                 NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz(6)       NOT NULL DEFAULT now(),
  updated_at    timestamptz(6)       NOT NULL DEFAULT now(),
  CONSTRAINT trainings_title_length CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT trainings_description_length CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  CONSTRAINT trainings_credits_range CHECK (credits BETWEEN 0 AND 20)
);
CREATE INDEX trainings_school_id_created_at_idx ON trainings (school_id, created_at);

CREATE TABLE training_enrolments (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  training_id  uuid           NOT NULL REFERENCES trainings (id) ON DELETE CASCADE,
  staff_id     uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  is_complete  boolean        NOT NULL DEFAULT false,
  enrolled_at  timestamptz(6) NOT NULL DEFAULT now(),
  completed_at timestamptz(6)
);
CREATE UNIQUE INDEX training_enrolments_training_id_staff_id_key ON training_enrolments (training_id, staff_id);
CREATE INDEX training_enrolments_staff_id_idx ON training_enrolments (staff_id);

COMMIT;
