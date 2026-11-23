# PB-SOCIAL-004A — Durable Persona Review Requests (Pre-launch Development)

## Context
PostBro Social's onboarding portal currently supports login, brand intake and optional history consent, but **persona review in the real client portal is missing**. The private Persona Engine lives in a separate repository and must not be copied into the public PostBro repo.

## Objective
Let an authenticated client **review a pre-existing externally generated Persona V1 draft** and submit an explicit decision (approve request or request changes). Store the decision durably with verified user attribution and a specific revision. No automated activation or posting.

## Must-have
- Add `postbro_social.persona_review_requests` in a **separate, non-auto-applied** SQL migration after `001_social_foundation.sql`.
- User identity comes from verified Supabase Auth, with DB tenant membership and editor/owner role checked via PostgreSQL RLS; viewers and cross-tenant users are blocked.
- Only an externally generated draft (`source: EXTERNAL_ENGINE`) can be reviewed. Mock/local template drafts **must not be eligible** for approval.
- Bind the review request to the **current revision** and only `PERSONA_REVIEW` state. Database uniqueness prevents duplicate requests for one revision; stale decisions cannot activate anything.
- Store immutable review decision and optional suggested edits. Review requests do **not** change `status`, set `persona_approved_revision`, or schedule/approve any content.
- Display the stored draft in the customer portal, with a **clear distinction** between 'approval requested' and 'approved/active'. Use safe DOM text, no HTML injection.
- Add PostgreSQL 17.11 integration tests for owner/editor/viewer/cross-tenant, absence of persona draft, mock draft rejection, stale revision, duplication, and non-activation.
- Add Fastify and browser contract tests. Keep existing PostBro regressions passing.

## Deferred
- Integrating the private Persona Engine via a trusted API adapter, generating a real draft, validating internal prompt compiler, processing client review requests and activating personas.
- Historical content import and Meta permissions.
- Postiz/client organization mapping, content generation, customer approval-before-publishing, content calendar, billing and public client launch.
- Live hosted Supabase migrations, test users, OTP emails, VPS deployments, DNS/tunnels and production social actions.

## Acceptance
A disposable DB fixture containing an `EXTERNAL_ENGINE` Persona V1 supports client review request and durable audit without creating an active persona. Unauthorized or stale inputs are rejected at the database level. All GitHub CI checks pass.

**This task is source-only development, not authorization to change the live `postbro-core` database.**
