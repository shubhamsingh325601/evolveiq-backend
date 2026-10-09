-- EvolvIQ — the core workflow: Observe → Review → Assign → Do.
-- Observations (parent / teacher), the psychologist's review, the global activity library,
-- assignments and completions.
--
-- Enum values are the lead-confirmed lists (Oct 2026); their UI labels live in
-- src/modules/observations/observation-options.ts and src/modules/activities/activity.schemas.ts.

BEGIN;

-- ---------- Observation value lists ----------
CREATE TYPE observation_area AS ENUM (
  'emotions', 'behaviour', 'social', 'learning', 'communication', 'physical', 'routines', 'other'
);
CREATE TYPE observation_when AS ENUM ('today', 'this_week', 'this_month', 'over_a_month');
CREATE TYPE observation_frequency AS ENUM ('once', 'sometimes', 'often', 'daily');
-- Teachers only:
CREATE TYPE observation_level AS ENUM ('minor', 'moderate', 'significant');
CREATE TYPE learning_behaviour_area AS ENUM (
  'attention', 'participation', 'following_instructions', 'task_completion', 'organisation',
  'working_with_others', 'self_control', 'other'
);
-- Psychologist (there is deliberately no 'other'):
CREATE TYPE development_area AS ENUM (
  'managing_feelings', 'social_skills', 'communication', 'focus_attention', 'self_control',
  'confidence', 'resilience', 'independence', 'learning_skills', 'motor_skills'
);
CREATE TYPE observation_status AS ENUM ('pending', 'reviewed');
-- "Assign & mark reviewed" / "No action needed".
CREATE TYPE review_outcome AS ENUM ('assigned', 'no_action');

-- ---------- Observations ----------
CREATE TABLE observations (
  id                      uuid                    PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The student's school (fixed at creation; users.school_id never changes). Serves the
  -- psychologist's "by school" filter without a join.
  school_id               uuid                    NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id              uuid                    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_id               uuid                    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role             user_role               NOT NULL,
  area                    observation_area        NOT NULL,
  description             text                    NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  observed_when           observation_when        NOT NULL,
  frequency               observation_frequency   NOT NULL,
  level                   observation_level,
  learning_behaviour_area learning_behaviour_area,
  status                  observation_status      NOT NULL DEFAULT 'pending',
  review_outcome          review_outcome,
  development_area        development_area,
  -- Visible to the author (a teacher) and psychologists; never to parents.
  teacher_only_note       text                    CHECK (char_length(teacher_only_note) BETWEEN 1 AND 2000),
  reviewed_by_id          uuid                    REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at             timestamptz(6),
  created_at              timestamptz(6)          NOT NULL DEFAULT now(),
  updated_at              timestamptz(6)          NOT NULL DEFAULT now(),

  CONSTRAINT observations_author_role CHECK (author_role IN ('parent', 'teacher')),
  -- Level and learning-behaviour area are teacher-only fields.
  CONSTRAINT observations_teacher_only_fields CHECK (
    author_role = 'teacher' OR (level IS NULL AND learning_behaviour_area IS NULL)
  ),
  -- A pending observation carries no review data; a reviewed one carries who / when / outcome.
  CONSTRAINT observations_review_state CHECK (
       (status = 'pending' AND review_outcome IS NULL AND development_area IS NULL
          AND teacher_only_note IS NULL AND reviewed_by_id IS NULL AND reviewed_at IS NULL)
    OR (status = 'reviewed' AND review_outcome IS NOT NULL AND reviewed_by_id IS NOT NULL
          AND reviewed_at IS NOT NULL)
  ),
  -- A Significant observation can only be reviewed with a development area.
  CONSTRAINT observations_significant_needs_area CHECK (
    NOT (status = 'reviewed' AND level = 'significant' AND development_area IS NULL)
  )
);
CREATE INDEX observations_status_created_at_idx ON observations (status, created_at);
CREATE INDEX observations_school_id_created_at_idx ON observations (school_id, created_at);
CREATE INDEX observations_student_id_created_at_idx ON observations (student_id, created_at);
CREATE INDEX observations_author_id_created_at_idx ON observations (author_id, created_at);
-- Growth areas: the student's most recent "assigned" reviews with a development area.
CREATE INDEX observations_student_id_reviewed_at_idx ON observations (student_id, reviewed_at)
  WHERE review_outcome = 'assigned' AND development_area IS NOT NULL;

-- ---------- Activity library (one, global) ----------
CREATE TYPE activity_type AS ENUM ('mcq', 'text', 'image_pick', 'rating', 'media_response');

CREATE TABLE activities (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text           NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  type          activity_type  NOT NULL,
  -- prompt / options / mediaUrl for the type; the shape is validated by the API (one Zod
  -- discriminated union on the type).
  content       jsonb          NOT NULL,
  created_by_id uuid           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Activities are archived, never deleted.
  archived_at   timestamptz(6),
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX activities_title_idx ON activities (title);
CREATE INDEX activities_created_at_idx ON activities (created_at);

-- ---------- Assignments ----------
CREATE TYPE assignment_source AS ENUM ('direct', 'recommended');

CREATE TABLE assignments (
  id             uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id    uuid              NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
  student_id     uuid              NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by_id uuid              NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- direct = a teacher assigned it; recommended = a psychologist, through an observation review.
  source         assignment_source NOT NULL,
  observation_id uuid              REFERENCES observations(id) ON DELETE RESTRICT,
  created_at     timestamptz(6)    NOT NULL DEFAULT now(),

  CONSTRAINT assignments_source_observation CHECK ((source = 'recommended') = (observation_id IS NOT NULL))
);
CREATE INDEX assignments_student_id_created_at_idx ON assignments (student_id, created_at);
CREATE INDEX assignments_activity_id_idx ON assignments (activity_id);
-- One review never assigns the same activity twice.
CREATE UNIQUE INDEX assignments_observation_id_activity_id_key ON assignments (observation_id, activity_id);

-- ---------- Completions ----------
CREATE TABLE activity_completions (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid           NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  -- The student's answer for the activity's type (validated by the API).
  response      jsonb          NOT NULL,
  -- Stored in UTC; business days are Asia/Kolkata days (streaks, monthly summaries).
  completed_at  timestamptz(6) NOT NULL DEFAULT now()
);
-- One completion per assignment (no reattempts).
CREATE UNIQUE INDEX activity_completions_assignment_id_key ON activity_completions (assignment_id);
CREATE INDEX activity_completions_completed_at_idx ON activity_completions (completed_at);

COMMIT;
