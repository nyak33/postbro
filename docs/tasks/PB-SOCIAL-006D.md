# PB-SOCIAL-006D — Postiz organization links for shared-login clients

Status: draft source only; no production or staging DB migrations executed.

## Why this is necessary

- One shared Supabase identity lets users log into Postiz and PostBro.
- That **does not** automatically prove which Postiz organization or social channels a PostBro client may use.
- The Postiz `groups` endpoint organizes channels but is not tenant isolation.
- Postiz's existing authenticated `GET /public/v1/me` returns `organization.id` for the credentials being used. Use this in read-only checks before selecting an organization.

## Model

- **One PostBro client ↔ one Postiz organization** per instance in pilot.
- A private `postbro_social.postiz_organization_links` table stores the verified identity of the Postiz organization plus an existing customer group ID.
- A unique constraint rejects two PostBro clients claiming the same Postiz org or customer group on one instance.
- `authenticated` and `anon` have no table grants and RLS is enabled.
- The link remains PENDING until an operator separately verifies the Supabase user, Postiz user/organization membership and authenticated Postiz `GET /public/v1/me`. Merely typing an org ID or matching email is never proof.

## Functionality included

- `createPostizReadOnlyTransport().me()`: GET only; no key/token logged, no writes.
- `loadVerifiedPostizOrganizationLink`: trusted-server-only database lookup. Requires VERIFIED state, exact client ID and expected server-controlled instance origin.
- `verifyPostizOrganizationIdentity`: compares an authenticated Postiz API `/me` response against the recorded immutable org ID. Fails closed on any mismatch.
- RLS and unique-constraint rehearsal on disposable PostgreSQL 17; tests for swapped orgs and credentials.

## Not in scope

- Does not create a Postiz user or org, OAuth app, token, social channel, group or draft.
- Does not auto-provision or auto-link customer membership.
- Does not authorize publishing, edit any existing post, or bypass PostBro client RLS.
- The customer-facing PostBro authorization of a separate Postiz organization via Postiz OAuth is **not implemented yet**.
- No existing production PostBro/Postiz schema changes. New SQL is intentionally under `apps/social-web/migrations` and is not part of the root migration runner.

## Before live onboarding

1. Complete Supabase OAuth provider registration and custom consent UI with Postiz and PostBro as separate OAuth clients.
2. Verify Postiz user signs into the expected organization via shared identity.
3. Verify that user owns/is a member of the matching PostBro client using Supabase Auth and tenant RLS.
4. Establish a trusted Postiz OAuth grant or manual operator-approved proof for link; do not rely only on `/me` API-key organization metadata to claim user ownership.
5. Use the stored link only after `GET /public/v1/me` and fresh group/channel preflight match. No customer-provided org IDs in APIs.
6. Run isolated SQL rehearsal, then separately authorize rollout to shared `postbro-core` if needed.

Related PRs: PostBro #36, #37; Postiz fork #1, #2.
