# PB-SOCIAL-003A — Invite-only authentication and persistence foundation

This is **development-only source**, not a deployed database/application.

## Identity and access model

- **Supabase Auth** is the source of truth for customer user IDs.
- Organizations, memberships and clients reside in a separate `postbro_social` schema.
- Only administrator/service-side provisioning creates organizations, memberships
  or clients. A signed-in customer **cannot** join other organizations, create
  memberships, promote their role, change their package or approve personas.
- `authenticated` members may read client records for their organization;
  `owner` and `editor` may edit only brand fields and consent.
- `anon` has no grants. Row-Level Security (RLS) is enabled on all 3 tables.
- A client update invalidates previous approvals and advances the revision.
- The database serializes client inserts and enforces the **five-client pilot cap**.
- No service-role or secret key belongs in the client.

## Where to find it

- `migrations/001_social_foundation.sql`: isolated schema and security rules.
- `src/security/supabase-auth.ts`: server-side Auth `GET /auth/v1/user`
  identity verifier. Only verified `auth.users.id` is returned.
- `tests/auth-boundary.test.ts`: mocked Auth verification tests.
- `tests/rls-pg17.test.mjs`: local PostgreSQL 17.11 RLS, grants, tenant isolation,
  persona-reset and five-client concurrency test.

**Do not move the migration into root `db/migrations`.** That directory is
automatically consumed by the current production PostBro migration runner. This
Social SQL needs a *separate* rollout once reviewed.

## How customers will log in (next task, NOT implemented yet)

1. An administrator provisions a Supabase Auth user by invitation and inserts
   the matching immutable user ID into `postbro_social.memberships`.
2. Customer signs in with email OTP. `signInWithOtp` must use
   `shouldCreateUser: false`; self-registration remains disabled.
3. The API verifies the Bearer token using Supabase Auth, not by decoding an
   unverified JWT or using user-supplied `organizationId`.
4. Data access uses the signed-in JWT and RLS with the `postbro_social` schema.
   No shared service-role client is used for ordinary tenant queries.

The API schema is **not exposed by this PR**. Connecting PostgREST requires
configuring the new schema in the Supabase Data API exposed-schemas setting,
then performing a separate permission/RLS review and smoke test.

## Validation

The existing GitHub CI job `postgres-17-11-deployment-rehearsal` provisions a
**disposable local PostgreSQL 17.11** database. It executes the SQL there with
a **test-only auth.uid fixture**, never against the hosted Supabase project.

```sh
npm run lint
npm run typecheck
npm test
# Only on a disposable PG17 host:
POSTGRES_17_11_URL='postgres://postgres:postgres@127.0.0.1:5432/postgres' \
  node --test apps/social-web/tests/rls-pg17.test.mjs
```

This is not proof that the cloud project is deployed or exposed. A real client
email OTP flow, secure API sessions, production provisioning workflow,
idempotent persona approval and UI/data integration remain blocked until
the owner approves a staging rollout.
