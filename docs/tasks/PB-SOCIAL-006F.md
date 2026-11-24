# PB-SOCIAL-006F — shared identity consent and pilot deployment

Status: draft code only. No hosted Auth changes, DNS changes, migrations, social writes, or deployment.

## Purpose
Serve the OAuth server authorization UI at the shared PostBro Social origin,
using the same Supabase Auth project for Postiz and PostBro. A pilot user
enters an existing invited account's email code once; the shared consent UI
can reuse its short-lived session for both apps. First authorization of each
client requires consent. Existing Postiz local login remains unchanged.

## Safety
- Consent is off by default. Pilot email allowlist and exact OAuth client
  IDs and callback paths are configured by the operator. No self-registration.
- Only the shared UI may approve/deny a request; the user's session and
  provider response are verified and browser requests require the expected Origin.
- Session tokens are server memory only, indexed by random opaque host-only
  HttpOnly cookies. Sessions are bounded, expire within 30 minutes, and reset
  on process restart. No refresh token stored. The single-process design is
  intentional for the prelaunch pilot, not a multi-instance session store.
- Do not log authorization URLs, query strings, response bodies or secrets.
- Supabase may automatically redirect for previously consented clients; only
  configured exact HTTPS callback destinations are accepted.
- The new route is not evidence of valid SMTP, Auth configuration or actual SSO.

## Rollout order
1. Review/merge the prerequisite SSO code and this stacked PR; run CI.
2. Prepare isolated PostBro Social service on loopback port 3201, only if
   verified available; reuse existing VPS and existing postbro-core project.
3. Verify the proposed HTTPS hostname social.syaqirshaq.online can be
   provisioned without replacing any existing production hostname or route.
4. Deploy the application with SSO and consent disabled. Verify /social/health
   over HTTPS (process liveness only). Confirm legacy services still respond.
5. Review the shared project's current Site URL and signing algorithm.
   OIDC with the openid scope requires asymmetric signing. Never rotate or
   change signing keys without a separate compatibility audit and approval.
6. Set Site URL to the verified HTTPS origin and authorization path to
   /oauth/consent, enable OAuth server, leave dynamic OAuth registration off.
   This changes a shared project; explicitly approve first.
7. Register exactly two confidential OAuth clients (client_secret_basic):
   Postiz Staging → https://postiz-staging.syaqirshaq.online/settings;
   PostBro Social → https://social.syaqirshaq.online/api/social/sso/callback.
   Keep client secrets off chat and out of logs; provision protected env.
8. Configure the allowlisted client IDs/callbacks and invited pilot email,
   enable consent and SSO, then verify /oauth/consent returns 200.
9. Test existing invite OTP delivery (verify template contains OTP), explicit
   approve/deny, returning consent, Postiz login then PostBro button, correct
   PostBro tenant, no cross-tenant data, expiry and local logout. Test a second
   pilot identity. Verify Postiz organization binding independently.
10. Only after verified end-to-end success consider production Postiz rollout.

Supabase docs: https://supabase.com/docs/guides/auth/oauth-server/getting-started
Supabase Auth API source: https://github.com/supabase/auth/blob/master/internal/api/oauthserver/authorize.go
