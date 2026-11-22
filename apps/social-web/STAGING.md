# PostBro Social — staging preparation (PB-SOCIAL-003C)

**Code prepared, NOT deployed.** PR #27 merged the standalone Social portal; this
task only provides a **separate** local-only launcher, strict staging-specific
configuration and automated validation.

## Why a separate project

Read-only inspection on 22 November 2026 found two active connected Supabase
projects named "Hermes Threads Media" and "postbro-core", plus two older
inactive projects. None is designated or approved for Social staging.
**Do not modify or reuse any of them by assumption.**

For the first functional login test, choose a distinct Supabase staging
project with its own Auth users, SMTP configuration and PostgreSQL tables.
This could have billing/project-limit implications: check your Supabase plan
and confirm the total expected cost before creating anything.

## Prerequisites — not performed

1. **Select and approve** a staging Supabase project ref. Review the intended
   region, costs, project limits, auth/SMTP settings and backups.
2. **Review and explicitly authorize** running
   `apps/social-web/migrations/001_social_foundation.sql` in that project's
   empty staging DB. This SQL is deliberately outside production migrations.
3. Confirm the email template includes the numeric `{{ .Token }}` variable,
   not only a Magic Link; configure email verification expiry/rate limits
   and a trusted SMTP sender. No real email is sent by the preparation step.
4. Provision a test user in Supabase Auth, a test organization/membership and
   one test client row. Do not enable self-registration for agency clients.
5. Verify the DB login is allowed to `SET LOCAL ROLE authenticated`,
   that PostgreSQL TLS verifies the server certificate, and that the RLS tests
   prevent reads/writes across tenants. Prefer a dedicated least-privilege
   DB login for staging instead of a project owner credential.
6. Choose a **different** loopback port to avoid conflict with live services.
   Default is 3201; verify the listener is free before starting.
7. Never run test migrations or use credentials against the live
   `postbro-core` project without separate authorization.

## Source files

- `src/staging/config.ts`: requires the **same Supabase project ref** in Auth
  and DB endpoints; rejects unsafe URLs, missing config, weak/secret keys,
  external binds, privilege-port collisions and silent fallbacks.
- `src/staging/server.ts`: opt-in Node staging process; loopback only,
  independent of root Threads backend, no auto-deploy or auto-migration.
- `staging.env.example`: variable NAMES and placeholders only, no secrets.
- `tests/staging-config.test.ts`: config failure/success cases and defaults.

## Build and run manually — after project/migration approval

This is an **example**, not a command already executed.

```sh
# In a scratch/staging checkout, not the production checkout.
cd /path/to/postbro
npm ci
./node_modules/.bin/tsc -p apps/social-web/tsconfig.json

# Supply the seven SOCIAL_STAGING_* vars from a PRIVATE env file readable
# by the staging process account, not from Git or chat.
# For a manually reviewed local test:
set -a
. /private/path/social-staging.env
set +a
node apps/social-web/dist/src/staging/server.js

# From another shell on the VPS (process liveness only):
curl -fsS http://127.0.0.1:3201/social/health
```

If remote access to the login page is needed before a reviewed Cloudflare route,
use an authenticated SSH port forward from the owner's machine, for example:

```sh
ssh -N -L 3201:127.0.0.1:3201 postbroadmin@YOUR_VPS_HOST
# Then open http://127.0.0.1:3201/social/ locally.
```

The /social/health endpoint says *process configured only*. It is **not**
evidence of database connectivity, email delivery or valid memberships.
No public tunnel, domain, port-forward rule, systemd service or Cloudflare
configuration is created by this PR.

## Staging acceptance sequence

1. Start the isolated process; /social/ and /social/health respond on loopback.
2. Unauthorized API requests return 401 without opening a DB connection.
3. A pre-invited owner receives an email code, signs in and sees only
   their own agency-provisioned client row.
4. An uninvited address cannot create an Auth account.
5. A viewer cannot edit; an owner/editor may edit brand and consent.
6. A second tenant never sees the first tenant's information.
7. Changing brand/consent invalidates any previously approved persona.
8. Attempt to exceed five-client pilot cap fails transactionally.
9. Reloading the browser discards the in-memory token; browser storage is empty.
10. Existing PostBro /health and Postiz scheduled posts remain unchanged.

## Rollback / failure handling

Stop only the Social staging process. The root Threads backend and Postiz do
not depend on it. If test migration fails, **do not run DROP statements or
manual destructive recovery against a shared database**. Recreate a disposable
staging project/DB only after explicit approval, or restore its snapshot.

## Status / limitations

Done in repository source: explicit isolated startup, configuration guard,
tests and rollout guide. Not done: dedicated hosted staging project, SQL
migration, DNS/tunnel service, SMTP, invitations, client provisioning and
real browser/OTP tests. None of those can be inferred from a green CI run.
