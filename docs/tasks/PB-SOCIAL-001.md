# PB-SOCIAL-001 — Social onboarding foundation in public PostBro monorepo

**Owner authorization:** 2026-11-22: keep `nyak33/postbro` public; begin integrating Social modules in the existing repository.

## Objective

Prepare an additive, non-deployed Social onboarding module while keeping the running
Threads engagement backend and separate Postiz instance unchanged.

## Product boundary

- PostBro Social: client onboarding, persona approval, AI content preparation and reporting.
- Existing PostBro engagement: Threads interaction automation (current PRD unchanged).
- Postiz: social connections, independent client self-posting, scheduling and publishing.
- Persona Engine: existing **private** project; consume through an adapter only. No copying
  private implementation into this public repository without a separate explicit review.

## This change

- `apps/social-web` holds a minimal TypeScript onboarding domain with tests.
- Scope to the authenticated organization in a future server integration. Current code
  intentionally has no public routes or demo credentials.
- Support 5-client pilot cap, two plans, brand intake, optional historical analysis consent,
  versioned review and explicit persona approval.
- Keep history fetching unavailable until verified Meta scopes and a client opt-in.
- Do not change root `package.json`, lockfile, CI, migrations or production paths in this
  first additive step; full npm-workspaces migration is a later reviewed change.

## Acceptance

1. Cross-tenant reads and writes fail.
2. Sixth client creation fails.
3. Mock personas cannot activate.
4. Edited draft invalidates approval and stale revision is rejected.
5. Previous-post analysis is off until opted in; opting in does not fetch by itself.
6. Root backend production files untouched; no deployment.

## Deferred

Actual existing UI import, durable database and RLS, authenticated login, Persona Engine
runtime adapter, Postiz organization mapping, Meta historical post retrieval, image generation,
client approval portal and scheduling integration.
