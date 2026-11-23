# PostBro Social — Persona Review Requests (PB-SOCIAL-004A)

This module implements **durable client review intent** for a Persona V1 draft.
The private Persona Engine itself is **not copied or deployed here**.

## Current user journey

1. Agency pre-provisions a tenant and client with a trusted Supabase Auth identity.
2. Client signs in, completes their brand profile and chooses whether to allow
   *future* historical analysis.
3. A separately verified Persona Engine integration will later create a JSON
   draft inside `postbro_social.clients.persona_draft` with
   `source: "EXTERNAL_ENGINE"` and fields:
   `proposal.summary`, `proposal.writingStyle`, `proposal.contentPillars`.
   Until that integration exists, the portal shows **no reviewable draft**.
4. The client can read the draft and submit one immutable review request
   for that exact `persona_revision`: `APPROVE` or `REQUEST_CHANGES`.
5. The review request records `requested_by` from a verified Supabase Auth
   identity and remains **pending trusted processing**. It never changes
   `status` to `READY`, activates a persona, or queues/publishes content.

## Authorization and safety

- `apps/social-web/migrations/002_social_persona_review_requests.sql`
  is an **opt-in** migration after `001_social_foundation.sql`, outside the
  root engagement migration runner. It has not been applied to hosted Supabase.
- Database RLS checks tenant membership AND owner/editor role for insertion;
  viewer users may read permitted history but may not submit decisions.
- Database checks require the current `PERSONA_REVIEW` state and exactly
  matching persona revision, and refuse any draft with
  `source: "MOCK_PREVIEW"` or `LOCAL_TEMPLATE`.
- Unique `(client_id, persona_revision)` guarantees at most one immutable
  request per draft; stale or replayed submissions do not create more actions.
- Client roles get SELECT/INSERT only; no UPDATE or DELETE rights. No
  privilege to modify `clients.persona_draft` or activation fields.
- Brand/consent changes already invalidate old drafts and approvals via the
  trigger from migration 001. A trusted processor must recheck the current
  revision at the moment it processes a review request.
- The API does not trust a user-provided `organizationId` or `requestedBy`.
  It verifies Supabase Auth before using tenant-scoped Postgres RLS queries.
- Persona strings are rendered with DOM `value` / `textContent`, never
  untrusted HTML interpolation.

## Testing

GitHub CI runs:
- Social TypeScript and browser-level contract tests.
- PG17 disposable database integration: draft source, RLS role isolation,
  cross-tenant, duplicate/stale review, no activation, and existing pilot cap.
- Existing Threads engagement tests remain unchanged.

**No production migration, user invites, real OTP emails, Persona Engine
activation, Postiz publishing, or service deployment is authorized by this
development PR.**

## Follow-on work required before real client testing

- PB-SOCIAL-004B: trusted external Persona Engine adapter that builds and
  stores a versioned draft using the agency's reviewed server-only identity,
  and a trusted processor for client review intent, with an immutable
  activation record. Do not copy private engine source into public repo.
- PB-SOCIAL-005: customer content drafts and **explicit per-post approval**
  before Postiz scheduling. No auto-publishing during onboarding.
- Hosting: secure real account provisioning, backup/restore review before
  hosted migration, then complete prelaunch functional browser tests.

This PR can be tested immediately using a **disposable PostgreSQL 17.11**
fixture with an artificial `EXTERNAL_ENGINE` persona draft. That fixture is
test data, not a real generated persona or a real customer's approval.
