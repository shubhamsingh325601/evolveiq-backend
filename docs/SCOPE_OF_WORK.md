# EvolvIQ Backend — Scope of Work

Source of truth: `EvolvIQ_MVP_Scope_Confirmation.pdf` (Sept 2026). This file
translates that PRD into backend-specific deliverables.

**Change, 21 Oct 2026 (client feedback):** observations "shouldn't be only
negative or psychological — they can be good and cheering too", and good
reviews from teachers should become rewards. Every observation now has a tone:
a concern follows the workflow below, unchanged; a positive one is a **star**
on the student's profile at once, never reviewed, never Significant and never a
growth area. Parents can record positive observations too. The frontend calls
the psychologist the school **Counsellor**.

**Change, 29 Oct 2026 (client feedback):** the school side grows beyond the
observation workflow. Each student has **health and care needs** (conditions
such as diabetes, asthma, ADHD or dyslexia, allergies, medication, care notes,
an emergency contact) written by the family or the School Admin and read by the
staff who teach them — the family's word, not a clinical record. Teachers take
**attendance** per class and day. Admins post to a **notice board** (events,
activities, trainings, policies and updates, emergency contacts). The School
Admin **rates teachers** monthly and names a **Staff of the Month** and
**Students of the Month** on a celebration wall; a family sees the Staff of the
Month and only their own child's honours. School and Platform Admins
**import** students, teachers and parents from a spreadsheet, and can
**remove** what has no records: an unused account, a class, an empty school.

## Core workflow to support end-to-end
Observe → Review → Assign → Do → See (concerns); Observe → Celebrate (positive
observations: a star)

## In scope by domain

### Auth & users
- Login/session (JWT access + refresh)
- Roles: Student, Parent, Teacher, Psychologist, School Admin, Platform Admin
- RBAC middleware enforced at the route layer, not just in service logic

### Observations
- Create observation (Parent variant: tone, area, free text, when, how often;
  Teacher variant: adds Level (concerns only) + Learning-behaviour area)
- Tone: concern (for review) or positive (a star, celebrated at once, never
  reviewed)
- List/filter for Psychologist queue: Pending, Significant, From parents,
  Reviewed, by school, and by tone (the queue asks for concerns)
- Observation detail + related history lookup
- Review action: tag development area, optional teacher-only note,
  "Assign & mark reviewed" or "No action needed"

### Activities
- Activity library CRUD (simple-form authoring only — no builder)
- Activity types: MCQ, text, image pick, 1–5 rating, media + response
- Assignment: direct (Teacher) or recommended (Psychologist)
- Completion submission endpoint, feeds progress/streak calculation

### Progress
- Per-student growth areas (hard cap: 5)
- Monthly summary generation (plain-language, Parent-safe — excludes
  clinical scores/psychologist notes; counts the month's stars)
- Streak calculation from completions
- Per-student stars: one per positive observation, with the giver's words,
  name and role (Parent-safe for every audience)

### School / Platform administration
- School Admin: manage students, teachers, classes, parents (CRUD; removing an
  account only while it has no records, else deactivation)
- Platform Admin: add schools (and remove empty ones), manage users across all roles
- Import students, teachers or parents (up to 500 rows a request), every row
  checked and reported; all or nothing

### School life (client feedback, 29 Oct 2026)
- Health and care needs per student: parents and School Admins write; teachers,
  psychologists and School Admins read; never in the Holistic Index
- Class attendance: present / late / absent per student per Asia/Kolkata day,
  today or up to 30 days back; read over a range for a class
- Notice board: School Admins for their school, Platform Admins for one school
  or every school; read by every role for their audience
- Staff reviews: five 1–5 ratings and a comment per teacher per month; private
  to the School Admin and the teacher
- Honours: Staff of the Month and Student of the Month; families see only the
  Staff of the Month and their own child's
- List endpoints support the RecordsTable pattern (pagination, sort, filter) — no chart/aggregate endpoints needed

## Explicitly out of scope (do not build)
- Any analytics/chart aggregation endpoints
- Permission editor / audit log
- Chat/messaging
- Guardian hierarchies, multi-school student records
- Billing/payments
- A sync with a school's own system or CRM (spreadsheet import is in since
  29 Oct 2026; the frontend shows the sync as coming soon)
- Medical files, report uploads or clinical health data (the care needs above
  are the family's own words)

## Definition of done (per endpoint)
- Zod-validated request/response
- RBAC-enforced (explicit allow-list of roles per route)
- Parent-facing serializers exclude clinical scores/psychologist notes at
  the API layer
- Supertest integration test covering the role-access boundary, not just
  the happy path
