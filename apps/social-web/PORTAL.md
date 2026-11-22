# PostBro Social — PB-SOCIAL-003B portal integration

**Development-only source. No live database migration or deployment.**

## Implemented

- Standalone responsive portal at /social/ and API routes under /api/social/.
- Invite-only email OTP via Supabase Auth. The browser requests a code with
  create_user: false, then verifies with type: email.
- Access token held in memory, not cookies, localStorage or sessionStorage.
  No refresh token is retained. Reloading ends the browser session.
- Each API call verifies the token using the fixed Supabase Auth /auth/v1/user
  endpoint. The server uses the returned immutable user ID only.
- PostgreSQL tenant transactions impersonate the authenticated role and set
  request.jwt.claim.sub from the verified ID, enforcing database RLS.
- Pre-provisioned client profiles may be viewed, brand fields edited and
  optional historical-analysis consent recorded. Database roles restrict edits.
- No customer self-registration, membership creation, package modification,
  persona approval, historical import, or publishing.

## Pre-launch prerequisites (not yet authorized)

1. Select a specific isolated Supabase project and explicitly approve the
   existing standalone SQL migration in apps/social-web/migrations/.
2. Configure a verified email sender, appropriate OTP expiry/rate limits and
   a template with {{.Token}}. Default Supabase emails may contain a magic
   link instead of the numeric code expected by this interface.
3. Agency administrator provisions invitees and organization memberships.
   Do not expose self-registration or let end users change their roles.
4. Supply a server-only Postgres pool with rights to SET LOCAL ROLE
   authenticated; do not expose DB connection credentials to browser code.
5. Serve behind HTTPS with proper routing. Verify real email delivery,
   sign-in, owner/viewer permissions, two-tenant isolation and backups.
6. Review session expiry and logout: current Sign out clears only this tab's
   memory. It does NOT revoke remote tokens; no refresh token is retained.
7. Do not expose the private postbro_social schema via Supabase Data API
   without an additional access-control review and explicit approval.

## Code and tests

- src/http/portal.ts: separate Fastify app and private-data API.
- src/http/tenant-store.ts: RLS queries and column-restricted updates.
- public/portal.html and public/portal.mjs: login and onboarding UI.
- tests/portal-api.test.ts: mocked Auth and database tests.
- tests/portal-browser.test.mjs: login/browser privacy contract.
- Existing SQL test verifies RLS on a disposable PostgreSQL 17.11 instance.

The current production Threads backend does not import, register or run
this portal. No real emails, account invitations, live Supabase changes or
server restarts occurred in this development task.
