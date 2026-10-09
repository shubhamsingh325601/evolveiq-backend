-- EvolvIQ — people: user edits, parent ↔ student links, classes and class membership.
--
-- Same-school rules (a parent and their child, a class and its teachers / students, all in
-- one school) are checked by the services in the same statement that writes the link;
-- users.school_id and users.role cannot change after creation, so a link that was valid
-- when written stays valid.

BEGIN;

-- ---------- Users: record the last edit (Prisma's @updatedAt keeps it current) ----------
ALTER TABLE users ADD COLUMN updated_at timestamptz(6) NOT NULL DEFAULT now();

-- ---------- Parent ↔ student ----------
-- "One parent, many children" (PRD §6). The primary key on student_id is the "a student
-- has at most one parent" rule.
CREATE TABLE parent_students (
  student_id uuid           PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  parent_id  uuid           NOT NULL    REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT parent_students_not_self CHECK (parent_id <> student_id)
);
CREATE INDEX parent_students_parent_id_idx ON parent_students (parent_id);

-- Move existing links out of users.parent_id, then drop the column.
INSERT INTO parent_students (student_id, parent_id)
SELECT id, parent_id FROM users WHERE parent_id IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT users_parent_only_on_students;
ALTER TABLE users DROP COLUMN parent_id;

-- ---------- Classes ----------
-- citext: class names are unique within a school ignoring case ("Class A" = "class a").
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE classes (
  id         uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid           NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name       citext         NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX classes_school_id_name_key ON classes (school_id, name);

-- A class has many teachers; a teacher teaches many classes.
CREATE TABLE class_teachers (
  class_id   uuid           NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  teacher_id uuid           NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, teacher_id)
);
CREATE INDEX class_teachers_teacher_id_idx ON class_teachers (teacher_id);

-- A student belongs to exactly one class: the primary key is student_id.
CREATE TABLE class_students (
  student_id uuid           PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  class_id   uuid           NOT NULL    REFERENCES classes(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX class_students_class_id_idx ON class_students (class_id);

COMMIT;
