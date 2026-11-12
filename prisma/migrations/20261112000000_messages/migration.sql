-- EvolvIQ — parent to school messages (the Connect tab).
--
--   messages   one note in a thread. A thread is (student, staff member); the parent is the
--              student's linked parent. Parents start threads; staff only reply.

BEGIN;

CREATE TABLE messages (
  id           uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  staff_id     uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  sender_id    uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body         text           NOT NULL,
  read_at      timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT messages_body_length CHECK (char_length(body) BETWEEN 1 AND 1000)
);
CREATE INDEX messages_thread_idx ON messages (student_id, staff_id, created_at);
CREATE INDEX messages_staff_id_created_at_idx ON messages (staff_id, created_at);

COMMIT;
