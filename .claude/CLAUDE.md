# EvolvIQ Backend — Project Instructions

Read these before working in this repo, in this order:
1. `docs/ARCHITECTURE.md` — stack, module layout, domain model, access rules
2. `docs/SCOPE_OF_WORK.md` — what's in/out of scope for the MVP, by domain
3. `docs/NAMING_CONVENTIONS.md`
4. `docs/BRANCHING_STRATEGY.md`
5. `docs/PROGRESS_TRACKER.md` — update this when a tracked item's status changes

## Non-negotiables
- RBAC is enforced at the route layer via `shared/rbac` middleware — every
  new route must declare its allowed roles explicitly, never rely on the
  frontend to hide a screen.
- Parent-facing serializers must exclude clinical scores and psychologist
  notes at the API layer — this cannot be a frontend-only filter.
- Growth areas are hard-capped at 5 per student — enforce in the service
  layer, not just displayed as a UI limit.
- Schema changes ship as a Prisma migration in the same PR as the code that
  needs them.
- Don't build anything listed under "Explicitly out of scope" in
  docs/SCOPE_OF_WORK.md (analytics endpoints, audit log, chat, CSV import,
  etc.) unless the user explicitly asks for it.

## When making changes
- Follow docs/NAMING_CONVENTIONS.md for files, routes, DB naming, branches, and commits.
- Update docs/PROGRESS_TRACKER.md when you complete a tracked item.
- Routes stay thin — business rules belong in `*.service.ts`, DB access in `*.repository.ts`.
