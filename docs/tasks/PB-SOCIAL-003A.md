# PB-SOCIAL-003A — Client authentication and tenant-scoped persistence foundation

**Scope:** Add an opt-in, non-deployed Supabase Auth/RLS storage foundation for PostBro Social. This phase provides the secure database and identity contract, **not** a production-ready client login website.

## Requirements and existing constraints

- Existing engagement service and deployed database migrations remain unchanged.
- Reuse **Supabase Auth identity**, not the operator/Threads OAuth identity or a local test login.
- Organizations are provisioned by the agency; memberships bind immutable Supabase Auth `auth.users.id`.
- No self-registration, organization self-enrollment or user-editable authorization metadata.
- Five paying clients across the pilot. Enforcement must be concurrency-safe in the database.
- Clients may read only their organization. Only member roles `owner` or `editor` may update ordinary brand fields/consent.
- No authenticated user may write their own membership, organization ownership, plan, status or persona approval fields.
- Any change of brand or consent invalidates previously approved persona.
- Legacy engagement-owned PostBro tables and Postiz remain separate.

## Deliverables

1. **Isolated SQL migration** under `apps/social-web/migrations/`, intentionally outside root `db/migrations/`. This prevents production's automatic migration runner from applying it before approval.
2. Supabase Auth verification helper with fail-closed token handling, request timeouts and server-only, allowlisted project URL.
3. Read-only authenticated API adapter contract for future tenant-scoped routes; no production route registration.
4. Automated tests of migration isolation, role privilege restrictions, cross-tenant reads/updates, five-client cap and persona reset.
5. Minimal operator runbook for client invitation and future login integration; no real emails, invites or account writes.

## Database authorization

- Use schema `postbro_social`, **not exposed in Data API by default**.
- Membership RLS permits a user to see only their own membership.
- Organizations and clients have RLS policies depending on membership.
- No grant to `anon`. `authenticated` receives narrow SELECT and brand-only UPDATE rights.
- A trusted administrator/service process must provision organizations, memberships and clients; app users cannot insert themselves.
- Database data API exposure and privileges require **separate owner-authorized rollout**. Never expose a service_role/secret key to browsers.
- RLS policies must use `auth.uid()`, not untrusted user_metadata or a caller-supplied organization identifier.

## Acceptance / verification

- CLI tests use a **disposable PostgreSQL 17.11** database plus a test-only Supabase `auth.uid()` fixture; never the hosted project.
- Run all existing PostBro lint/typecheck/tests and PostgreSQL rehearsal, plus the new Social RLS tests.
- Assert fail-closed unauthenticated access, no unauthorized writes, cross-tenant non-access, and monotonic persona revisions.
- No actual login/session, public endpoint, provider fetch, Postiz call, production migration or deployment.
- Review branch and PR before merging; merging source does **not** approve any future production migration.

## Next tasks (not part of this PR)

- **PB-SOCIAL-003B:** Invite-only, passwordless client login with authenticated API sessions and persistent onboarding endpoints. Requires a safely configured Supabase project/publishable key and test users.
- **PB-SOCIAL-004:** Real private Persona Engine integration with client approval.
- **PB-SOCIAL-005:** Postiz organization mapping and approval-before-scheduling workflow.
