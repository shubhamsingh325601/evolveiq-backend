# Naming Conventions — Backend

## Files & folders
- Modules grouped by domain under `src/modules/<domain>/` (see ARCHITECTURE.md)
- Files: `kebab-case.ts` — `<name>.routes.ts`, `<name>.service.ts`, `<name>.repository.ts`
- Test files: colocated, `<name>.test.ts`

## Code
- Classes, types, interfaces, Zod schema exports: `PascalCase` (e.g. `CreateObservationSchema`)
- Variables, functions: `camelCase`
- Constants (module-level, immutable): `UPPER_SNAKE_CASE`
- Booleans read as a question: `isReviewed`, `hasClinicalAccess`

## API routes
- Versioned: `/api/v1/...`
- Path segments: `kebab-case`, plural nouns for collections:
  `/api/v1/observations`, `/api/v1/activity-completions`
- Route params: `camelCase` (e.g. `:observationId`)
- Actions that aren't pure CRUD are verbs on a sub-path:
  `POST /api/v1/observations/:observationId/review`

## Database (Prisma / Postgres)
- Table names: `snake_case`, plural — `observations`, `activity_completions`
- Column names: `snake_case` — `created_at`, `reviewed_by_id`
- Prisma model names: `PascalCase` singular (Prisma maps to the snake_case table via `@@map`)
- Foreign keys: `<singular_entity>_id` — `student_id`, `reviewed_by_id`

## Git
- Branches: see BRANCHING_STRATEGY.md
- Commits: [Conventional Commits](https://www.conventionalcommits.org/) —
  `feat(observations): add significant-level filter to review queue`,
  `fix(progress): correct streak off-by-one`,
  `chore(infra): add prisma migration check to ci`
  Allowed types: `feat`, `fix`, `chore`, `refactor`, `test`, `docs`.
  Scope matches the branch `<scope>` list in BRANCHING_STRATEGY.md.

## Environment variables
- `UPPER_SNAKE_CASE`: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`
