-- EvolvIQ — Events & Competitions: a gap found against the client's prototype, not yet
-- confirmed scope (docs/SCOPE_OF_WORK.md, 16 Nov 2026).
--
--   competitions              a National / State / Inter-School / Intra-School competition the
--                             school has entered. Unlike notices, school_id is required: a
--                             competition always belongs to exactly one school.
--   competition_nominations   a teacher's nomination of one student for one competition; a
--                             student can be nominated for a competition at most once.

BEGIN;

CREATE TYPE competition_level AS ENUM ('national', 'state', 'inter_school', 'intra_school');
CREATE TYPE competition_status AS ENUM ('planning', 'registration_open', 'shortlisting', 'confirmed', 'finalized');

CREATE TABLE competitions (
  id            uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid                NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  title         text                NOT NULL,
  level         competition_level   NOT NULL,
  status        competition_status  NOT NULL DEFAULT 'planning',
  scheduled_on  date,
  created_by_id uuid                NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz(6)      NOT NULL DEFAULT now(),
  updated_at    timestamptz(6)      NOT NULL DEFAULT now(),
  CONSTRAINT competitions_title_length CHECK (char_length(title) BETWEEN 1 AND 120)
);
CREATE INDEX competitions_school_id_created_at_idx ON competitions (school_id, created_at);

CREATE TABLE competition_nominations (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id  uuid           NOT NULL REFERENCES competitions (id) ON DELETE CASCADE,
  student_id      uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  nominated_by_id uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX competition_nominations_competition_id_student_id_key ON competition_nominations (competition_id, student_id);
CREATE INDEX competition_nominations_student_id_idx ON competition_nominations (student_id);

COMMIT;
