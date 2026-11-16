-- EvolvIQ — IT Help Desk tickets: a gap found against the client's UI prototype (16 Nov 2026),
-- not yet a confirmed client request; the project owner asked to build it so it's ready to demo
-- (see docs/SCOPE_OF_WORK.md).
--
--   support_tickets   one ticket per row, always scoped to the school it was raised in. Teachers,
--                     Psychologists and School Admins raise them; a School Admin (their own
--                     school) or a Platform Admin changes status.

BEGIN;

CREATE TYPE support_ticket_status AS ENUM ('open', 'in_progress', 'resolved');

CREATE TABLE support_tickets (
  id           uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid                  NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  raised_by_id uuid                  NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  subject      text                  NOT NULL,
  body         text,
  status       support_ticket_status NOT NULL DEFAULT 'open',
  created_at   timestamptz(6)        NOT NULL DEFAULT now(),
  updated_at   timestamptz(6)        NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_subject_length CHECK (char_length(subject) BETWEEN 1 AND 120),
  CONSTRAINT support_tickets_body_length CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 2000)
);
CREATE INDEX support_tickets_school_id_created_at_idx ON support_tickets (school_id, created_at);

COMMIT;
