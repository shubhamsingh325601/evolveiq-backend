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
- Make a pending concern a star, when it was really good news (re-sent client
  feedback, 28 Oct 2026): the teacher who wrote it, or a psychologist

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
- School Admin: manage students, teachers, classes, parents (CRUD)
- Platform Admin: add schools, manage users across all roles
- List endpoints support the RecordsTable pattern (pagination, sort, filter) — no chart/aggregate endpoints needed

## Explicitly out of scope (do not build)
- Any analytics/chart aggregation endpoints
- Permission editor / audit log
- Chat/messaging
- Guardian hierarchies, multi-school student records
- Billing/payments
- CSV import pipeline (PRD marks this V1, not MVP)

## Definition of done (per endpoint)
- Zod-validated request/response
- RBAC-enforced (explicit allow-list of roles per route)
- Parent-facing serializers exclude clinical scores/psychologist notes at
  the API layer
- Supertest integration test covering the role-access boundary, not just
  the happy path
