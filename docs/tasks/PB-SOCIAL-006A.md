# PB-SOCIAL-006A: Shared login and Postiz → PostBro navigation contract

Status: DESIGN / REVIEW ONLY. No deployed auth, database migration, OAuth client, secrets, or production changes.

## Objective and pilot acceptance

A client signs in once to our Postiz and clicks **PostBro Social** in the Postiz sidebar. PostBro recognizes the same authenticated person, maps them to the correct authorized client workspace, and opens the appropriate dashboard without asking for a second password or email OTP. A first-time OAuth consent or account-linking step is allowed; it is **not** equivalent to a second credential login.

Pilot: Postiz staging; QA account `@post_bro33`; no scheduling/publishing.

## Source-code reality

- Postiz fork `nyak33/postbro-postiz`: local email/password and generic OAuth login coexist. The generic OAuth provider (`apps/backend/src/services/auth/providers/oauth.provider.ts`) uses authorization code but **does not currently send PKCE code_challenge or code_verifier**; it expects a fixed redirect URI `${FRONTEND_URL}/settings`. Do not flip its configuration to Supabase OAuth 2.1 without updating and testing the flow.
- Postiz's `/oauth/authorize` + `/oauth/token` APIs provide access delegation for Postiz integrations. Do **not** mistake them for a ready-to-use cross-application identity SSO system. Its `/oauth/userinfo` has specific scope/feature gates.
- PostBro Social (`apps/social-web/src/security/supabase-auth.ts`) verifies a Supabase Auth bearer token with `GET /auth/v1/user`; the current OTP client (`public/portal.mjs`) stores tokens only in memory. There is no shared browser login handoff yet.
- PostBro Social membership model uses verified `auth.users.id`, `postbro_social.memberships`, and tenant RLS. Keep this; do not start trusting Postiz user IDs or organization IDs supplied in browser parameters.
- Current Postiz side navigation uses `apps/frontend/src/components/layout/top.menu.tsx` and `apps/frontend/src/components/new-layout/menu-item.tsx`; the latter already supports external links.

## Approved architecture to implement *after* this design review

1. Use **Supabase Auth as the identity provider**, with a dedicated staging OAuth 2.1 client registered for the Postiz staging application.
2. Build/enable the Supabase authorization UI, including clear grant/deny consent and preserving `authorization_id` across sign-in. Check current official Supabase OAuth server docs and the enabled project's capabilities, because the OAuth server is in beta.
3. Patch the Postiz generic OAuth client to support authorization code + **PKCE S256**: cryptographically secure verifier, corresponding challenge, unpredictable state, short-lived server-side correlation, strict redirect URI and issuer handling, single-use code exchange, no secrets in query strings or browser storage. Use the provider's supported token endpoint auth method and identity claims.
4. Postiz validates the identity provider and creates its **own scoped application session**. PostBro uses an independently validated Supabase Auth session. Do not share Postiz's `auth` cookie, local password, or signed JWT with PostBro. Cross-origin navigation triggers a standard IdP authorization redirect and returns with a fresh session when the IdP already has an authenticated browser session.
5. A **PostBro Social** button on Postiz's first menu opens an allowlisted HTTPS PostBro destination. Render it only when enabled by staging configuration; use an ordinary navigation URL, no token or organization ID in its query string. A dashboard route verifies the PostBro session itself.
6. Maintain trusted mapping `(supabase_auth_user_id, postiz_instance_id, postiz_org_id, postbro_org_id, role, status)`. Link only after independently proving membership/control in BOTH systems, not by matching email or accepting query-string org IDs. Mapping must be unique, revocable and tenant-scoped. Enforce access to channel IDs through server-side org checks.
7. New users: one shared identity; provision a separate Postiz organization for each customer. Existing Postiz LOCAL users: **do not overwrite or auto-merge**. Use explicit, verified account linking, preserve connected channels, drafts, schedules and membership roles; keep rollback and unlinked fallback. Existing PostBro Supabase users retain their immutable IDs.
8. Use feature flags to roll out only to pilot testers. Production remains on existing authentication until a separate rollout approval.

## Incremental PR sequence

- **006A (this PR):** read-only architecture and security contract.
- **006B (Postiz fork, staging only):** PKCE/OIDC-compatible generic login foundation and tests; default disabled.
- **006C (PostBro):** consent + authenticated session handoff, no login bypass, tests.
- **006D (both):** trusted one-to-one organization-link handshake and tenant checks, tests.
- **006E (Postiz fork):** configurable sidebar button and optional return navigation, disabled by default.
- **006F:** staging E2E verification, existing-account migration rehearsal, explicit production go/no-go.

## Security and regression gates

- No Postiz password, API key, OAuth access token or Supabase service-role token in URLs, browser storage, commits, app logs or screenshots.
- PKCE S256, state, redirect URI, issuer and code replay validation; invalid/expired callbacks denied.
- A fresh PostBro session must be validated by PostBro; a Postiz cookie alone is never sufficient.
- User A cannot access User B's tenant, organization, channels, posts, approvals or personas by editing any IDs.
- Organization switching requires re-verification; disable/revoke/unlink removes access.
- Login, registration, invited users, password reset, existing local Postiz login, OTP fallback, existing posts and schedules must regress successfully.
- New OAuth registration and Supabase authorization-path configuration are prerequisites, not accomplished by this PR. Keep staging and production IdP clients/redirect URIs separate.
- Staging test stops at safe account mapping and draft-only read/write only when separately approved. No automatic publishing.

## Open provisioning decisions

1. Confirm the Supabase project to serve as **staging IdP** and whether OAuth 2.1 server is enabled; never use a production account as the staging test identity by default.
2. Confirm staging PostBro HTTPS origin; configure exact allowed redirect URLs (no wildcard).
3. Decide whether Postiz's built-in LOCAL login stays as admin emergency fallback (recommended for pilot).
4. Verify account-linking migration with an existing Postiz user before enabling new customer signup.

## Documentation basis

- Supabase OAuth server: https://supabase.com/docs/guides/auth/oauth-server
- OAuth flow and PKCE: https://supabase.com/docs/guides/auth/oauth-server/oauth-flows
- OAuth server setup: https://supabase.com/docs/guides/auth/oauth-server/getting-started
- Postiz source inspected in `nyak33/postbro-postiz` (main) on 2026-11-24.
