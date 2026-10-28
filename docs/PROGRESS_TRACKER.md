# EvolvIQ Backend — Progress Tracker

Status legend: `Not Started` / `In Progress` / `Blocked` / `Done`

Update this table as work lands — keep it in sync with merged PRs, not with plans.

## Setup
| Item | Status | Owner | Notes |
|---|---|---|---|
| Project scaffold (Fastify + TS) | Done | | on `API`, not yet merged to `main` |
| Prisma + Postgres via Docker Compose | Done | | on `API`, not yet merged to `main`. Sessions pinned to UTC (timezone fix) |
| Base `schema.prisma` (School, User, Class, Observation, Activity, Assignment, ActivityCompletion, ProgressSummary) | Done | | on `API`, not yet merged to `main`. Migrations `people`, `workflow`, `progress`; ProgressSummary is `monthly_summaries` (growth areas / streaks are derived) |
| Auth: JWT access/refresh, login endpoint | Done | | on `API`, not yet merged to `main` |
| RBAC middleware | Done | | on `API`, not yet merged to `main`. `shared/rbac` guard + startup check that every route declares roles |
| Frontend integration support | Done | | on `API`, not yet merged to `main`. Psychologists list and view every school, every role views its own; `reviewedAt` on teachers' observations; `assignedAt` / `completedAt` on parents' activity list; `npm run db:seed-demo` (development only) creates the frontend's demo people |
| CI: lint + typecheck + test on PR | Not Started | | |

## Auth & users
| Item | Status | Owner | Notes |
|---|---|---|---|
| Login/session endpoints | Done | | on `API`, not yet merged to `main`. Login, refresh (rotating), logout (current session; access token expires on its own) |
| Role-scoped user endpoints | Done | | on `API`, not yet merged to `main`. `/users` list / view / edit / deactivate / reactivate; `/parent-students` links |

## Observations
| Item | Status | Owner | Notes |
|---|---|---|---|
| Create observation (parent/teacher variants) | Done | | on `API`, not yet merged to `main`. Parent: `/family/observations`; Teacher: `/observations` |
| Review queue list + filters (Pending/Significant/From parents/Reviewed/school) | Done | | on `API`, not yet merged to `main` |
| Observation detail + related history | Done | | on `API`, not yet merged to `main` |
| Review action (tag area, note, assign/no-action) | Done | | on `API`, not yet merged to `main`. One DB transaction with the recommended assignments; re-review → 409 |
| Positive observations (tone) | Done | | Client feedback 21 Oct 2026; not yet committed. `tone` (concern / positive, default concern); positive = status `celebrated`, never reviewed (409), no Level (400); DB CHECKs; queue `tone` filter. Migrations `20261021000000_observation_celebrated` and `20261021000100_observation_tone`: deploy them before the frontend that sends `tone` |
| Pending concern → star (`/observations/:id/celebrate`) | Done | | Client feedback re-sent 28 Oct 2026; not yet committed. The teacher who wrote it, or a psychologist; 204; reviewed / already a star → 409; another teacher's → 404; races a review safely (6 API tests). No migration: deploy it before the frontend that calls it |

## Activities
| Item | Status | Owner | Notes |
|---|---|---|---|
| Activity library CRUD (simple form) | Done | | on `API`, not yet merged to `main`. Global library, archive (no delete), 5 types, frozen once assigned |
| Assignment (direct + recommended) | Done | | on `API`, not yet merged to `main` |
| Completion submission endpoint | Done | | on `API`, not yet merged to `main`. One completion per assignment |

## Progress
| Item | Status | Owner | Notes |
|---|---|---|---|
| Growth areas (5-cap) calculation | Done | | on `API`, not yet merged to `main`. Derived from "Assign & mark reviewed" development areas |
| Monthly summary generation (Parent-safe) | Done | | on `API`, not yet merged to `main`. Template text; current month live, finished months stored and immutable (IST months) |
| Streak calculation | Done | | on `API`, not yet merged to `main`. Asia/Kolkata days |
| Stars | Done | | Client feedback 21 Oct 2026; not yet committed. `GET /students/:studentId/stars` (student, parent, teacher, psychologist; student scope), paged, newest first; the monthly summary counts the month's stars; demo seed has stars from teachers and parents |

## School / Platform administration
| Item | Status | Owner | Notes |
|---|---|---|---|
| School Admin CRUD (students/teachers/classes/parents) | Done | | on `API`, not yet merged to `main`. Create via `/auth/register`; list/view/edit/deactivate/reactivate via `/users`; parent links; classes with teachers / students. No delete (deactivation instead) |
| Platform Admin CRUD (schools/users) | Done | | on `API`, not yet merged to `main`. Schools: create/list/view/rename. Users: create/list/view/edit/deactivate/reactivate |

## Quality
| Item | Status | Owner | Notes |
|---|---|---|---|
| Supertest coverage: role-access boundaries | Done | | Every endpoint: 401, 403 per role, cross-school / out-of-scope 404/422 |
| Parent-facing serializer exclusion tests (clinical data) | Done | | API tests + mapper unit tests on fully populated records |
