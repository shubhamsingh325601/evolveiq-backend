# EvolvIQ Backend API

The EvolvIQ backend, built to [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/NAMING_CONVENTIONS.md`](docs/NAMING_CONVENTIONS.md). Working rules for contributors (and Claude) are in [`CLAUDE.md`](CLAUDE.md). Implemented so far: **authentication** (login, refresh, admin-only registration), a **shared RBAC guard**, and **Platform Admin school management**. Everything else in the architecture (users, observations, activities, progress) is not built yet.

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
npm run bootstrap:admin       # first Platform Admin, from BOOTSTRAP_ADMIN_* in .env (idempotent)

npm run dev                   # http://localhost:3000   (or: npm run build && npm start)
```

Then open **http://localhost:3000/docs**, call `POST /api/v1/auth/login` with the bootstrap admin, paste the `accessToken` into the Authentication box, and try the school endpoints.

Check that everything works:

```bash
npm run typecheck             # tsc --noEmit, strict
npm test                      # 113 unit + 133 integration tests (uses TEST_DATABASE_URL)
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
| A7 | A student may optionally be linked to **one parent** (`parentId`), who must be an **active parent in the same school**. | D9 | The CTE in `auth.repository.ts`. |
| A8 | **The first Platform Admin is created by a CLI script** (`npm run bootstrap:admin`), not an API. | A public "create first admin" endpoint would be a security hole. | n/a |
| A9 | A School Admin may omit `schoolId` (taken from their token); a different one gets 403. A Platform Admin **must** send `schoolId` for school-scoped roles. | D6 | `auth.policy.ts` |
| A10 | Access tokens last 1 hour by default and are sent as `Authorization: Bearer`. Refresh tokens (7 days) rotate on every use (§6.3). | The PRD says nothing about tokens. | `JWT_TTL_SECONDS`, `JWT_REFRESH_TTL_SECONDS` |
| A11 | **Lockout:** 5 failed attempts lock the account for 15 minutes; while locked even the correct secret gets the generic 401. | Protects 6-digit PINs. | `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES` |
| A12 | A deactivated user who enters the **correct** secret gets `403 ACCOUNT_DISABLED`; a wrong secret gets the generic 401. | Helps real users, tells an attacker nothing. | `auth.service.ts` |
| A13 | Login returns `role`; the login request does **not** take a role. | D2 | n/a |
| A14 | **School names are not unique.** Two schools may share a name (common for e.g. "St. Joseph's Matriculation School" in different towns); the schema has no city/address yet to tell them apart. So `POST /schools` never returns 409. | No uniqueness rule in the PRD or the domain model. | Add a unique index (e.g. on `lower(name)`); the error handler already maps unique violations to `409 CONFLICT`. |
| A15 | School names are 1–200 characters after trimming, with no control characters. | Matches the existing `schools.name` CHECK constraint. | `schools.schemas.ts` + the CHECK. |
| A16 | **Every authenticated request re-checks the caller in the database** (one primary-key lookup): the account must still exist, be active, and have the same role and school as the token. Otherwise → 401. | A deactivated or demoted Platform Admin must not keep managing schools for up to an hour. `/register` already enforced this; it now applies to every protected route. | `authenticate.ts` |

## 3. Gaps and open questions in the PRD

1. **§7 Q1:** who issues student IDs and PINs, and whether an OTP goes to the parent (A2–A4).
2. **§7 Q6:** password and PIN reset / change are not among the 21 screens and are not implemented.
3. **§7 Q5:** consent at parent onboarding is not recorded.
4. **CSV import** is V1, not MVP (ARCHITECTURE.md) — not built.
5. **Deactivation:** `is_active` is respected everywhere; the API that deactivates users is not built.
6. **School details:** the PRD only says Platform Admin "adds schools". Only `name` is modelled (A14). Deleting/archiving schools is not built.

---

## 4. Architecture

Layered modules exactly as in `docs/ARCHITECTURE.md`: **routes** (HTTP + Zod validation + RBAC wiring) → **services** (business rules) → **repositories** (Prisma) → PostgreSQL.

```
├── CLAUDE.md                            # project instructions / non-negotiables
├── docs/
│   ├── ARCHITECTURE.md                  # source of truth
│   └── NAMING_CONVENTIONS.md
├── prisma/
│   ├── schema.prisma                    # User, School, RefreshToken, enum UserRole
│   ├── migrations/
│   │   ├── 20260922000000_auth/            # enum, schools, users, constraints, indexes
│   │   ├── 20260929000000_refresh_tokens/  # refresh-token storage & revocation
│   │   └── 20261001000000_schools_admin/   # schools.updated_at + list indexes
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
│   │   │   ├── schools.routes.ts        # 4 thin routes, Platform Admin only
│   │   │   ├── schools.schemas.ts       # Zod: body, :schoolId, list query (allowlists), responses
│   │   │   ├── schools.service.ts       # business rules, pagination metadata, 404s
│   │   │   └── schools.repository.ts    # Prisma queries (DB-level paginate/sort/filter)
│   │   └── users/ observations/ activities/ progress/   # reserved, not implemented
│   ├── shared/
│   │   ├── rbac/                        # requireRole() guard, route-access startup check, Role, Actor
│   │   ├── errors/                      # AppError catalogue, error handler, Prisma mapping, error schema
│   │   ├── db/prisma.ts                 # Prisma Client factory + singleton
│   │   └── openapi/register-api-docs.ts # @fastify/swagger + Scalar
│   ├── types/fastify.d.ts               # request.actor, app.authenticate
│   └── generated/prisma/                # `prisma generate` output (git-ignored)
│   (tests are colocated: src/**/<name>.test.ts — see §12)
├── test/support/                        # integration harness: global DB setup + Supertest helpers
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
- **CHECK constraints** make invalid states unrepresentable (credential by role, school scope by role, `parent_id` only on students, normalised email / student ID, school name length). Prisma's schema language can't express CHECKs; they live in the migrations, and Prisma ignores them when diffing, so they are never dropped.
- **Partial unique indexes** `users_email_key`, `users_student_login_id_key` (modelled in `schema.prisma` with the `partialIndexes` preview feature): the login lookup path and the race-safe duplicate guard.
- **Schools:** `updated_at` (set by Prisma's `@updatedAt` on rename) and B-tree indexes on `name` and `created_at` to serve `ORDER BY … LIMIT/OFFSET` for the list endpoint.
- Foreign keys: `users.school_id → schools`, `users.parent_id → users` (both `ON DELETE RESTRICT`), `refresh_tokens.user_id → users` (`ON DELETE CASCADE`).

### Queries per request

| Request | DB round trips |
|---|---|
| Any protected request: authentication | **1** primary-key lookup (user still active, same role/school) |
| Register | authentication + **1** CTE |
| Login, clean account | **2** (SELECT + refresh-token INSERT); +1 reset after earlier failures; wrong secret: 2 |
| Refresh, success | **1** CTE |
| Schools: create / view / rename | authentication + **1** |
| Schools: list | authentication + **1 transaction** with the page query (`WHERE … ILIKE`, `ORDER BY`, `LIMIT/OFFSET`) and a `COUNT` |

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

### 6.4 Schools (Platform Admin only)

**Auth:** Bearer token. **RBAC:** Platform Admin only, via the shared guard. Any other role → `403 FORBIDDEN`; no/invalid token or inactive account → `401 UNAUTHENTICATED`.

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
- **Logout / revoke-all-sessions / password reset** once PRD Q6 is decided.
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

Databases created with the previous `npm run db:migrate` (`scripts/migrate.js`, tracked in `schema_migrations`) already contain the first two migrations. Mark them as applied once, then deploy the new one:

```bash
npx prisma migrate resolve --applied 20260922000000_auth
npx prisma migrate resolve --applied 20260929000000_refresh_tokens
npm run db:migrate          # applies 20261001000000_schools_admin
```

### Tests

The integration tests use a **separate** database whose schema is **dropped and rebuilt** on every run, by applying every `prisma/migrations/*/migration.sql` in order (so the run also proves the migrations work on an empty database). For safety the database name must contain `test`. Files run one at a time; each starts from a clean data set.

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

Import `postman/EvolvIQ-Auth.postman_collection.json` and run it top to bottom (Collection Runner). It logs in first and stores tokens in collection variables (`platformToken`, `schoolAdminToken`, `teacherToken`) — **no JWT is hard-coded**. Set `run` to a new value before each re-run so emails/IDs stay unique. It expects the bootstrap admin `root@evolviq.dev` / `Change-Me-Now-2026` (the `.env.example` defaults) and the demo schools (`npm run db:seed-dev`).

Folder **5 · Schools (Platform Admin)** covers: Create School (saves `schoolId`), blank name → 400, List (defaults), List with pagination, List with sorting, List with name filter, sortBy not allowlisted → 400, limit > 100 → 400, View, View not found → 404, View invalid id → 400, Rename, Rename invalid body → 400, Rename not found → 404, and unauthorised access (Teacher → 403, School Admin → 403 ×2, no token → 401).

Verified with Newman against a live server: **44 requests, 69 assertions, 0 failures**.

```bash
npm run test:postman -- --env-var baseUrl=http://localhost:3000 --env-var run=$RANDOM
```

## 12. Test coverage

**246 tests: 113 unit (Vitest) + 133 API integration (Vitest + Supertest, real PostgreSQL).** Tests are colocated with the code they cover (`<name>.test.ts`). Tests of `*.routes.ts` / `*.repository.ts` files (`*.routes*.test.ts`, `*.repository*.test.ts`) form the integration project; everything else is unit. All 63 tests of the previous JavaScript suite were ported case-for-case.

| File | Cases |
|---|---|
| `modules/auth/auth.routes.test.ts` (34, ported) | Login success/failure/validation, lockout, deactivation, anti-enumeration timing; register authN (no/garbage/forged/`alg:none` token), authZ matrix, validation (12 field cases), duplicates (case-insensitive), 20-way race → one 201, unknown school/parent → 422, argon2id storage, trimming |
| `modules/auth/auth.routes.refresh.test.ts` (25, ported) | Refresh issuance on login, rotation, chain of 3, current role in new token, every rejection path, deactivation, reuse → family revocation, 10-way concurrency → one winner |
| `modules/auth/auth.routes.rbac.test.ts` (9) | `/register` uses the shared guard: non-registrars get 403 **before** validation; registrars pass the guard; per-target business rules still apply |
| `modules/schools/schools.routes.test.ts` (64) | RBAC on all 4 endpoints (401 for none/garbage/forged/expired/refresh token; 403 for each of the 5 other roles with no side effects; guard runs before validation; deactivated or demoted Platform Admin → 401); create (shape, Location, trim, 200-char max, 8 invalid bodies, malformed JSON, 415); view (200, 404, invalid `schoolId`); rename (trim, `updatedAt` bump, 404, 5 invalid bodies, unchanged on failure); list (defaults vs DB order, disjoint pages adding up to the total, past-the-end page, limit cap, sort by name/createdAt/updatedAt asc+desc vs DB order, 6 non-allowlisted `sortBy` values, bad `sortOrder`/`page`/`limit`, unknown param, case-insensitive filter, no-match, literal `%`/`_`, blank filter, filter+sort+page combined); database failure → 500 with nothing leaked |
| `modules/schools/schools.repository.test.ts` (1) | Captures Prisma's SQL: the list query contains `ILIKE`, `ORDER BY "name" DESC`, `LIMIT` and `OFFSET`, and the count is filtered too |
| `modules/schools/schools.service.test.ts` (13) | Trimming, DTO mapping, typed 404s, error propagation, page → skip/take, defaults, pagination metadata table |
| `modules/schools/schools.schemas.test.ts` (53) | Query defaults/parsing, 10 bad `page`, 5 bad `limit`, arrays, 9 non-allowlisted `sortBy`, bad `sortOrder`, filter trimming/cap, unknown params, create/rename bodies, `schoolId` param |
| `shared/rbac/require-role.test.ts` (15) | Guard allows Platform Admin, 403 for each other role, 401 with no actor, multi-role guards, unknown role never admitted; roles match the DB enum; `/register` guard roles |
| `shared/rbac/route-access.test.ts` (7) | Startup check: guarded and public routes boot; undeclared, authenticate-only, or public+guard routes fail startup; non-`/api` routes ignored |
| `shared/errors/error-handler.test.ts` (10) | AppError → status/body, Zod issues → field paths, unknown keys, Prisma P2002 → 409 / P2025 → 404 / others → 500, no leaked internals, raw-query constraint extraction |
| `shared/openapi/register-api-docs.test.ts` (6) | `/docs` served; OpenAPI 3.1 with bearer scheme; auth endpoints still documented; each school endpoint has security, Platform Admin note, tags and its error responses; list query params incl. enums; `schoolId` path param and request bodies |
| `config.test.ts` (9) | Refresh-secret rules (ported); `JWT_ACCESS_SECRET` used; legacy `JWT_SECRET` accepted with a warning; both set → new one wins; neither → startup fails |

Mutation check: deliberately removing the guard from either route (the app now refuses to start), removing the public marker from login, making the guard allow every role, dropping LIKE escaping, ignoring `is_active` in authentication, sorting by the wrong column, an off-by-one in pagination, or removing the 404 each made the suite fail.
