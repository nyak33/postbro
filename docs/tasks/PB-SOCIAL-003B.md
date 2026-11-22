# PB-SOCIAL-003B — Invite-only login and persistent onboarding API (undeployed)

**Owner direction:** 2026-11-22 "go" to continue immediately after approval/review/merge of PR #26. This builds source and tests, not production.

## Objective

Provide a minimal, working **code-level** connection between an invite-only Supabase Auth email-OTP portal, verified user identity and the tenant-scoped PostgreSQL schema from PB-SOCIAL-003A. Preserve the existing local design preview.

## Scope / architecture

- Add an **isolated Fastify portal app** under `apps/social-web/src/http/`, **not** imported from the production Threads `src/app.ts` or `src/index.ts`.
- A public configuration endpoint exposes **only** the Supabase URL and publishable key. No database credentials or service-role key.
- A separate login page uses email OTP. It requests OTP with `create_user: false` (invite-only) and verifies using type `email`; client sessions stay in **memory**. Closing/reloading the tab signs out; token expiry requires signing in again. Do not store tokens in localStorage/cookies.
- Agency must pre-provision the `auth.users` user, `postbro_social.organizations`, membership and client row. No user-driven registration or organization creation.
- Each API request verifies the Bearer token against the official Supabase Auth `/auth/v1/user` endpoint. The user ID comes **only** from that response.
- PostgreSQL queries must execute within an authenticated-role transaction: `SET LOCAL ROLE authenticated`, then bind `request.jwt.claim.sub` from the verified UUID. This enforces the existing DB RLS for reads and edits; **never** query data with unrestricted application privileges.
- Support: list the user's clients, read an individual client, update brand intake, record optional history-analysis decision. The server never generates/approves personas or schedules posts.
- Use parameterized SQL and fixed SQL column names, strict ID and field validation. Update only columns granted to `authenticated`.
- Keep portal resources same-origin, with conservative security headers, no external JS/CSS dependencies and no runtime registration in production.
- For this MVP, there is no long-lived login session, password reset, client invitation provisioning workflow or Meta historical read. Product features remain behind separate reviewed rollout gates.

## Security and acceptance

- Missing/invalid/expired token => 401. No client-specific authorization from a request-supplied organizationId.
- Cross-organization IDs and viewer update attempts => 404 (RLS hides rows).
- Separate Supabase Auth identity verification and RLS role-switching tested. No service_role keys in browser.
- Temporary Supabase/provider failure => fail closed, never return another client's data.
- Root PostBro lint/typecheck/test and PostgreSQL rehearsal continue to pass. Social tests pass.
- No cloud database changes, no real OTP emails, no invitations, no production deployment, and no migration execution.
- Keep PR as draft for explicit owner review, unless separately directed to merge.

## Deployment prerequisites (NOT yet authorized)

Dedicated or approved isolated Supabase project, confirmed email template containing `{{.Token}}` (email OTP, not magic-link-only), configured authentication SMTP/rate limits, a staging HTTPS origin, explicit schema migration approval, least-privilege database role capable of impersonating authenticated RLS (or separate dedicated login strategy), test member/client provisioning and browser smoke tests.
