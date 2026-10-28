# EvolvIQ Backend API

The EvolvIQ backend, built to [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/NAMING_CONVENTIONS.md`](docs/NAMING_CONVENTIONS.md). Working rules for contributors (and Claude) are in [`.claude/CLAUDE.md`](.claude/CLAUDE.md). Implemented: **authentication** (login, refresh, logout, admin-only registration), a **shared RBAC guard**, **school management**, **user management** (list / view / edit / deactivate / reactivate), **parent ↔ student links**, **classes**, and the core workflow **Observe → Review → Assign → Do → See**: observations (concerns, and positive ones that are stars for the student), the psychologist's review queue, the global activity library, assignments, completions, growth areas, streaks, stars and monthly summaries, the EvolvIQ Holistic Index and Growth Moments, family consent and wellbeing check-ins, staff-only school support plans, and a notification feed. Business rules the PRD left open were confirmed by the lead in October 2026 (§2, B1–B17).

| | |
|---|---|
| Language | TypeScript 7, `strict` mode (+ `noUncheckedIndexedAccess`, `noImplicitReturns`, …) |
| Runtime / framework | Node.js ≥ 22.12, Fastify 5 |
| Database / ORM | PostgreSQL ≥ 13 (tested on 16), Prisma 7 ORM with the `pg` driver adapter |
| Migrations | Prisma Migrate (`prisma/migrations`) |
| Validation | Zod 4 at the route boundary (`fastify-type-provider-zod`) |
| API docs | OpenAPI 3.1 generated from the Zod schemas (`@fastify/swagger`), served with Scalar at `/docs` |
| Tests | Vitest (unit/service) + Supertest (API integration, real PostgreSQL) |
| Password/PIN hashing | argon2id at 19 MiB memory, 2 iterations, 1 lane (the OWASP minimums) |
| Tokens | JWT HS256 via `jose` (access + rotating refresh tokens) |

---

## Quick start (no database installed yet)

You need Node.js ≥ 22.12 and Docker.

```bash
npm install
cp .env.example .env
# Edit .env: set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET to two DIFFERENT random values. Run twice:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

docker compose up -d          # PostgreSQL 16 on :5432 with databases "evolviq" and "evolviq_test"
npm run db:migrate            # prisma migrate deploy — creates the schema
npm run db:seed-dev           # two demo schools (development only)
npm run db:seed-demo          # optional: a full demo with every role, for the frontend (development only)
npm run bootstrap:admin       # first Platform Admin, from BOOTSTRAP_ADMIN_* in .env (idempotent)

npm run dev                   # http://localhost:3000   (or: npm run build && npm start)
```

Then open **http://localhost:3000/docs**, call `POST /api/v1/auth/login` with the bootstrap admin, paste the `accessToken` into the Authentication box, and try the school endpoints.

Check that everything works:

```bash
npm run typecheck             # tsc --noEmit, strict
npm test                      # 214 unit + 404 integration tests (uses TEST_DATABASE_URL)
npm run test:postman -- --env-var run=$RANDOM   # Postman collection via Newman (server must be running)
```

---

## 1. What the PRD actually says (documented requirements)

| # | Requirement | PRD source |
|---|---|---|
| D1 | There are six roles: Student, Parent, Teacher, School Admin, Psychologist and Platform Admin. | §2, §3 |
| D2 | **One auth endpoint** serves all roles. The login page's role toggle only changes the label and which app shell loads after auth. | §2 |
| D3 | Parent and Student have **separate credentials**, not a profile switcher. | §3 |
| D4 | Students sign in with a **student ID and PIN**. Screen A1 "assumes both exist". | §7 Q1 |
| D5 | **Platform Admin** can "create and deactivate every user type" and "add schools". | §3 |
| D6 | **School Admin** can "manage students, teachers, classes, parents" for the **whole school**. | §3 |
| D7 | **Teacher** must "never add, remove or deactivate any user". | §3 |
| D8 | **Psychologist** must "never manage schools, users or billing". | §3 |
| D9 | The only relationship is **one parent to many children**. There are no guardian hierarchies and no multi-school students. | §6 |
| D10 | Psychologist and Platform Admin work across schools. The C3 queue can be filtered "by school", and C1 shows platform-wide counts. | §3, §4 |
| D11 | Users can be **deactivated**. | §3 |

**Key finding:** the PRD has **no public self-sign-up**. Every account is created by a Platform Admin or a School Admin. So "Register" is an **authenticated, admin-only create-user endpoint**:

| Caller → can create | student | parent | teacher | school_admin | psychologist | platform_admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **platform_admin** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **school_admin** (own school only) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| teacher / psychologist / parent / student | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

## 2. Assumptions (not in the PRD, so each one is a decision)

| # | Assumption | Why | How to change it |
|---|---|---|---|
| A1 | Adults sign in with **email + password**. | The PRD names no identifier for adults. | Swap the `email` column and schema. |
| A2 | **Student IDs are supplied by the admin at registration.** Globally unique, case-insensitive (stored upper case), 3–32 characters of `A–Z 0–9 -`. | PRD §7 Q1 is still open. Global uniqueness lets a child log in without a school code. | If IDs are only unique per school, add `schoolCode` to student login and index `(school_id, student_login_id)`. |
| A3 | The **PIN is exactly 6 digits**. | A 4-digit PIN has only 10,000 combinations. | `pin` in `auth.schemas.ts`. |
| A4 | **No OTP.** | PRD §7 Q1 is unresolved; no phone field is defined. | Add it once Q1 is closed. |
| A5 | Passwords are 10–128 characters with no composition rules. | NIST SP 800-63B. | `password` in `auth.schemas.ts`. |
| A6 | School Admin, Teacher, Parent and Student belong to exactly one school. Psychologist and Platform Admin have no school. | D9, D10 | CHECK `users_school_scope_by_role`. |
| A7 | A student may be linked to **one parent**, who must be an **active parent in the same school** — at registration (`parentId`) or later via `/parent-students`. Stored in `parent_students` (primary key `student_id`). | D9 | `auth.repository.ts`, `parent-students.repository.ts` |
| A8 | **The first Platform Admin is created by a CLI script** (`npm run bootstrap:admin`), not an API. | A public "create first admin" endpoint would be a security hole. | n/a |
| A9 | A School Admin may omit `schoolId` (taken from their token); a different one gets 403. A Platform Admin **must** send `schoolId` for school-scoped roles. | D6 | `auth.policy.ts` |
| A10 | Access tokens last 1 hour by default and are sent as `Authorization: Bearer`. Refresh tokens (7 days) rotate on every use (§6.3). | The PRD says nothing about tokens. | `JWT_TTL_SECONDS`, `JWT_REFRESH_TTL_SECONDS` |
| A11 | **Lockout:** 5 failed attempts lock the account for 15 minutes; while locked even the correct secret gets the generic 401. | Protects 6-digit PINs. | `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES` |
| A12 | A deactivated user who enters the **correct** secret gets `403 ACCOUNT_DISABLED`; a wrong secret gets the generic 401. | Helps real users, tells an attacker nothing. | `auth.service.ts` |
| A13 | Login returns `role`; the login request does **not** take a role. | D2 | n/a |
| A14 | **School names are not unique.** Two schools may share a name (common for e.g. "St. Joseph's Matriculation School" in different towns); the schema has no city/address yet to tell them apart. So `POST /schools` never returns 409. | No uniqueness rule in the PRD or the domain model. | Add a unique index (e.g. on `lower(name)`); the error handler already maps unique violations to `409 CONFLICT`. |
| A15 | School names are 1–200 characters after trimming, with no control characters. | Matches the existing `schools.name` CHECK constraint. | `schools.schemas.ts` + the CHECK. |
| A16 | **Every authenticated request re-checks the caller in the database** (one primary-key lookup): the account must still exist, be active, and have the same role and school as the token. Otherwise → 401. | A deactivated or demoted Platform Admin must not keep managing schools for up to an hour. `/register` already enforced this; it now applies to every protected route. | `authenticate.ts` |

### Lead-confirmed rules (October 2026)

| # | Rule |
|---|---|
| B1 | Admins edit adults' `fullName` / `email` and students' `fullName` / `studentId`. Role and school never change. No password / PIN reset (PRD §7 Q6 still open). |
| B2 | Platform Admin deactivates / reactivates anyone; School Admin only students, teachers and parents of their school. Nobody deactivates or reactivates themselves. |
| B3 | Parent ↔ student lives in `parent_students`: a parent has many children, a student one parent, same school only. `users.school_id` stays (no multi-school membership). |
| B4 | A class belongs to one school, has only a `name` (unique per school, case-insensitive → 409), many teachers; a teacher has many classes; a student is in exactly one class. The school comes from the School Admin's token. |
| B5 | Teachers reach only the students of the classes they are assigned to. |
| B6 | Observation value lists (area, when, how often, level, learning-behaviour area, development area — no "other") are fixed; see `observation-options.ts`. Level and learning-behaviour area are teacher-only: a parent sending them → 400. |
| B7 | Teachers and parents see only the observations they wrote: teachers with status and the teacher-only note, parents with status only. |
| B8 | A review is one API call and one DB transaction (select activities → create recommended assignments → mark reviewed). It can't be repeated or edited (409). A Significant observation needs a development area. |
| B9 | One global activity library; only Psychologists create / edit / archive (never delete). Teachers browse and assign directly. Psychologists assign only through reviews. |
| B10 | Once assigned, an activity's type and options are frozen (archive + create new instead). |
| B11 | Five types: mcq (single `optionId`, no correct answer / scoring), text, image_pick (`optionId`, image URLs), rating (1–5), media_response (URL + text). One Zod discriminated union. No file upload. |
| B12 | No due dates, reattempts or cancellation; one completion per assignment. |
| B13 | Growth areas are derived from the development areas of "Assign & mark reviewed" reviews: the 5 most recent; never more than 5; no manual endpoint. |
| B14 | Monthly summary: template text, no AI, no cron. Current month built live; a finished month is stored once and never changes. |
| B15 | Streak: consecutive days with ≥ 1 completion, all 7 days, counting from yesterday if today isn't done yet. |
| B16 | Days and months are Asia/Kolkata; timestamps are stored in UTC. |
| B17 | Parents get only: their own observations with status, their child's activities done / not done (with the dates they were set and finished), streak, growth-area names, monthly summary — and, since B18, their child's stars. |
| B18 | *Client feedback, 21 Oct 2026.* An observation is a **concern** (as before: pending → reviewed) or **positive** (`tone`, default `concern`). A positive one is a **star** for the student: `celebrated` from the start, never reviewed (→ 409), never given a Level (→ 400), so never Significant and never a growth area. Stars (`/students/:studentId/stars`) show the giver's words, name and role to the student, their parent, their teachers and psychologists — never the learning-behaviour area. The monthly summary counts the month's stars. |
| B19 | *Client feedback, re-sent 28 Oct 2026.* Good news that went in as a concern — picked by mistake, or written before B18, when every observation was a concern — can be **made a star** while it is still pending: by the teacher who wrote it, or by a psychologist (`POST /observations/:observationId/celebrate`). It becomes positive and `celebrated`, its Level is dropped, and it leaves the queue; a reviewed one (→ 409) stays a concern, and a star is never turned back into one. |

Implementation choices within those rules (smallest reasonable option, flagged for review):

| # | Choice |
|---|---|
| C1 | Growth areas are **distinct**: an area tagged again moves to the front instead of appearing twice. |
| C2 | Parent-only endpoints live under **`/api/v1/family/`**; each audience has its own route and response schema, so a parent route can't return a teacher's shape. |
| C3 | A body reference outside the caller's scope (e.g. a teacher observing a student who isn't in their class) → **422 INVALID_REFERENCE**, identical to an unknown ID (the project's existing convention for body references). A path ID outside scope → **404**. |
| C4 | Moving a student to another class = remove, then add (adding to a second class → 409). Linking a student who already has a parent → 409 (unlink first). |
| C5 | A finished month's summary is stored the first time it is requested. Months before the student's account existed → 404; future months → 400. |
| C6 | Activities may still have their title and prompt edited after assignment; only the type and options are frozen. Archived activities can't be newly assigned; existing assignments keep working. |
| C7 | Teachers and psychologists see students' answers (`/students/:studentId/assignments`); parents never do. School Admins and Platform Admins have no access to observations, activities or progress. |

## 3. Gaps and open questions in the PRD

1. **§7 Q1:** who issues student IDs and PINs, and whether an OTP goes to the parent (A2–A4).
2. **§7 Q6:** password and PIN reset / change are not among the 21 screens and are not implemented.
3. **§7 Q5:** consent at parent onboarding is not recorded.
4. **CSV import** is V1, not MVP (ARCHITECTURE.md) — not built.
5. **Deleting users / classes / schools** is not built: users are deactivated instead; classes and schools have no delete in the MVP.
6. **School details:** the PRD only says Platform Admin "adds schools". Only `name` is modelled (A14). Deleting/archiving schools is not built.

---

## 4. Architecture

Layered modules exactly as in `docs/ARCHITECTURE.md`: **routes** (HTTP + Zod validation + RBAC wiring) → **services** (business rules) → **repositories** (Prisma) → PostgreSQL.

```
├── .claude/CLAUDE.md                    # project instructions / non-negotiables
├── docs/
│   ├── ARCHITECTURE.md                  # source of truth
│   └── NAMING_CONVENTIONS.md
├── prisma/
│   ├── schema.prisma                    # every model and enum (mirrors the migrations)
│   ├── migrations/
│   │   ├── 20260922000000_auth/            # enum, schools, users, constraints, indexes
│   │   ├── 20260929000000_refresh_tokens/  # refresh-token storage & revocation
│   │   ├── 20261001000000_schools_admin/   # schools.updated_at + list indexes
│   │   ├── 20261009000000_people/          # parent_students, classes, class_teachers, class_students
│   │   ├── 20261009010000_workflow/        # observations, activities, assignments, completions
│   │   ├── 20261009020000_progress/        # monthly_summaries (immutable)
│   │   ├── 20261021000000_observation_celebrated/  # observation_status + 'celebrated' (on its own: enum values commit first)
│   │   └── 20261021000100_observation_tone/        # observations.tone (positive / concern) + its CHECKs + the stars index
│   └── seed.dev.sql                     # 2 demo schools (dev only)
├── prisma.config.ts                     # Prisma 7 CLI config (loads .env)
├── scripts/bootstrap-admin.ts           # creates the first Platform Admin
├── src/
│   ├── server.ts                        # entry: listen + graceful shutdown
│   ├── app.ts                           # Fastify, Zod compilers, error handler, authN, docs, modules
│   ├── config.ts                        # env loading & fail-fast validation
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts           # /register (RBAC-guarded), /login, /refresh
│   │   │   ├── auth.schemas.ts          # Zod request/response schemas
│   │   │   ├── auth.policy.ts           # who-can-create-whom (pure)
│   │   │   ├── auth.service.ts          # register / login flows
│   │   │   ├── auth.repository.ts       # Prisma (typed raw SQL for atomic statements)
│   │   │   ├── authenticate.ts          # AUTHENTICATION hook → request.actor
│   │   │   ├── refresh-token.{service,repository}.ts
│   │   │   └── access-token.ts, refresh-token.ts, password.ts
│   │   ├── schools/
│   │   │   ├── schools.routes.ts        # 4 thin routes: Platform Admin writes; Psychologist lists; everyone views their own
│   │   │   ├── schools.schemas.ts       # Zod: body, :schoolId, list query (allowlists), responses
│   │   │   ├── schools.service.ts       # business rules, pagination metadata, 404s
│   │   │   ├── schools.repository.ts    # Prisma queries (DB-level paginate/sort/filter)
│   │   │   └── classes.{routes,schemas,service,repository}.ts  # classes + teacher / student membership
│   │   ├── users/
│   │   │   ├── users.{routes,schemas,service,repository}.ts      # list / view / edit / (de|re)activate
│   │   │   ├── parent-students.{routes,schemas,service,repository}.ts  # parent ↔ student links
│   │   │   └── student-scope.ts         # THE rule for which students a caller reaches (all modules use it)
│   │   ├── observations/
│   │   │   ├── observation-options.ts   # the value lists + UI labels, defined once
│   │   │   └── observations.{routes,schemas,service,repository}.ts  # create, own lists, queue, detail, review
│   │   ├── activities/
│   │   │   └── activities.{routes,schemas,service,repository}.ts    # library, assignments, completions
│   │   └── progress/
│   │       ├── business-time.ts         # Asia/Kolkata days / months, streak maths (pure)
│   │       └── progress.{routes,schemas,service,repository}.ts      # growth areas, streak, stars, monthly summary
│   ├── shared/
│   │   ├── rbac/                        # requireRole() guard, route-access startup check, Role, Actor
│   │   ├── errors/                      # AppError catalogue, error handler, Prisma mapping, error schema
│   │   ├── db/prisma.ts                 # Prisma Client factory + singleton (sessions pinned to UTC)
│   │   ├── pagination/                  # page / limit / sort helpers shared by every list endpoint
│   │   └── openapi/register-api-docs.ts # @fastify/swagger + Scalar
│   ├── types/fastify.d.ts               # request.actor, app.authenticate
│   └── generated/prisma/                # `prisma generate` output (git-ignored)
│   (tests are colocated: src/**/<name>.test.ts — see §12)
├── test/support/                        # integration harness (DB setup, Supertest helpers, workflow fixtures)
├── postman/EvolvIQ-Auth.postman_collection.json
├── docker-compose.yml                   # local PostgreSQL (+ evolviq_test database)
└── .env.example
```

### Authentication vs authorisation (shared RBAC guard)

```
Request
  → app.authenticate      (src/modules/auth/authenticate.ts)   401 if no/invalid/expired token,
                           verifies JWT + re-checks the user     or the account is gone/inactive/changed
  → requireRole(...)       (src/shared/rbac/require-role.ts)    403 if the role is not allowed
  → Zod validation                                               400
  → route → service → repository → Prisma → PostgreSQL
```

- **Authentication** is the only code that reads `Authorization` headers. It sets `request.actor = { userId, role, schoolId }`.
- **The RBAC guard** only reads `request.actor` and the route's allowed roles. It fails **closed** (401) if a route forgot authentication. There is no role checking inside any route handler.
- Both run as `onRequest` hooks, i.e. **before** the body is parsed or validated, so unauthenticated or unauthorised callers cost no parsing, hashing or business work.
- Usage: `onRequest: [app.authenticate, requireRole(Role.PlatformAdmin)]`.
- **Every route must declare its access explicitly** (CLAUDE.md). An `onRoute` check (`shared/rbac/route-access.ts`) makes the app **refuse to start** if any `/api` route has neither a `requireRole(...)` guard nor `config: publicAccess()`. Only `/auth/login` and `/auth/refresh` are public.
- `/auth/register` uses the same guard with `requireRole(...REGISTRAR_ROLES)` (Platform Admin, School Admin). The finer, body-dependent rule ("a School Admin may only create students/teachers/parents in their own school") stays a business rule in the service (`auth.policy.ts`).
- Roles use the existing database format (`platform_admin`, `school_admin`, …). A compile-time check guarantees the RBAC `Role` type and Prisma's `UserRole` enum never drift apart.

### Why some auth queries are `$queryRaw`

The schools module uses the fluent Prisma Client API. The auth module keeps three hand-written statements, sent through Prisma's **tagged-template** `$queryRaw` / `$executeRaw` (every `${value}` is a bind parameter — never string-built SQL), because their guarantees can't be expressed with the fluent API without extra round trips or locks:

- **register**: one CTE re-checks the caller, checks the parent, and inserts; duplicates are caught by unique indexes, never SELECT-then-INSERT (20 concurrent identical requests → exactly one 201);
- **refresh rotation**: one conditional `UPDATE … RETURNING` + insert, so exactly one of N concurrent refreshes wins;
- **failed-login counter**: an atomic `CASE` increment, and lock state evaluated on the database clock.

## 5. Database design

- `user_role` **enum** — the database rejects invalid roles.
- **CHECK constraints** make invalid states unrepresentable (credential by role, school scope by role, normalised email / student ID, name lengths; observations: author is a parent or teacher, teacher-only fields, consistent review state, Significant needs a development area, positive ⇔ celebrated, no Level on a positive one; assignments: recommended ⇔ linked to an observation). Prisma's schema language can't express CHECKs; they live in the migrations, and Prisma ignores them when diffing, so they are never dropped.
- **Partial unique indexes** `users_email_key`, `users_student_login_id_key` (modelled in `schema.prisma` with the `partialIndexes` preview feature): the login lookup path and the race-safe duplicate guard.
- **Schools:** `updated_at` (set by Prisma's `@updatedAt` on rename) and B-tree indexes on `name` and `created_at` to serve `ORDER BY … LIMIT/OFFSET` for the list endpoint.
- **Timezones.** Every timestamp column is `timestamptz`. Prisma's pg driver adapter assumes the session time zone is UTC (it writes `DateTime` values as UTC wall-clock time with no offset, and replaces the offset of every `timestamptz` it reads with `+00:00`). On a server whose `TimeZone` isn't UTC, e.g. a local PostgreSQL installed in India, that shifted every timestamp by the offset (refresh tokens were stored as expiring 5 h 30 m early). `createPrismaClient` therefore pins every session to UTC (`options: '-c TimeZone=UTC'`), whatever the server default. Don't put an `options=` parameter in `DATABASE_URL`: pg lets the URL override it.
- **People** (`20261009000000_people`): `parent_students` (PK `student_id` = one parent per student; existing `users.parent_id` links were moved here and the column dropped), `classes` (`name citext`, unique `(school_id, name)` = case-insensitive per school), `class_teachers` (PK `(class_id, teacher_id)`), `class_students` (PK `student_id` = one class per student), `users.updated_at`.
- **Workflow** (`20261009010000_workflow`): Postgres enums for every observation list, `observations`, `activities` (`type` enum + `content` jsonb, `archived_at`), `assignments` (unique `(observation_id, activity_id)`), `activity_completions` (unique `assignment_id` = one completion per assignment).
- **Progress** (`20261009020000_progress`): `monthly_summaries` (PK `(student_id, month)`); a trigger refuses every UPDATE and DELETE, so a stored summary can't change.
- **Tone** (`20261021000000_observation_celebrated`, `20261021000100_observation_tone`): `observation_status` gains `celebrated` in a migration of its own (PostgreSQL won't use an enum value in the transaction that adds it); then `observation_tone` (`positive` / `concern`), `observations.tone` (default `concern`, so every earlier observation stays a concern), the review-state CHECK widened to `celebrated`, `(tone = 'positive') = (status = 'celebrated')`, no Level on a positive one, and a partial index `(student_id, created_at) WHERE tone = 'positive'` for a student's stars.
- Same-school rules (parent ↔ child, class ↔ teacher / student) are checked in the same SQL statement that writes the link; `users.role` and `users.school_id` never change, so a valid link stays valid.
- Foreign keys are `ON DELETE RESTRICT`, except `refresh_tokens.user_id → users` (`ON DELETE CASCADE`).

### Queries per request

| Request | DB round trips |
|---|---|
| Any protected request: authentication | **1** primary-key lookup (user still active, same role/school) |
| Register | authentication + **1** CTE |
| Login, clean account | **2** (SELECT + refresh-token INSERT); +1 reset after earlier failures; wrong secret: 2 |
| Refresh, success | **1** CTE |
| Schools: create / view / rename | authentication + **1** |
| Schools: list | authentication + **1 transaction** with the page query (`WHERE … ILIKE`, `ORDER BY`, `LIMIT/OFFSET`) and a `COUNT` |
| Logout | authentication + **1** `UPDATE` (revoke the token's family) |
| Users: list | authentication + **1 transaction** (page query + `COUNT`) |
| Users: view | authentication + **1** |
| Users: deactivate | authentication + 1 lookup + **1 transaction** (`UPDATE users` + revoke refresh tokens) |
| Observation review | authentication + 1 lookup + **1 transaction** (lock, check activities, insert assignments, update) + 1 read |

## 6. API reference

The interactive, always-up-to-date reference is at **`/docs`** (OpenAPI JSON at `/docs/openapi.json`). All endpoints accept and return JSON. Every error has the same shape:

```json
{ "error": { "code": "MACHINE_CODE", "message": "Human readable.", "details": [ { "field": "name", "message": "…" } ] } }
```

`details` is a list of `{ field, message }` for validation errors (every failing field is listed; unknown fields are reported as `"is not allowed"`), an object such as `{ "field": "email" }` for 409/422, or absent.

| Status | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `BAD_REQUEST` | Invalid body, query or path parameter; malformed JSON |
| 401 | `UNAUTHENTICATED` (`INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN` on auth routes) | Missing, invalid, expired or forged token; account gone, inactive or changed |
| 403 | `FORBIDDEN` (`ACCOUNT_DISABLED`) | Authenticated, but the role is not allowed |
| 404 | `NOT_FOUND` | Resource does not exist |
| 409 | `DUPLICATE_ACCOUNT`, `CONFLICT` | Unique constraint |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | Body over 16 KB / not JSON |
| 422 | `INVALID_REFERENCE` | Referenced school/parent does not exist |
| 500 | `INTERNAL_ERROR` | Unexpected server or database error (details are logged, never returned) |

### 6.1 `POST /api/v1/auth/register`

**Auth:** Bearer token. **RBAC:** Platform Admin, School Admin (shared guard). Body depends on `role`; unknown fields are **rejected**.

| role | required | optional |
|---|---|---|
| `student` | `fullName`, `studentId`, `pin` | `schoolId`\*, `parentId` |
| `parent`, `teacher`, `school_admin` | `fullName`, `email`, `password` | `schoolId`\* |
| `psychologist`, `platform_admin` | `fullName`, `email`, `password` | (none; `schoolId` is rejected) |

\* A Platform Admin must send `schoolId`. For a School Admin it is implied (A9).

`201 Created` → `{ "user": { "id", "role", "fullName", "schoolId", "parentId", "createdAt" } }`

| Status | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad/missing/unknown field, unknown role, `schoolId` missing for a Platform Admin |
| 401 | `UNAUTHENTICATED` | No/invalid/expired/forged token, or the caller has since been deactivated |
| 403 | `FORBIDDEN` | Caller's role may not register anyone (guard), may not create this role, or targets another school |
| 409 | `DUPLICATE_ACCOUNT` | Email or student ID exists. `details: { field }` |
| 422 | `INVALID_REFERENCE` | Unknown `schoolId`, or `parentId` isn't an active parent in the same school |

### 6.2 `POST /api/v1/auth/login`

Body is **exactly one** of `{ "email", "password" }` or `{ "studentId", "pin" }`. `200` (header `Cache-Control: no-store`):

```json
{ "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 3600,
  "refreshToken": "eyJ…", "refreshExpiresIn": 604800,
  "user": { "id": "df7e…", "role": "teacher", "fullName": "Priya Raman", "schoolId": "1111…" } }
```

400 `VALIDATION_ERROR` · 401 `INVALID_CREDENTIALS` (identical for unknown user, wrong secret, locked) · 403 `ACCOUNT_DISABLED` (correct secret only).

Access-token claims: `sub`, `role`, `sid` (school or null), `iss`, `aud`, `iat`, `exp`, `jti`. Refresh-token claims: `sub`, `jti`, `iss`, `aud`, `iat`, `exp` only.

### 6.3 `POST /api/v1/auth/refresh`

Body `{ "refreshToken": "eyJ…" }`, no `Authorization` header. Returns a new access token **and a new refresh token**; the presented one is revoked (`Cache-Control: no-store`).

400 `VALIDATION_ERROR` · 401 `INVALID_REFRESH_TOKEN` (one body for malformed, forged, wrong alg/iss/aud, expired, unknown, revoked, reused, or lost a concurrent rotation) · 403 `ACCOUNT_DISABLED`.

How it works: only the JTI is stored; one SQL statement revokes the token *only if live*, reads the user's current role/school/active flag, and inserts the successor in the same family. Exactly one of N concurrent refreshes wins. **Reuse** of a revoked token revokes its whole family (other sessions survive). Expiry slides on each rotation.

> **Client rule:** refresh from one place at a time; two tabs refreshing with the same token count as reuse.

Expired/revoked rows are not purged automatically: `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day';`

### 6.4 Schools

**Auth:** Bearer token. **RBAC** (shared guard): create and rename are Platform Admin only. The list is Platform Admin and Psychologist (who filters the review queue by school). Viewing one school is open to every role, but only Platform Admins and Psychologists see any school; everyone else sees only their own, and another school → `404` (the same as a missing one). A role outside a route's list → `403 FORBIDDEN`; no/invalid token or inactive account → `401 UNAUTHENTICATED`.

A school is `{ "id": "uuid", "name": "…", "createdAt": "ISO-8601", "updatedAt": "ISO-8601" }`.

| Method & path | Body / params | Success | Errors |
|---|---|---|---|
| `POST /api/v1/schools` | `{ "name": "…" }` (1–200 chars after trim, no control chars, no other fields) | `201 { "school" }` + `Location` header | 400, 401, 403, 500 |
| `GET /api/v1/schools` | query below | `200 { "schools": [...], "pagination": {...} }` | 400, 401, 403, 500 |
| `GET /api/v1/schools/:schoolId` | `schoolId` = UUID | `200 { "school" }` | 400, 401, 403, **404**, 500 |
| `PATCH /api/v1/schools/:schoolId` | `schoolId` = UUID; `{ "name": "…" }` | `200 { "school" }` (`updatedAt` bumped) | 400, 401, 403, **404**, 500 |

**List query parameters** (all optional; unknown parameters → 400):

| Param | Values | Default |
|---|---|---|
| `page` | integer 1–10 000 | `1` |
| `limit` | integer 1–100 | `20` |
| `sortBy` | `name` \| `createdAt` \| `updatedAt` (**allowlist**; anything else → 400) | `name` |
| `sortOrder` | `asc` \| `desc` | `asc` |
| `name` | case-insensitive "contains" filter, ≤ 200 chars; `%` and `_` match literally; blank = no filter | — |

```json
{ "schools": [ { "id": "…", "name": "Demo School A", "createdAt": "…", "updatedAt": "…" } ],
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false } }
```

Pagination, sorting and filtering all happen **in PostgreSQL** (`WHERE name ILIKE …`, `ORDER BY <allowlisted column>, id`, `LIMIT/OFFSET`, plus a `COUNT` in the same transaction). The `id` tie-breaker makes page boundaries deterministic. `sortBy` reaches Prisma only through a fixed `field → orderBy` map, never directly. A page past the end returns `schools: []` with consistent metadata.

### 6.5 `POST /api/v1/auth/logout`

**Auth:** Bearer token. **RBAC:** every role. Body `{ "refreshToken": "eyJ…" }` (unknown fields rejected).

Ends the caller's **current session**: the presented refresh token and every token rotated from it (its family) are revoked, so the session can no longer be refreshed. The user's other sessions stay signed in. The **access token is not revoked**; it stops working when it expires (`expiresIn`, 1 hour by default). Whether logout should also end all sessions or the access token immediately is an open question for the lead.

`204 No Content` · 400 `VALIDATION_ERROR` · 401 `UNAUTHENTICATED` (access token) · 401 `INVALID_REFRESH_TOKEN` (refresh token malformed, forged, expired, or **not the caller's** — someone else's session is never touched). Logging out an already-ended session returns 204.

### 6.6 Users (Platform Admin, School Admin)

Accounts are **created** with `POST /auth/register` (§6.1). These endpoints list, view, edit, deactivate and reactivate them.

| Method & path | RBAC | Success | Errors |
|---|---|---|---|
| `GET /api/v1/users` | Platform Admin, School Admin | `200 { "users": [...], "pagination": {...} }` | 400, 401, 403, 500 |
| `GET /api/v1/users/:userId` | Platform Admin, School Admin | `200 { "user" }` | 400, 401, 403, **404**, 500 |
| `PATCH /api/v1/users/:userId` | Platform Admin, School Admin | `200 { "user" }` | 400, 401, 403, **404**, **409**, 500 |
| `POST /api/v1/users/:userId/deactivate` | Platform Admin, School Admin | `200 { "user" }` | 400, 401, 403, **404**, 500 |
| `POST /api/v1/users/:userId/reactivate` | Platform Admin, School Admin | `200 { "user" }` | 400, 401, 403, **404**, 500 |

A user is `{ "id", "role", "fullName", "email", "studentId", "schoolId", "parentId", "isActive", "createdAt" }`. `email` is null for students, `studentId` and `parentId` are null for adults. Password/PIN hashes and lockout state are never returned.

**Scope.** A Platform Admin sees every user. A School Admin sees only **students, teachers and parents of their own school** (the same rule as who they may register):
- listing another school (`schoolId`) or a role they don't manage (`role=school_admin|psychologist|platform_admin`) → **403**;
- viewing, editing, deactivating or reactivating anyone outside that reach → **404**, identical to an unknown ID, so IDs can't be probed.

**List query** (all optional; unknown parameters → 400): `page`, `limit` (as for schools), `sortBy` = `fullName` (default) \| `createdAt`, `sortOrder`, `role`, `schoolId`, `isActive` = `true` \| `false`, `name` (case-insensitive contains on the full name, ≤ 100 chars, `%`/`_` literal).

**Deactivate.** Sets `isActive: false` and revokes all the user's refresh tokens in one transaction. Afterwards login → `403 ACCOUNT_DISABLED`, existing access tokens → 401 on the next request (A16), refresh → 401. Idempotent (an inactive user → 200 unchanged). Nobody can deactivate their own account (403).

**Reactivate.** Sets `isActive: true`; the user can log in again (normal lockout rules apply). Sessions revoked at deactivation stay revoked. Idempotent; not on yourself (403).

**Edit** (`PATCH`, strict body, at least one field): adults `fullName`, `email`; students `fullName`, `studentId` — same validation and normalisation as registration. A student `email` / adult `studentId` → 400; `role`, `schoolId`, `parentId`, `isActive`, `password`, `pin` → 400 "is not allowed"; a taken email / student ID → 409 `DUPLICATE_ACCOUNT` `{ field }`.

### 6.7 Parent ↔ student links

| Method & path | RBAC | Success | Errors |
|---|---|---|---|
| `POST /api/v1/parent-students` `{ parentId, studentId }` | Platform Admin, School Admin (own school) | `201 { "link": { parent, student, createdAt } }` | 400, 401, 403, **409** (student already has a parent), **422** (not a student / active parent of the same school), 500 |
| `GET /api/v1/parent-students?parentId&studentId&page&limit` | Platform Admin (all), School Admin (own school), Parent (own children) | `200 { "links", "pagination" }` | 400, 401, 403, 500 |
| `DELETE /api/v1/parent-students/:studentId` | Platform Admin, School Admin (own school) | `204` | 400, 401, 403, 404, 500 |

### 6.8 Classes (School Admin; Teachers read their own)

| Method & path | RBAC | Success | Errors |
|---|---|---|---|
| `POST /api/v1/classes` `{ name }` | School Admin | `201 { "class" }` + `Location` | 400 (incl. a `schoolId` in the body), 401, 403, **409** duplicate name (any case), 500 |
| `GET /api/v1/classes?page&limit&sortBy=name\|createdAt&sortOrder&name` | School Admin (school), Teacher (assigned classes) | `200 { "classes", "pagination" }` | 400, 401, 403, 500 |
| `GET /api/v1/classes/:classId` | School Admin, Teacher (assigned only) | `200 { "class", "teachers", "students" }` | 400, 401, 403, 404, 500 |
| `PATCH /api/v1/classes/:classId` `{ name }` | School Admin | `200 { "class" }` | 400, 401, 403, 404, **409**, 500 |
| `PUT` / `DELETE /api/v1/classes/:classId/teachers/:teacherId` | School Admin | `204` (PUT idempotent) | 400, 401, 403, 404, 500 |
| `PUT` / `DELETE /api/v1/classes/:classId/students/:studentId` | School Admin | `204` (PUT idempotent for the same class) | 400, 401, 403, 404, **409** (already in another class), 500 |

A class is `{ id, schoolId, name, createdAt, updatedAt }`. Teacher / student of another school → 404.

### 6.9 Observations

| Method & path | RBAC | Success | Errors |
|---|---|---|---|
| `POST /api/v1/observations` | Teacher (students of their classes) | `201 { "observation": TeacherObservation }` | 400, 401, 403, 422, 500 |
| `GET /api/v1/observations/mine?status&page&limit` | Teacher | `200 { "observations": TeacherObservation[], "pagination" }` | 400, 401, 403, 500 |
| `POST /api/v1/family/observations` | Parent (own children) | `201 { "observation": ParentObservation }` | 400 (incl. `level` / `learningBehaviourArea`), 401, 403, 422, 500 |
| `GET /api/v1/family/observations?status&page&limit` | Parent | `200 { "observations": ParentObservation[], "pagination" }` | 400, 401, 403, 500 |
| `GET /api/v1/observations?status&tone&level&authorRole&schoolId&studentId&area&sortOrder&page&limit` | Psychologist | `200 { "observations": ReviewObservation[], "pagination" }` | 400, 401, 403, 500 |
| `GET /api/v1/observations/:observationId` | Psychologist | `200 { "observation", "history" }` (student's other observations, newest first, ≤ 20) | 400, 401, 403, 404, 500 |
| `POST /api/v1/observations/:observationId/review` | Psychologist | `200 { "observation": ReviewObservation }` | 400, 401, 403, 404, **409** (already reviewed, or positive), 422, 500 |
| `POST /api/v1/observations/:observationId/celebrate` | Teacher (only what they wrote; anyone else's → 404), Psychologist | `204` (now positive and `celebrated`, Level dropped) | 400, 401, 403, 404, **409** (already reviewed, or already a star), 500 |

Create body: `{ studentId, tone?, area, description, when, howOften }` (+ teachers: optional `level`, `learningBehaviourArea`). `tone` is `"concern"` (the default: status `pending`, for review) or `"positive"` (a star: status `celebrated`, never reviewed; a `level` with it → 400). Review body: `{ "outcome": "assigned", "activityIds": [1–10 ids], "developmentArea"?, "teacherOnlyNote"? }` or `{ "outcome": "no_action", "developmentArea"?, "teacherOnlyNote"? }`. The frontend's queue asks for `tone=concern`, so stars never wait there; they appear in a student's history for context.

- **ParentObservation** = `id, studentId, tone, area, description, when, howOften, status, createdAt` — nothing else.
- **TeacherObservation** = the above + `level, learningBehaviourArea, teacherOnlyNote, reviewedAt` (null while pending).
- **ReviewObservation** = everything, with `student`, `author`, and `review { outcome, developmentArea, teacherOnlyNote, reviewedBy, reviewedAt, activityIds }` (null while pending).

### 6.10 Activities, assignments and completions

| Method & path | RBAC | Success | Errors |
|---|---|---|---|
| `POST /api/v1/activities` `{ title, content }` | Psychologist | `201 { "activity" }` | 400, 401, 403, 500 |
| `GET /api/v1/activities?type&title&isArchived&sortBy&sortOrder&page&limit` | Psychologist, Teacher (active only) | `200 { "activities", "pagination" }` | 400, 401, 403, 500 |
| `GET /api/v1/activities/:activityId` | Psychologist, Teacher (active only) | `200 { "activity" }` | 400, 401, 403, 404, 500 |
| `PATCH /api/v1/activities/:activityId` `{ title?, content? }` | Psychologist | `200 { "activity" }` | 400, 401, 403, 404, **409** (type / options frozen), 500 |
| `POST /api/v1/activities/:activityId/archive` | Psychologist | `200 { "activity" }` | 400, 401, 403, 404, 500 |
| `POST /api/v1/assignments` `{ studentId, activityId }` | Teacher (students of their classes) | `201 { "assignment" }` (source `direct`) | 400, 401, 403, 422, 500 |
| `GET /api/v1/assignments/mine?isDone&page&limit` | Student | `200 { "assignments" }` (activity content + own answer) | 400, 401, 403, 500 |
| `POST /api/v1/activity-completions` `{ assignmentId, answer }` | Student (own assignment) | `201 { "completion" }` | 400, 401, 403, 404, **409** (already completed), 500 |
| `GET /api/v1/students/:studentId/assignments` | Teacher (own classes), Psychologist | `200 { "assignments" }` (with answers) | 400, 401, 403, 404, 500 |
| `GET /api/v1/family/children/:studentId/assignments` | Parent (own children) | `200 { "assignments": [{ id, title, isDone, assignedAt, completedAt }] }` (`completedAt` null while to do) | 400, 401, 403, 404, 500 |

`content` / `answer` are discriminated unions on `type`: `mcq` `{ prompt, options: [{ id, label }] (2–6) }` → `{ optionId }`; `text` `{ prompt }` → `{ text }`; `image_pick` `{ prompt, options: [{ id, imageUrl, label? }] }` → `{ optionId }`; `rating` `{ prompt }` → `{ rating: 1–5 }`; `media_response` `{ prompt, mediaUrl }` → `{ text }`. URLs must be http(s).

### 6.11 Progress

Students (themselves), Parents (own children), Teachers (their classes' students) and Psychologists; anyone else's student → 404. Every response is parent-safe.

| Method & path | Success |
|---|---|
| `GET /api/v1/students/:studentId/growth-areas` | `200 { "growthAreas": [{ "name": "Managing feelings" }, …] }` — at most 5, newest first |
| `GET /api/v1/students/:studentId/streak` | `200 { "streak": { "days": 3 } }` |
| `GET /api/v1/students/:studentId/stars?page&limit` | `200 { "stars": [{ id, studentId, area, description, givenBy: { fullName, role }, createdAt }], "pagination" }` — one per positive observation, newest first; `pagination.total` is the count |
| `GET /api/v1/students/:studentId/monthly-summaries/:month` (`YYYY-MM`) | `200 { "summary": { studentId, month, text, isFinal } }` (counts the month's stars); future month → 400, before the account existed → 404 |

**Business dates.** Timestamps are stored in UTC; streak days and summary months are **Asia/Kolkata** calendar days / months (`src/modules/progress/business-time.ts`): an activity completed at 00:15 IST on 1 November (18:45 UTC on 31 October) counts for 1 November.

## 7. Security measures

- **No plain-text secrets.** argon2id hashes only; Zod response schemas strip any field not declared.
- **Anti-enumeration.** One login error for unknown user / wrong secret / locked; unknown users still cost one argon2 verify against a startup dummy hash (tested).
- **Brute force.** Atomic per-account failure counter + lockout.
- **Injection.** Prisma parameterises every query (fluent API and tagged-template raw SQL). Zod validates every body, query and path parameter before the handler; unknown fields are rejected; names may not contain control characters; `sortBy` is an allowlist; LIKE wildcards in the name filter are escaped.
- **Tokens.** HS256 secrets ≥ 32 bytes and different for access/refresh (startup fails otherwise); algorithm, `iss`, `aud` pinned (`alg: none` rejected — tested); token failures return a plain 401; tokens are never logged (`authorization` header redacted).
- **Stale privileges.** Every authenticated request re-checks that the account is still active with the same role/school (A16). Register additionally re-checks inside its insert statement.
- **Authorisation ordering.** Authentication and the RBAC guard run in `onRequest`, before body parsing.
- **Error hygiene.** Unexpected and database errors are logged server-side; clients get `INTERNAL_ERROR` only. Unhandled Prisma unique violations map to 409 without constraint names.
- **Resource bounds.** 16 KB body limit; password ≤ 128 chars; `limit` ≤ 100 and `page` ≤ 10 000; DB `statement_timeout` 5 s; connect timeout 5 s.
- **API docs** are on by default except when `NODE_ENV=production` (`API_DOCS_ENABLED`).

## 8. Recommended before production (not built, per scope)

- **IP-level rate limiting** at the gateway (per-account lockout doesn't stop password spraying).
- **HTTPS only**, terminated at the proxy.
- **Revoke-all-sessions / password reset** once PRD Q6 is decided. (Logout of the current session is built — §6.5.)
- Cookie-based tokens (`HttpOnly; Secure; SameSite=Strict`) + CSRF protection if the web apps prefer cookies.
- Keyset (cursor) pagination for the school list if it ever grows to tens of thousands of rows (OFFSET cost grows with the page number).

---

## 9. Setup in detail

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `prisma generate` + run `src/server.ts` with reload (tsx) |
| `npm run build` / `npm start` | `prisma generate` + `tsc` → `dist/`; run `dist/src/server.js` |
| `npm run typecheck` | Strict type check, no output |
| `npm run db:migrate` | `prisma migrate deploy` — apply pending migrations (all environments) |
| `npm run db:migrate:dev` | `prisma migrate dev` — create a new migration after editing `schema.prisma` (development) |
| `npm run db:migrate:status` | Show applied / pending migrations |
| `npm run db:seed-dev` | Insert the two demo schools |
| `npm run db:seed-demo` | Development only: a full demo (two schools, every role, classes, activities, concerns at every stage of review, stars from teachers and parents, completions) through the real API. The same people as the frontend's offline mock; adults sign in with `EvolvIQ-Demo-2026`, students (`RV-1001`…) with PIN `246810`. Does nothing if it has already run. |
| `npm run bootstrap:admin` | Create the first Platform Admin from `BOOTSTRAP_ADMIN_*` (idempotent) |
| `npm test` / `test:unit` / `test:integration` | Vitest (integration needs `TEST_DATABASE_URL`) |
| `npm run test:postman` | Run the Postman collection with Newman against `{{baseUrl}}` (Newman is fetched on demand with `npx`, not installed with the project) |

### Without Docker

Install PostgreSQL 13+ yourself, then `createdb evolviq` and `createdb evolviq_test`, and point `DATABASE_URL` / `TEST_DATABASE_URL` at them.

### `JWT_SECRET` → `JWT_ACCESS_SECRET`

The access-token secret is now `JWT_ACCESS_SECRET` (docs/NAMING_CONVENTIONS.md). An existing `.env` that still says `JWT_SECRET` keeps working, but the server logs `JWT_SECRET is deprecated; rename it to JWT_ACCESS_SECRET.` at startup. Rename it in every environment; the fallback can then be deleted from `src/config.ts`.

### Dependency security

`npm install` should report **0 vulnerabilities**. `package.json` → `overrides` pins patched versions of three transitive packages (`undici` under Scalar; `mysql2` and `deepmerge-ts` under the Prisma CLI). Don't run `npm audit fix --force`: it "fixes" those by downgrading Prisma to v6, which breaks the project. When Prisma/Scalar ship releases that include the patched versions, the overrides can be removed.

### Upgrading a database created by the old JavaScript version

Databases created with the previous `npm run db:migrate` (`scripts/migrate.js`, tracked in `schema_migrations`) already contain the first two migrations. Mark them as applied once, then deploy the rest:

```bash
npx prisma migrate resolve --applied 20260922000000_auth
npx prisma migrate resolve --applied 20260929000000_refresh_tokens
npm run db:migrate          # applies every later migration (schools_admin, people, workflow, progress)
```

### Tests

The integration tests use a **separate** database whose schema is **dropped and rebuilt** on every run, by applying every `prisma/migrations/*/migration.sql` in order (so the run also proves the migrations work on an empty database). For safety the database name must contain `test`. Files run one at a time; each starts from a clean data set. The setup also sets the test database's default `TimeZone` to **Asia/Kolkata**, so the whole suite runs against a non-UTC server (see §5, Timezones).

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/evolviq_test npm test
```

## 10. cURL examples

```bash
BASE=http://localhost:3000/api/v1
TOKEN=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"root@evolviq.dev","password":"Change-Me-Now-2026"}' | jq -r .accessToken)

# ✅ Create a school → 201 (+ Location header)
ID=$(curl -s -X POST $BASE/schools -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Sunrise Public School"}' | jq -r .school.id)

# ✅ List: page 1 of 10, newest first, names containing "sun"
curl -s "$BASE/schools?page=1&limit=10&sortBy=createdAt&sortOrder=desc&name=sun" -H "Authorization: Bearer $TOKEN"

# ✅ View / ✅ Rename
curl -s $BASE/schools/$ID -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH $BASE/schools/$ID -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Sunrise Public School (Erode)"}'

# ❌ sortBy not allowlisted → 400   ❌ unknown id → 404   ❌ no token → 401
curl -s "$BASE/schools?sortBy=password" -H "Authorization: Bearer $TOKEN"
curl -s $BASE/schools/99999999-9999-4999-8999-999999999999 -H "Authorization: Bearer $TOKEN"
curl -s $BASE/schools

# ✅ Register a School Admin → 201, then ❌ that School Admin lists schools → 403
curl -s -X POST $BASE/auth/register -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"role\":\"school_admin\",\"fullName\":\"Kavya S\",\"email\":\"kavya@school-a.test\",\"password\":\"SchoolAdmin-Pass-1\",\"schoolId\":\"$ID\"}"
SA=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"kavya@school-a.test","password":"SchoolAdmin-Pass-1"}' | jq -r .accessToken)
curl -s $BASE/schools -H "Authorization: Bearer $SA"

# ✅ Refresh → new access + new refresh token; ❌ re-using the old refresh token → 401 (family revoked)
RT=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"root@evolviq.dev","password":"Change-Me-Now-2026"}' | jq -r .refreshToken)
curl -s -X POST $BASE/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$RT\"}"
curl -s -X POST $BASE/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$RT\"}"
```

## 11. Postman

Import `postman/EvolvIQ-Auth.postman_collection.json` and run it top to bottom (Collection Runner). It logs in first and stores tokens and ids in collection variables (`platformToken`, `schoolAdminToken`, `teacherToken`, `parentToken`, `studentToken`, `psychologistToken`, `classId`, `observationId`, …) — **no JWT or id is hard-coded**. Set `run` to a new value before each re-run so emails, student IDs and class names stay unique. It expects the bootstrap admin `root@evolviq.dev` / `Change-Me-Now-2026` (the `.env.example` defaults) and the demo schools (`npm run db:seed-dev`). Folders 6–13 build on the accounts created in folders 2–4, so run the whole collection in order.

| Folder | Covers |
|---|---|
| 1–4 · Login, Register, Role boundaries | Login / lockout-safe errors, admin-only registration rules, student login |
| 5 · Schools | Create (saves `schoolId`), list (pagination / sorting / filter / allowlist errors), view, rename, 404 / 400, Teacher / School Admin → 403, no token → 401 |
| 6 · Session (logout) | Logout → 204, refresh afterwards → 401, repeat logout → 204, someone else's refresh token → 401 (their session survives), unknown field → 400, no token → 401 |
| 7 · Users | Platform Admin and School Admin lists (scope, other school / unmanaged role → 403), view (out of reach → 404), edit (trimmed name; student email, role / school → 400; taken email → 409), deactivate → login 403 `ACCOUNT_DISABLED` → reactivate → login 200, self-deactivation → 403 |
| 8 · Parent ↔ student links | Link → 201, second parent → 409, cross-school → 422, parent sees only own children, teacher → 403, unlink → 204 / 404, relink |
| 9 · Classes | Create (+ Location), duplicate name any case → 409, `schoolId` in body → 400, assign teacher (idempotent), School B teacher → 404, add students, second class → 409, rename, teacher sees only own classes, Teacher / Platform Admin create → 403 |
| 10 · Activity library | All five types, invalid content → 400, teacher create → 403, teacher browse, edit, archive, archived hidden from teachers |
| 11 · Observations & review | Teacher / parent create, out-of-scope student → 422, bad enum → 400, parent `level` / `learningBehaviourArea` → 400, own lists, queue filters, detail + history, Significant without area → 400, Assign & mark reviewed, re-review → 409, archived activity → 422, parent sees status only (nothing clinical), teacher sees the note, options frozen after assignment → 409 |
| 12 · Assignments & completions | Direct assignment, out-of-class student / archived activity → 422, psychologist direct → 403, student's own list, answers per type, reattempt → 409, wrong option / type → 400, rating 6 → 400, another student → 404, teacher sees answers, parent sees done / not done only, other child → 404 |
| 13 · Progress | Growth areas (names only, ≤ 5), streak, current-month summary (live, parent-safe; month computed in Asia/Kolkata by a pre-request script), future month / bad format → 400, psychologist → 200, other school's parent → 404, School Admin → 403 |

Verified with Newman against a live server on a freshly migrated database, run twice with different `run` values: **165 requests, 274 assertions, 0 failures**.

```bash
npm run test:postman -- --env-var baseUrl=http://localhost:3000 --env-var run=$RANDOM
```

## 12. Test coverage

**644 tests: 224 unit (Vitest) + 420 API integration (Vitest + Supertest, real PostgreSQL).** Tests are colocated with the code they cover (`<name>.test.ts`). Tests of `*.routes.ts` / `*.repository.ts` files (`*.routes*.test.ts`, `*.repository*.test.ts`) and of the database client (`shared/db/*.test.ts`) form the integration project; everything else is unit. All 63 tests of the previous JavaScript suite were ported case-for-case.

| File | Cases |
|---|---|
| `modules/auth/auth.routes.test.ts` (34, ported) | Login success/failure/validation, lockout, deactivation, anti-enumeration timing; register authN (no/garbage/forged/`alg:none` token), authZ matrix, validation (12 field cases), duplicates (case-insensitive), 20-way race → one 201, unknown school/parent → 422, argon2id storage, trimming |
| `modules/auth/auth.routes.refresh.test.ts` (25, ported) | Refresh issuance on login, rotation, chain of 3, current role in new token, every rejection path, deactivation, reuse → family revocation, 10-way concurrency → one winner |
| `modules/auth/auth.routes.rbac.test.ts` (9) | `/register` uses the shared guard: non-registrars get 403 **before** validation; registrars pass the guard; per-target business rules still apply |
| `modules/schools/schools.routes.test.ts` (64) | RBAC on all 4 endpoints (401 for none/garbage/forged/expired/refresh token; 403 for each of the 5 other roles with no side effects; guard runs before validation; deactivated or demoted Platform Admin → 401); create (shape, Location, trim, 200-char max, 8 invalid bodies, malformed JSON, 415); view (200, 404, invalid `schoolId`); rename (trim, `updatedAt` bump, 404, 5 invalid bodies, unchanged on failure); list (defaults vs DB order, disjoint pages adding up to the total, past-the-end page, limit cap, sort by name/createdAt/updatedAt asc+desc vs DB order, 6 non-allowlisted `sortBy` values, bad `sortOrder`/`page`/`limit`, unknown param, case-insensitive filter, no-match, literal `%`/`_`, blank filter, filter+sort+page combined); database failure → 500 with nothing leaked |
| `modules/auth/auth.routes.logout.test.ts` (20) | Logout: 401 without a valid access token or with a refresh token as access token; every role → 204; deactivated caller → 401; 4 invalid bodies; refresh after logout → 401; whole family revoked (rotated successor too); other sessions survive; repeat logout → 204; someone else's refresh token → 401 with their session intact; forged / malformed / non-UUID-jti / access-token-as-refresh → 401; unknown session → 204 |
| `modules/users/users.routes.test.ts` (39) | RBAC (401 ×2 tokens, 403 for teacher/parent/student/psychologist on all 3 endpoints, School Admin can't deactivate); exact DTO keys and no secrets; Platform Admin list vs DB (role/school/active/name filters, literal `%`, sort ×4 vs DB order, disjoint pages, past-the-end page, 9 invalid queries); School Admin sees only own-school students/teachers/parents, other school / unmanaged role → 403; view: Platform Admin anyone, School Admin own reach, everyone else → 404, unknown → 404, bad id → 400; deactivate: login → 403 `ACCOUNT_DISABLED`, access token → 401, refresh → 401, others untouched, idempotent, any role incl. Platform Admin, self → 403, 404/400 |
| `modules/users/users.service.test.ts` (33) | Scope per actor (pass-through for Platform Admin; forced school + managed roles for School Admin; other school / unmanaged role / other callers → 403 without touching the repository), skip/take + metadata, DTO mapping, 404 for out-of-reach users, edit normalisation and per-role fields, deactivate / reactivate scope and self-protection |
| `modules/users/users.schemas.test.ts` (15) | List query defaults and parsing, strict `isActive`, blank name, 10 rejected queries, `userId` UUID |
| `shared/db/prisma.test.ts` (5) | Timezone regression against a non-UTC server: Prisma sessions are UTC, DB-generated and client-supplied timestamps round-trip as the same instant (checked through a separate connection), raw `now()` matches the clock |
| `modules/users/users.routes.manage.test.ts` (33) | Edit adults / students (normalised; login with the new identifier), single-field edit, student email / adult studentId → 400, immutable role / school / parent / active / secrets → 400, invalid bodies, duplicates (any case) → 409, School Admin scope (404 outside, nothing changes); School Admin deactivation (tokens revoked, login 403, logout 401), no self-deactivation / self-reactivation; reactivation restores login but not old sessions, idempotent, scope |
| `modules/users/parent-students.routes.test.ts` (20) | RBAC; link → 201 and visible on `/users`; parent with many children; second parent / same link → 409; 5 concurrent links → one wins; cross-school → 422; School Admin other school → 422; wrong roles / inactive / unknown → 422 naming the field; unlink and relink; unlink out of scope → 404; School Admin and Parent list scope; register `parentId` writes the link |
| `modules/schools/classes.routes.test.ts` (27) | RBAC (Parent, Psychologist, Platform Admin → 403; Teacher read-only); create (+ Location, `schoolId` in body → 400); duplicate names any case → 409, same name in another school OK; rename (409, 404 other school); many teachers ↔ many classes; idempotent assignment; cross-school / wrong role → 404; one class per student (409), move = remove + add, 4 concurrent adds → one wins; teacher sees only own classes and their students |
| `modules/observations/observations.routes.test.ts` (52) | RBAC for all 7 routes; teacher create (teacher-only fields, scope → 422, every enum value accepted, 8 invalid inputs); parent create (level / learning-behaviour area → 400, not ignored; own children only; a positive one is celebrated); positive observations: celebrated at once with no Level, a Level → 400, review → 409 with nothing changed, never in Pending / Reviewed, `tone` filter, the database refuses a star in a review state or with a Level; teacher / parent see only their own (vs DB), parent never sees teacher observations or anything clinical after review; teacher sees the note but not reviewer / area; queue filters vs DB (Pending, Significant, From parents, Reviewed, by school, combined, 6 invalid); detail + history; review assigned / no_action; re-review → 409; 5 concurrent reviews → one; Significant needs an area; every development area, no "other"; 7 invalid review bodies; archived / unknown activity → 422; **atomicity**: injected failures at "mark reviewed" and at the 2nd assignment roll everything back |
| `modules/activities/activities.routes.test.ts` (60) | 5 types created via the union; 15 invalid contents → 400; RBAC (Psychologist writes, Teacher browses); global library across schools; edit before assignment; archive (idempotent, hidden from teachers, not assignable, no delete endpoint); type / options frozen once assigned (4 changes → 409, title / prompt still editable, review assignment freezes too); direct assignment scope (422), psychologist can't assign directly; staff view with answers; 5 valid answers; wrong type / option → 400; 8 invalid answers; one completion (409), 5 concurrent → one; other students → 404; student sees only own; parent sees done / not done and never answers |
| `modules/progress/progress.routes.test.ts` (26) | Fixed clock (IST date ≠ UTC date). Access (student, parent, teacher, psychologist → 200; anyone else → 404; admins → 403); stars: none yet, a teacher's and a parent's positive observations newest first and the same for every viewer, concerns never stars, exact keys and never the learning-behaviour area, paging, a month's stars in its summary; growth areas: only "assigned" with an area, newest first, never > 5, older drop off, distinct, no add endpoint; streak: IST vs UTC days, today not done, 00:01 IST, missed day, none, month boundary + weekends, duplicates and future; summary: current month live and not stored, IST month boundaries, finished month stored once and unchanged by later data, DB refuses UPDATE / DELETE, growth areas as of month end (IST), concurrent first requests → one row, future / too old / bad format, no clinical text |
| `modules/progress/business-time.test.ts` (30), `progress.service.test.ts` (8) | IST day / month boundaries (18:30 UTC), leap years, calendar arithmetic, streak and longest-run rules; the summary template, stars included; the star mapper |
| `modules/observations/observations.service.test.ts` (5), `modules/activities/activities.service.test.ts` (3) | Allow-list mappers on fully populated records: parent / family DTOs carry no clinical value, no answer; a positive observation reads as celebrated |
| `modules/users/student-scope.test.ts` (6) | The student-scope rule per role |
| `modules/schools/schools.repository.test.ts` (1) | Captures Prisma's SQL: the list query contains `ILIKE`, `ORDER BY "name" DESC`, `LIMIT` and `OFFSET`, and the count is filtered too |
| `modules/schools/schools.service.test.ts` (13) | Trimming, DTO mapping, typed 404s, error propagation, page → skip/take, defaults, pagination metadata table |
| `modules/schools/schools.schemas.test.ts` (53) | Query defaults/parsing, 10 bad `page`, 5 bad `limit`, arrays, 9 non-allowlisted `sortBy`, bad `sortOrder`, filter trimming/cap, unknown params, create/rename bodies, `schoolId` param |
| `shared/rbac/require-role.test.ts` (15) | Guard allows Platform Admin, 403 for each other role, 401 with no actor, multi-role guards, unknown role never admitted; roles match the DB enum; `/register` guard roles |
| `shared/rbac/route-access.test.ts` (7) | Startup check: guarded and public routes boot; undeclared, authenticate-only, or public+guard routes fail startup; non-`/api` routes ignored |
| `shared/errors/error-handler.test.ts` (10) | AppError → status/body, Zod issues → field paths, unknown keys, Prisma P2002 → 409 / P2025 → 404 / others → 500, no leaked internals, raw-query constraint extraction |
| `shared/openapi/register-api-docs.test.ts` (11) | `/docs` served; OpenAPI 3.1 with bearer scheme; auth endpoints still documented; each school endpoint has security, Platform Admin note, tags and its error responses; list query params incl. enums; `schoolId` path param and request bodies; logout (all roles, 204); user endpoints; EVERY API operation declares bearer auth + allowed roles; `/family/*` is Parent-only; every workflow endpoint and schema documented |
| `config.test.ts` (9) | Refresh-secret rules (ported); `JWT_ACCESS_SECRET` used; legacy `JWT_SECRET` accepted with a warning; both set → new one wins; neither → startup fails |

Mutation check: deliberately removing the guard from either route (the app now refuses to start), removing the public marker from login, making the guard allow every role, dropping LIKE escaping, ignoring `is_active` in authentication, sorting by the wrong column, an off-by-one in pagination, or removing the 404 each made the suite fail.
