# PostBro Social — First Deployment / Pre-launch Testing (PB-SOCIAL-003C)

**Decision (22 November 2026):** There is **no separate staging environment** for the
initial PostBro Social build. We will test the future first deployment before
inviting paying clients. Separate staging can be introduced once the Social
product is operational.

## Agreed layout

| Component | Pre-launch plan |
| --- | --- |
| Host | Reuse existing Contabo VPS; no extra Supabase Docker stack |
| Social backend | Dedicated Node/Fastify process on **127.0.0.1:3201**, isolated from existing PostBro API on 3000 |
| PostgreSQL | Reuse existing active Supabase project `postbro-core` (ref: `nqjlgalyjxifzisitzfa`) |
| Social tables | New `postbro_social` schema, with per-client membership policies and RLS |
| Auth | Reuse this project's Supabase Auth; invite-only Social accounts, explicitly provisioned memberships |
| Postiz | No code, service, schedule or database changes |
| Public access | Not enabled until the Social login, authorization and reverse-proxy safeguards are verified |
| Dedicated staging | Defer until after first operational release |

This is **logical isolation within a shared database and shared Auth project**, not
the same fault isolation as a separate database/project. Database migrations,
project-wide email template/Auth settings, quota use and provider outages can
affect existing users. The application process, host listener and configuration
must still be kept separate from production Threads engagement.

**Verified in read-only Supabase inspection on 22 November 2026:**
`postbro-core` is active on PostgreSQL 17.11; existing `postbro` schema
exists; `postbro_social` does **not** exist yet.

## Before the first hosted schema change — mandatory gate

1. Explicitly authorize **the exact** `apps/social-web/migrations/001_social_foundation.sql`
   DDL against `postbro-core`, after a separate security review.
2. Verify and record a viable backup/export **and restore plan** for existing
   `postbro-core` data. Do not assume that a Free project has a usable PITR
   or an automatic backup. No destructive rollback on the shared DB.
3. Confirm the SQL only creates `postbro_social` objects, references
   `auth.users` for memberships and does **not** modify current `postbro`
   tables, `auth` functions or the existing production migration ledger.
4. Recheck the schema absence and metadata immediately before the migration.
   Stop on unexpected existing objects or grants. Do not blindly rerun DDL.
5. Keep `postbro_social` OUT of Supabase Data API exposed schemas unless a
   future reviewed requirement explicitly needs it. RLS and grants protect
   the tables, but broad Data API exposure is unnecessary here.
6. Provision test users, memberships and a client only **after** the schema
   passes an approval and backup gate. No customer invitations or real emails
   have been sent as part of this preparation.

## Shared Supabase Auth caution

Social uses email OTP with `create_user: false`, so the UI cannot self-register
a new customer. However **email templates, SMTP and some Auth policies are
project-wide**. Do not change `postbro-core` project-wide Auth settings
blindly: first audit whether existing services use Supabase Auth and confirm
the impact, then specifically authorize any change required for numerical
email codes. Keep real client login and emails disabled until checked.

The HTTP server verifies the user via Supabase Auth and runs tenant queries as
the `authenticated` role under RLS. All private database credentials stay on
the server. Longer term, use a dedicated limited-privilege DB login rather
than relying on project-owner credentials.

## What PR #28 provides

- `src/prelaunch/config.ts`: validates a single explicit Supabase project,
  matching Auth/DB endpoints, SSL/TLS and separate loopback port. Requires
  `SOCIAL_PRELAUNCH_SHARED_PROJECT_CONFIRM=postbro-core` as an
  intentional acknowledgment of the shared cloud environment.
- `src/prelaunch/server.ts`: opt-in launcher. It does **not** import the
  existing root Threads server or run migrations.
- `prelaunch.env.example`: public placeholders and variable names.
- `tests/prelaunch-config.test.ts`: config checks, Auth failure and
  localhost health smoke.
- `package.json`: `start:prelaunch` script only. Nothing starts
  automatically when merging.

The server's `/social/health` indicates **process-only** readiness, not
successful Supabase connectivity or actual Auth/SMTP onboarding.

## Manual launch sequence — NOT executed

These commands are for a future explicitly approved deployment. The Social
schema must exist and the test credentials must be provisioned first.

```sh
# Use a separate scratch/launch checkout; do not overwrite the running
# /home/postbroadmin/postbro-threads-engagement production checkout.
cd /path/to/separate/postbro-checkout
npm ci
./node_modules/.bin/tsc -p apps/social-web/tsconfig.json

# Read the secure prelaunch env privately from the VPS, never paste secrets.
set -a
. /private/path/social-prelaunch.env
set +a

# In a terminal or separately approved isolated process supervisor:
node apps/social-web/dist/src/prelaunch/server.js

# Process-only check from VPS. This does not prove database connectivity.
curl -fsS http://127.0.0.1:3201/social/health
```

For a private owner-only browser trial, use SSH forwarding rather than a
public Cloudflare route:

```sh
ssh -N -L 3201:127.0.0.1:3201 postbroadmin@YOUR_VPS_HOST
# Open http://127.0.0.1:3201/social/ on your local machine.
```

A later public HTTPS hostname, Cloudflare tunnel ingress, systemd unit, DNS
change or externally accessible account requires separate explicit approval.
Do not start this app automatically merely because its code is on `main`.

## Acceptance before launch

- Existing PostBro `/health` and Postiz running/scheduled posts unchanged.
- Schema exists in `postbro-core` without any modifications to existing
  `postbro` tables; verified restore procedure recorded.
- No anonymous data access; cross-organization users cannot see each other.
- Pre-invited owner can log in using supported email flow; an uninvited
  email cannot sign itself up.
- Owner/editor can update allowed brand and consent fields; viewer cannot.
- Changing profile/consent invalidates previous persona approval.
- No SMS, Meta history import, AI persona approval or Postiz publishing yet.
- Refreshing the browser discards the in-memory token.
- Limited test usage only; no paying customers until smoke/security tests pass.

## Rollback

If the Social service fails, **stop only that service**. Do not restart
Postiz or the existing PostBro API. If hosted SQL fails, do **not** issue
destructive DROP/rollback statements on a shared DB without a separate
review and verified backup; investigate the exact changes first.

## Current state

PR #28 is **code and runbook preparation only**. Neither the Social schema
nor the Social service is deployed; the first real client email and
membership test have not happened.
