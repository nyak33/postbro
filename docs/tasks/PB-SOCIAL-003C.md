# PB-SOCIAL-003C — PostBro Social single-project pre-launch setup

**Decision updated 22 November 2026:** The owner explicitly chose to **skip
separate staging while Social is not yet operational**. Reuse the existing
Contabo VPS and active Supabase `postbro-core` project for Social's first
testing environment. Independent staging can be added later, once Social has
working client operations.

## Objective

Prepare a separate Social service and a careful **shared-project** testing
plan without changing running PostBro engagement or Postiz. Do not install
a local multi-container Supabase stack.

## Existing evidence

- Read-only Supabase metadata check (22 Nov 2026): `postbro-core` active on
  PostgreSQL 17.11, `postbro` schema exists, `postbro_social` absent.
- Prior Contabo audit: 8 CPU cores, ~24GB RAM, no swap, high current load;
  full local Supabase stack is unsuitable for that host.
- PR #27 provided an isolated Fastify portal and Auth/RLS store, but nothing
  was deployed or migrated.

## Implementation (THIS PR ONLY)

1. Retain the separate loopback listener (default 127.0.0.1:3201),
   distinct from running PostBro port 3000 and Postiz.
2. Rename temporary *staging* configs/runbook to *prelaunch* so no second
   project is required. Use explicit `SOCIAL_PRELAUNCH_*` env variables,
   with no fallback to root PostBro credentials.
3. Validate that DB and Auth refer to **the same** project and require
   `SOCIAL_PRELAUNCH_SHARED_PROJECT_CONFIRM=postbro-core`.
4. Include the existing `postbro-core` project reference in the
   placeholder-only example. No secrets are copied into Git.
5. Provide runbook for independently reviewing/verifying the Social SQL,
   secure backup/restore and shared Auth settings before any hosted changes.
6. Test configuration and isolated app behavior; run root lint, typecheck,
   unit tests and disposable PostgreSQL security rehearsal.
7. Keep `apps/social-web/migrations/001_social_foundation.sql` **out of**
   the running PostBro migration runner.

## Explicit exclusions — not authorized

- No hosted SQL statements, schema migrations, live user provisioning or
  account invitations.
- No new Supabase project or paid plan, no full local Supabase Docker stack.
- No Postiz/Threads production service edits/restarts or scheduled-post changes.
- No Cloudflare/DNS/firewall changes, no Social service deployment, no public
  login endpoint or real OTP email.
- No changes to project-wide email templates, Auth policies or SMTP settings
  without a separate impact review and owner approval.
- No unreviewed account data migration or destructive SQL.

## Gate before first real test deployment

Owner approval for exact target database and migration after a tested
backup/restore strategy, then service start in an isolated checkout.
A separately reviewed browser test must prove invitation-only sign-in,
tenant RLS isolation, allowed updates and no effect on Postiz/Threads.

## Success criteria

- PR's code and docs match the **one shared Supabase project** decision.
- Explicit acknowledgement guards shared-project operation.
- Invalid credentials/project mismatches/public bind/port 3000 rejected.
- PostBro codebase, Social test suite and disposable PG17 rehearsal pass.
- Existing services and hosted Supabase remain untouched this turn.
