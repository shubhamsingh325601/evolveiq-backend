# EvolvIQ Backend — Architecture

## Overview
The backend serves all three frontend apps (Family, School, Admin) through
one versioned REST API and owns the core workflow state machine:
**Observe → Review → Assign → Do → See**.

## Stack
- **Language**: TypeScript (strict mode)
- **Runtime/Framework**: Node.js + Fastify
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Auth**: JWT (access + refresh tokens), role-based access control (RBAC)
  middleware — roles: Student, Parent, Teacher, Psychologist, School Admin,
  Platform Admin
- **Validation**: Zod schemas at the route boundary
- **Testing**: Vitest for unit/service tests, Supertest for API integration tests
- **Migrations**: Prisma Migrate

## Layered structure
```
src/
  modules/
    auth/
    users/            # Student, Parent, Teacher, Psychologist accounts
    schools/           # Schools, classes, School Admin / Platform Admin ops
    observations/       # Submit, list, filter, review queue
    activities/         # Activity library, authoring, assignment
    progress/           # Student progress, streaks, growth areas, summaries
    health/             # Health and care needs (client feedback, 29 Oct 2026)
    attendance/         # Class registers
    notices/            # The notice board
    staff/              # Staff reviews
    honours/            # Staff and Students of the Month
    imports/            # Students, teachers and parents from a spreadsheet
  each module/
    *.routes.ts        # HTTP layer — request/response, validation
    *.service.ts        # Business logic, workflow rules
    *.repository.ts      # Prisma queries, isolated from business logic
  shared/
    rbac/              # Role guard middleware, permission checks
    errors/            # Typed error classes -> HTTP status mapping
    db/                # Prisma client singleton
prisma/
  schema.prisma
  migrations/
.claude/
docs/ (this file, SCOPE_OF_WORK.md, etc.)
```

