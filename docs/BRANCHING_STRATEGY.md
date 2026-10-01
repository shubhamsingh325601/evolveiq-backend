# Branching Strategy

Simplified trunk-based flow — small team, fast MVP iteration, no long-lived
parallel release lines.

## Branches
- `main` — always deployable, protected. Every merge to `main` auto-deploys to **staging**.
- `feature/<scope>-<short-desc>` — new functionality, branched from `main`.
- `fix/<scope>-<short-desc>` — bug fixes, branched from `main`.
- `chore/<short-desc>` — tooling, config, deps, docs.

`<scope>` is one of: `auth`, `observations`, `activities`, `progress`, `schools`, `infra`.

Examples: `feature/observations-review-queue-filters`, `fix/progress-streak-calc`, `chore/infra-ci-lint`.

## Workflow
1. Branch from up-to-date `main`.
2. Commit using Conventional Commits (see NAMING_CONVENTIONS.md).
3. Open a PR into `main` — CI (lint, typecheck, test, Prisma migration check) must pass.
4. At least one review before merge.
5. Squash-merge to keep `main` history linear and one-commit-per-PR.
6. Delete the branch after merge.

## Migrations
- Every schema change ships as a Prisma migration in the same PR as the
  code that needs it — never a follow-up PR.
- No editing a migration that has already been merged to `main`; add a new
  one instead.

## Releases
- **Production** deploys are tagged from `main`: `v0.<mvp-milestone>.<patch>`
  (e.g. `v0.1.0` for first internal demo). No dedicated `release/*` branches
  during MVP — tag and deploy directly from `main` once it's stable enough.
- If a production hotfix is ever needed ahead of the next tag, branch
  `fix/<scope>-<desc>` from the last tag, PR into `main`, then re-tag.

## Why not GitFlow
No concurrent release lines or long-lived `develop` branch are needed at MVP
stage — that overhead slows iteration without buying anything here. Revisit
only if multiple releases must be supported in parallel post-MVP.
