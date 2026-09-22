# EvolvIQ Backend — Progress Tracker

Status legend: `Not Started` / `In Progress` / `Blocked` / `Done`

Update this table as work lands — keep it in sync with merged PRs, not with plans.

## Setup
| Item | Status | Owner | Notes |
|---|---|---|---|
| Project scaffold (Fastify + TS) | Not Started | | |
| Prisma + Postgres via Docker Compose | Not Started | | |
| Base `schema.prisma` (School, User, Class, Observation, Activity, Assignment, ActivityCompletion, ProgressSummary) | Not Started | | |
| Auth: JWT access/refresh, login endpoint | Not Started | | |
| RBAC middleware | Not Started | | |
| CI: lint + typecheck + test on PR | Not Started | | |

## Auth & users
| Item | Status | Owner | Notes |
|---|---|---|---|
| Login/session endpoints | Not Started | | |
| Role-scoped user endpoints | Not Started | | |

## Observations
| Item | Status | Owner | Notes |
|---|---|---|---|
| Create observation (parent/teacher variants) | Not Started | | |
| Review queue list + filters (Pending/Significant/From parents/Reviewed/school) | Not Started | | |
| Observation detail + related history | Not Started | | |
| Review action (tag area, note, assign/no-action) | Not Started | | |

## Activities
| Item | Status | Owner | Notes |
|---|---|---|---|
| Activity library CRUD (simple form) | Not Started | | |
| Assignment (direct + recommended) | Not Started | | |
| Completion submission endpoint | Not Started | | |

## Progress
| Item | Status | Owner | Notes |
|---|---|---|---|
| Growth areas (5-cap) calculation | Not Started | | |
| Monthly summary generation (Parent-safe) | Not Started | | |
| Streak calculation | Not Started | | |

## School / Platform administration
| Item | Status | Owner | Notes |
|---|---|---|---|
| School Admin CRUD (students/teachers/classes/parents) | Not Started | | |
| Platform Admin CRUD (schools/users) | Not Started | | |

## Quality
| Item | Status | Owner | Notes |
|---|---|---|---|
| Supertest coverage: role-access boundaries | Not Started | | |
| Parent-facing serializer exclusion tests (clinical data) | Not Started | | |
