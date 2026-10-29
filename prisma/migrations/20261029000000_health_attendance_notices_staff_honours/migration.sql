-- EvolvIQ — client feedback of 29 Oct 2026: health and care needs, attendance, the notice
-- board, staff reviews and the celebration wall.
--
--   health_profiles     one per student: conditions the school should know about (diabetes,
--                       asthma, ADHD, dyslexia…), allergies, medication, care notes and an
--                       emergency contact. Written by the parent or the School Admin; read by
--                       the student's teachers, the counsellor and the School Admin.
--   attendance_records  one per student per Asia/Kolkata day: present, late or absent.
--   notices             the notice board: events, activities, trainings, policy updates,
--                       emergency contacts. NULL school_id = every school (Platform Admin).
--   staff_reviews       a School Admin's monthly 1–5 ratings of a teacher, with a comment.
--   honours             the celebration wall: Staff of the Month and Student of the Month.

BEGIN;

CREATE TYPE health_condition AS ENUM (
  'diabetes', 'asthma', 'epilepsy', 'severe_allergy', 'on_medication', 'specially_abled',
  'visual_impairment', 'hearing_impairment', 'dyslexia', 'adhd', 'autism', 'speech_language', 'other'
);

CREATE TABLE health_profiles (
  -- A student's own record: it goes when the student's account is removed.
  student_id         uuid               PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  conditions         health_condition[] NOT NULL DEFAULT '{}',
  blood_group        text,
  allergies          text,
  medications        text,
  care_notes         text,
  emergency_name     text,
  emergency_relation text,
  emergency_phone    text,
  updated_by_id      uuid               REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz(6)     NOT NULL DEFAULT now(),
  updated_at         timestamptz(6)     NOT NULL DEFAULT now(),
  CONSTRAINT health_profiles_blood_group CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  CONSTRAINT health_profiles_allergies_length CHECK (allergies IS NULL OR char_length(allergies) BETWEEN 1 AND 500),
  CONSTRAINT health_profiles_medications_length CHECK (medications IS NULL OR char_length(medications) BETWEEN 1 AND 500),
  CONSTRAINT health_profiles_care_notes_length CHECK (care_notes IS NULL OR char_length(care_notes) BETWEEN 1 AND 1000),
  -- An emergency contact is a name and a phone number together, or nothing.
  CONSTRAINT health_profiles_emergency_contact CHECK ((emergency_name IS NULL) = (emergency_phone IS NULL)),
  CONSTRAINT health_profiles_emergency_relation CHECK (emergency_relation IS NULL OR emergency_name IS NOT NULL),
  CONSTRAINT health_profiles_emergency_lengths CHECK (
    (emergency_name IS NULL OR char_length(emergency_name) BETWEEN 1 AND 100)
    AND (emergency_relation IS NULL OR char_length(emergency_relation) BETWEEN 1 AND 50)
    AND (emergency_phone IS NULL OR char_length(emergency_phone) BETWEEN 3 AND 20)
  )
);

CREATE TYPE attendance_status AS ENUM ('present', 'late', 'absent');

CREATE TABLE attendance_records (
  student_id   uuid              NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- The Asia/Kolkata calendar day.
  day          date              NOT NULL,
  status       attendance_status NOT NULL,
  marked_by_id uuid              NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at   timestamptz(6)    NOT NULL DEFAULT now(),
  updated_at   timestamptz(6)    NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, day)
);
CREATE INDEX attendance_records_day_idx ON attendance_records (day);

CREATE TYPE notice_category AS ENUM ('event', 'activity', 'training', 'policy', 'emergency_contact', 'general');
CREATE TYPE notice_audience AS ENUM ('everyone', 'staff', 'families');

CREATE TABLE notices (
  id            uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL: posted by a Platform Admin for every school.
  school_id     uuid            REFERENCES schools (id) ON DELETE CASCADE,
  category      notice_category NOT NULL,
  title         text            NOT NULL,
  body          text,
  starts_on     date,
  location      text,
  phone         text,
  audience      notice_audience NOT NULL DEFAULT 'everyone',
  is_pinned     boolean         NOT NULL DEFAULT false,
  created_by_id uuid            NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz(6)  NOT NULL DEFAULT now(),
  updated_at    timestamptz(6)  NOT NULL DEFAULT now(),
  CONSTRAINT notices_title_length CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT notices_body_length CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT notices_location_length CHECK (location IS NULL OR char_length(location) BETWEEN 1 AND 120),
  CONSTRAINT notices_phone_length CHECK (phone IS NULL OR char_length(phone) BETWEEN 3 AND 20),
  -- An emergency contact is a number to call.
  CONSTRAINT notices_emergency_contact_phone CHECK (category <> 'emergency_contact' OR phone IS NOT NULL)
);
CREATE INDEX notices_school_id_created_at_idx ON notices (school_id, created_at);

CREATE TABLE staff_reviews (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid           NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  staff_id      uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reviewer_id   uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- The first day of the month reviewed.
  month         date           NOT NULL,
  teaching      smallint       NOT NULL,
  engagement    smallint       NOT NULL,
  punctuality   smallint       NOT NULL,
  teamwork      smallint       NOT NULL,
  communication smallint       NOT NULL,
  comment       text,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT staff_reviews_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT staff_reviews_ratings_range CHECK (
    teaching BETWEEN 1 AND 5 AND engagement BETWEEN 1 AND 5 AND punctuality BETWEEN 1 AND 5
    AND teamwork BETWEEN 1 AND 5 AND communication BETWEEN 1 AND 5
  ),
  CONSTRAINT staff_reviews_comment_length CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 1000)
);
CREATE UNIQUE INDEX staff_reviews_staff_id_month_key ON staff_reviews (staff_id, month);
CREATE INDEX staff_reviews_school_id_month_idx ON staff_reviews (school_id, month);

CREATE TYPE honour_kind AS ENUM ('staff_of_month', 'student_of_month');

CREATE TABLE honours (
  id            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     uuid           NOT NULL REFERENCES schools (id) ON DELETE RESTRICT,
  kind          honour_kind    NOT NULL,
  -- The first day of the month the honour is for.
  month         date           NOT NULL,
  honoree_id    uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  citation      text           NOT NULL,
  awarded_by_id uuid           NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT honours_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT honours_citation_length CHECK (char_length(citation) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX honours_kind_month_honoree_id_key ON honours (kind, month, honoree_id);
CREATE INDEX honours_school_id_month_idx ON honours (school_id, month);

COMMIT;
