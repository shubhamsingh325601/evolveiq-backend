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

## Messages
| Item | Status | Owner | Notes |
|---|---|---|---|
| Parent to school messages (Connect) | Done | | 12 Nov 2026; not yet committed. Migration `20261112000000_messages` (deploy before the frontend). `GET /students/:id/contacts` (names and roles only), `GET`/`POST /students/:id/messages` (parent), staff inbox `GET /messages`, thread `GET`/`POST /messages/:studentId` (reply only, staff never start a thread). Typechecks; the supertest file `messages.routes.test.ts` is written but not yet run (no Postgres here) |

## IT Help Desk (gap found against client prototype, 16 Nov 2026 — not yet confirmed scope)
| Item | Status | Owner | Notes |
|---|---|---|---|
| Ticketing (`SupportTicket`) | Done | | Not yet committed. Migration `20261116000000_support_tickets`. `POST /support-tickets` (teacher, psychologist, school admin; own school, starts `open`); `GET /support-tickets` (school admin: whole school; teacher/psychologist: only their own; platform admin: any school, optional `schoolId` filter); `PATCH /support-tickets/:ticketId` status only (school admin: own school; platform admin: any; 404 outside scope). No DB reachable in this sandbox to run `prisma migrate dev` — migration SQL written by hand against the existing migrations' style; apply and verify against a real Postgres before merging |

## School / Platform administration
| Item | Status | Owner | Notes |
|---|---|---|---|
| School Admin CRUD (students/teachers/classes/parents) | Done | | on `API`, not yet merged to `main`. Create via `/auth/register`; list/view/edit/deactivate/reactivate via `/users`; parent links; classes with teachers / students. No delete (deactivation instead) |
| Platform Admin CRUD (schools/users) | Done | | on `API`, not yet merged to `main`. Schools: create/list/view/rename. Users: create/list/view/edit/deactivate/reactivate |
| Removal (users without records, classes, empty schools) | Done | | Client feedback 29 Oct 2026; not yet committed. `DELETE /users/:id` (409 `HAS_RECORDS` when records point at it), `/classes/:id` (students stay), `/schools/:id` (empty only) |
| Imports (students, teachers, parents) | Done | | Client feedback 29 Oct 2026; not yet committed. `POST /imports/people`: up to 500 rows, every row checked and reported, dry run by default, all or nothing in one transaction, new classes created |

## School life (client feedback, 29 Oct 2026)
| Item | Status | Owner | Notes |
|---|---|---|---|
| Health and care needs | Done | | Not yet committed. `/students/:id/health` (GET parent/teacher/psychologist/school admin; PUT parent/school admin), `/classes/:id/health`; migration `20261029000000_health_attendance_notices_staff_honours` |
| Attendance | Done | | Not yet committed. `/classes/:id/attendance` (range ≤ 62 days) and `PUT …/:day` (today or 30 days back); teachers of the class and the school admin |
| Notice board | Done | | Not yet committed. `/notices` CRUD; audiences; platform notices for every school; an emergency contact needs a phone |
| Staff reviews | Done | | Not yet committed. `/staff-reviews` (school admin; a teacher reads their own) |
| Honours (Staff and Students of the Month) | Done | | Not yet committed. `/honours`; families see the Staff of the Month and their own child only |
| Demo data for the above | Done | | Not yet committed. `db:seed-demo` adds them, and tops up a demo database seeded before 29 Oct 2026 |

## Staff Training & Development Hub
| Item | Status | Owner | Notes |
|---|---|---|---|
| Trainings + enrolments | Done | | Gap found against the client's prototype, 16 Nov 2026 — not yet confirmed scope (see SCOPE_OF_WORK.md); not yet committed. `GET`/`POST /trainings` (school admin own school; platform admin one school or every school, same NULL-`schoolId` pattern as notices); `PATCH`/`DELETE /trainings/:trainingId` (own school or platform admin, 404 otherwise); `POST`/`PATCH /trainings/:trainingId/enrolment` (teacher/psychologist self-enrol and self-complete, 409 on double enrolment, 404 outside scope or never enrolled). List responses carry the caller's own `myEnrolment` only — no completion-rate or per-staff aggregate endpoint (forbidden by SCOPE_OF_WORK.md). Migration `20261116010000_trainings`; no reachable Postgres in this sandbox (no Docker, nothing on localhost:5432), so it is hand-written to match existing migrations' DDL conventions and applied only via the integration test harness, not against a real dev DB |

## Quality
| Item | Status | Owner | Notes |
|---|---|---|---|
| Supertest coverage: role-access boundaries | Done | | Every endpoint: 401, 403 per role, cross-school / out-of-scope 404/422 |
| Parent-facing serializer exclusion tests (clinical data) | Done | | API tests + mapper unit tests on fully populated records |
