# EvolvIQ Backend — Scope of Work

Source of truth: `EvolvIQ_MVP_Scope_Confirmation.pdf` (Sept 2026). This file
translates that PRD into backend-specific deliverables.

## Core workflow to support end-to-end
Observe → Review → Assign → Do → See

## In scope by domain

### Auth & users
- Login/session (JWT access + refresh)
- Roles: Student, Parent, Teacher, Psychologist, School Admin, Platform Admin
- RBAC middleware enforced at the route layer, not just in service logic

### Observations
- Create observation (Parent variant: area, free text, when, how often;
  Teacher variant: adds Level + Learning-behaviour area)
- List/filter for Psychologist queue: Pending, Significant, From parents,
  Reviewed, by school
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
  clinical scores/psychologist notes)
- Streak calculation from completions

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
