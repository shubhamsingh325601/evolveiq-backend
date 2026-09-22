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
live in services, not routes or controllers-as-routes.

## Core domain model (high level)
- `School` → has many `Class`, `User` (via SchoolMembership)
- `User` → has a `role`; Parent↔Student and Teacher↔Class relationships are
  explicit join tables, not inferred
- `Observation` → author (Parent or Teacher), subject (Student), area,
  free text, when/how-often, optional Level + Learning-behaviour area
  (Teacher only), status (Pending/Reviewed), reviewedBy, tagged development area
- `Activity` → type (MCQ/text/image-pick/rating/media+response), payload,
  authored via a simple form (no builder UI)
- `Assignment` → links Activity to Student, assignedBy (Psychologist or
  Teacher), source (recommended/direct)
- `ActivityCompletion` → Student's submitted response, contributes to
  progress/streak
- `ProgressSummary` → derived, up to 5 growth areas per student (hard cap
  per PRD), monthly summary text

## Access rules worth encoding explicitly
- Parents never see clinical scores or psychologist notes.
- Psychologist notes marked "teacher-only" are excluded from Parent-facing
  serializers at the API layer, not just hidden in the UI.
- Student API access is scoped to the student's own records only.

## What's deliberately out of scope for MVP
No permission editor/audit log, no chat, no guardian hierarchies /
multi-school students, no billing, no native mobile. CSV import is V1, not
MVP — don't build the import pipeline yet.

## Environments
- `local` — Postgres via Docker Compose, Prisma migrate dev
- `staging` — deployed on merge to `main`
- `production` — deployed on tag/release (see BRANCHING_STRATEGY.md)
