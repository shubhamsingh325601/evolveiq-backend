-- EvolvIQ — progress: monthly summaries.
--
-- The current month's summary is built live and never stored. Once a month is over (in
-- Asia/Kolkata time) its summary is stored the first time it is requested — one row per
-- student per month — and from then on never changes. Growth areas and streaks are derived
-- on read from observations and activity_completions; they have no tables.

BEGIN;

CREATE TABLE monthly_summaries (
  student_id uuid           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- The first day of the month (Asia/Kolkata calendar).
  month      date           NOT NULL CHECK (extract(day FROM month) = 1),
  summary    text           NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, month)
);

-- Historical summaries are immutable: refuse UPDATE and DELETE outright.
CREATE FUNCTION monthly_summaries_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'monthly_summaries rows are immutable';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER monthly_summaries_immutable
  BEFORE UPDATE OR DELETE ON monthly_summaries
  FOR EACH ROW EXECUTE FUNCTION monthly_summaries_immutable();

COMMIT;
