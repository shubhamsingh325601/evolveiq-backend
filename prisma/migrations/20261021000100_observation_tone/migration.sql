-- EvolvIQ — observations can be positive as well as concerns (client feedback, 21 Oct 2026).
--
--   concern   something to look into: the psychologist's queue, review, growth areas — as before.
--   positive  something good: a star on the student's profile straight away. Never reviewed,
--             never Significant, never a growth area.
--
-- Every existing observation was written as a concern, so the column defaults to 'concern'.

BEGIN;

CREATE TYPE observation_tone AS ENUM ('positive', 'concern');

ALTER TABLE observations ADD COLUMN tone observation_tone NOT NULL DEFAULT 'concern';

-- A celebrated observation carries no review data, the same as a pending one.
ALTER TABLE observations DROP CONSTRAINT observations_review_state;
ALTER TABLE observations ADD CONSTRAINT observations_review_state CHECK (
     (status IN ('pending', 'celebrated') AND review_outcome IS NULL AND development_area IS NULL
        AND teacher_only_note IS NULL AND reviewed_by_id IS NULL AND reviewed_at IS NULL)
  OR (status = 'reviewed' AND review_outcome IS NOT NULL AND reviewed_by_id IS NOT NULL
        AND reviewed_at IS NOT NULL)
);

-- Positive ⇔ celebrated: a star is never queued for review, and a concern is never a star.
ALTER TABLE observations ADD CONSTRAINT observations_positive_is_celebrated CHECK (
  (tone = 'positive') = (status = 'celebrated')
);

-- Level measures how worrying a concern is; a positive observation has none.
ALTER TABLE observations ADD CONSTRAINT observations_positive_has_no_level CHECK (
  tone = 'concern' OR level IS NULL
);

-- A student's stars, newest first.
CREATE INDEX observations_student_id_created_at_positive_idx ON observations (student_id, created_at)
  WHERE tone = 'positive';

COMMIT;
