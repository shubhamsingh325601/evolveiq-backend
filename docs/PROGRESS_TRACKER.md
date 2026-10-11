# EvolvIQ Backend — Progress Tracker

Status legend: `Not Started` / `In Progress` / `Blocked` / `Done`

Update this table as work lands — keep it in sync with merged PRs, not with plans.

## Setup
| Item | Status | Owner | Notes |
|---|---|---|---|
| Project scaffold (Fastify + TS) | Done | | on `evolviq-backend`, not yet merged |
| Prisma + Postgres via Docker Compose | Done | | on `evolviq-backend`, not yet merged. Sessions pinned to UTC (timezone fix) |
| Base `schema.prisma` (School, User, Class, Observation, Activity, Assignment, ActivityCompletion, ProgressSummary) | Done | | on `evolviq-backend`, not yet merged. Migrations `people`, `workflow`, `progress`; ProgressSummary is `monthly_summaries` (growth areas / streaks are derived) |
| Auth: JWT access/refresh, login endpoint | Done | | on `evolviq-backend`, not yet merged |
| RBAC middleware | Done | | on `evolviq-backend`, not yet merged. `shared/rbac` guard + startup check that every route declares roles |
| CI: lint + typecheck + test on PR | Not Started | | |

## Auth & users
| Item | Status | Owner | Notes |
|---|---|---|---|
| Login/session endpoints | Done | | on `evolviq-backend`, not yet merged. Login, refresh (rotating), logout (current session; access token expires on its own) |
| Role-scoped user endpoints | Done | | on `evolviq-backend`, not yet merged. `/users` list / view / edit / deactivate / reactivate; `/parent-students` links |

## Observations
| Item | Status | Owner | Notes |
|---|---|---|---|
| Create observation (parent/teacher variants) | Done | | on `evolviq-backend`, not yet merged. Parent: `/family/observations`; Teacher: `/observations` |
| Review queue list + filters (Pending/Significant/From parents/Reviewed/school) | Done | | on `evolviq-backend`, not yet merged |
| Observation detail + related history | Done | | on `evolviq-backend`, not yet merged |
| Review action (tag area, note, assign/no-action) | Done | | on `evolviq-backend`, not yet merged. One DB transaction with the recommended assignments; re-review → 409 |

## Activities
| Item | Status | Owner | Notes |
|---|---|---|---|
| Activity library CRUD (simple form) | Done | | on `evolviq-backend`, not yet merged. Global library, archive (no delete), 5 types, frozen once assigned |
| Assignment (direct + recommended) | Done | | on `evolviq-backend`, not yet merged |
| Completion submission endpoint | Done | | on `evolviq-backend`, not yet merged. One completion per assignment |

## Progress
| Item | Status | Owner | Notes |
|---|---|---|---|
| Growth areas (5-cap) calculation | Done | | on `evolviq-backend`, not yet merged. Derived from "Assign & mark reviewed" development areas |
| Monthly summary generation (Parent-safe) | Done | | on `evolviq-backend`, not yet merged. Template text; current month live, finished months stored and immutable (IST months) |
| Streak calculation | Done | | on `evolviq-backend`, not yet merged. Asia/Kolkata days |

## School / Platform administration
| Item | Status | Owner | Notes |
|---|---|---|---|
| School Admin CRUD (students/teachers/classes/parents) | Done | | on `evolviq-backend`, not yet merged. Create via `/auth/register`; list/view/edit/deactivate/reactivate via `/users`; parent links; classes with teachers / students. No delete (deactivation instead) |
| Platform Admin CRUD (schools/users) | Done | | on `evolviq-backend`, not yet merged. Schools: create/list/view/rename. Users: create/list/view/edit/deactivate/reactivate |

## Quality
| Item | Status | Owner | Notes |
|---|---|---|---|
| Supertest coverage: role-access boundaries | Done | | Every endpoint: 401, 403 per role, cross-school / out-of-scope 404/422 |
| Parent-facing serializer exclusion tests (clinical data) | Done | | API tests + mapper unit tests on fully populated records |