Routes stay thin; business rules (e.g. "a Psychologist can only mark
Significant-level observations reviewed with a tagged development area")
live in services, not routes or controllers-as-routes. Classes live in the
`schools` module; parent↔student links and the shared student scope in
`users`.

## Core domain model (high level)
- `School` → has many `Class`, `User`. A user belongs to at most one school
  through `users.school_id` (no SchoolMembership table: there are no
  multi-school users). Psychologist and Platform Admin have no school. A
  user's role and school never change after creation.
- `User` → has a `role`. Relationships are explicit join tables, not inferred:
  - Parent↔Student: `parent_students` — a parent has many children, a student
    at most one parent (primary key `student_id`); both in the same school.
  - Teacher↔Class: `class_teachers` — many-to-many.
  - Student↔Class: `class_students` — a student is in one class (primary key
    `student_id`).
- `Class` → belongs to one school; `name` only, unique within the school
  ignoring case (citext).
- `Observation` → author (Parent or Teacher), subject (Student), tone
  (concern / positive), area, free text, when/how-often, optional Level +
  Learning-behaviour area (Teacher only), status, review outcome
  ("Assign & mark reviewed" / "No action needed"), reviewedBy, tagged
  development area, optional teacher-only note. A concern goes Pending →
  Reviewed. A positive observation (client feedback, 21 Oct 2026) is a star
  for the student: Celebrated from the start, never reviewed, never given a
  Level — so never Significant and never a growth area. The value lists are
  the lead-confirmed Postgres enums; their labels live in
  `src/modules/observations/observation-options.ts`.
- `Activity` → one global library; type (MCQ/text/image-pick/rating/
  media+response) + content (one Zod discriminated union), authored via a
  simple form (no builder UI). Archived, never deleted. Type and options are
  frozen once assigned.
- `Assignment` → links Activity to Student, assignedBy (Psychologist or
  Teacher), source (recommended via an observation review / direct from a
  Teacher). No due dates, reattempts or cancellation.
- `ActivityCompletion` → Student's submitted answer, one per assignment;
  contributes to progress/streak
- Progress → derived on read: growth areas (the 5 most recent development
  areas of the student's "Assign & mark reviewed" reviews), streak, stars
  (the student's positive observations, newest first). Monthly summary text —
  activities, streak, the month's stars, growth areas — is built live for the
  current month and stored once per finished month in `monthly_summaries`
  (immutable).

- Since the client's feedback of 29 Oct 2026:
  - `HealthProfile` → one per student (primary key `student_id`): conditions (a
    Postgres enum array), blood group, allergies, medication, care notes, an
    emergency contact (name and phone together, or neither). Written by the
    parent or the School Admin; removed with the student's account.
  - `AttendanceRecord` → one per student per Asia/Kolkata day (`present`,
    `late`, `absent`), with who marked it. The register of a class is its
    current students' records; a class has no attendance of its own, so
    deleting a class touches none.
  - `Notice` → category, title, body, date, place, phone, audience, pinned;
    `school_id` NULL for a Platform Admin's notice for every school.
  - `StaffReview` → five 1–5 ratings and a comment, one per teacher per month.
  - `Honour` → Staff of the Month (a teacher) or Student of the Month (a
    student), with a citation; once per person per kind per month.
  - Removal: everything that records what happened points at a user with ON
    DELETE RESTRICT, so `DELETE /users/:id` removes only an account nobody's
    records point at (with its class place, parent link, health profile and
    sessions), else 409 `HAS_RECORDS`.

## Access rules worth encoding explicitly
- Parents never see clinical scores or psychologist notes.
- Psychologist notes marked "teacher-only" are excluded from Parent-facing
  serializers at the API layer, not just hidden in the UI.
- Student API access is scoped to the student's own records only.
- Which students a caller reaches is decided in one place
  (`src/modules/users/student-scope.ts`): students themselves, parents their
  linked children, teachers the students of their assigned classes, School
  Admins their school, Psychologists every school. Outside it → same answer as
  "not found".
- Parent-facing responses are explicit allow-list DTOs (one response schema
  per audience): their own observations with status; their child's activities
  as done / not done, with when they were set and finished; streak;
  growth-area names; stars; monthly summary. Parent-only endpoints live under
  `/api/v1/family/`.
- A star is the same parent-safe shape for every audience (student, parent,
  teacher, psychologist): the giver's words, the area, the giver's name and
  role, the date. A positive observation has no Level or review, and its
  learning-behaviour area is never part of a star.
- Schools: Platform Admins and Psychologists read every school (the review
  queue filters by school); everyone else reads only their own.
- Teachers and parents see only the observations they wrote. Something good
  anyone wrote reaches the student's circle as a star, never as an
  observation.
- Classes are reached through one rule too (`src/modules/schools/class-scope.ts`):
  School Admins every class of their school, Teachers the classes they teach;
  outside it → "not found". Attendance and a class's health profiles use it.
- Health and care needs: parents (their children) and School Admins (their
  school) write; Teachers, Psychologists and School Admins read, through the
  student scope. Students do not reach them.
- The notice board answers each role for its audience; a School Admin manages
  only their own school's notices, a Platform Admin any.
- Staff reviews: the School Admin of the school, and the teacher reviewed —
  nobody else. Honours: staff see their school's wall; a parent sees the Staff
  of the Month and their own children's honours; a student the Staff of the
  Month and their own. Another family's child never reaches a family.
- The frontend calls the `psychologist` role the school **Counsellor** (client
  feedback, 21 Oct 2026). The role's value, routes and permissions are
  unchanged.

## Time
Timestamps are stored in UTC (`timestamptz`; every database session is pinned
to UTC). Business days and months — streaks, monthly summaries — are
Asia/Kolkata calendar days, defined once in
`src/modules/progress/business-time.ts`. UTC midnight is never a business
boundary.

## What's deliberately out of scope for MVP
No permission editor/audit log, no chat, no guardian hierarchies /
multi-school students, no billing, no native mobile. CSV import is V1, not
MVP for the PRD, but the client asked for it on 29 Oct 2026: spreadsheet import
is built (`/imports/people`); a live sync with a school's own system is not.

## Environments
- `local` — Postgres via Docker Compose, Prisma migrate dev
- `staging` — deployed on merge to `main`
- `production` — deployed on tag/release (see BRANCHING_STRATEGY.md)
