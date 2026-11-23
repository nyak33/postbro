# PB-SOCIAL-004C — Trusted Persona Draft Persistence and Activation

**Pre-launch source-only, no hosted SQL/production changes.**

## Goal
Connect existing `prepareExternalPersonaDraft()` (private engine adapter) with persistent PostBro Social tenant data, then consume immutable customer review decisions. A persona becomes **READY** only after a verified customer review request for the exact external-engine revision has been processed by a separate, agency-trusted worker.

## Must have
- Add isolated migration `003_social_persona_versions.sql`. Immutable `persona_versions` holds exact versioned private-engine record and client/revision snapshot. `persona_review_actions` holds one processing result per immutable review request. Both tables are **never exposed to authenticated / anon** users.
- Trusted functions (not reachable from browser/client API):
  1. Read current `ONBOARDING` brand with its revision, generate a private engine draft, lock row, reject stale changed brand/consent or existing draft, store version & mark `PERSONA_REVIEW`.
  2. Lock customer review + client, check current revision, source and private version. Record an immutable action. For APPROVE, set `READY`, `persona_approved_revision`, `persona_approved_at`. For REQUEST_CHANGES, invalidate draft and set `ONBOARDING` to require a new engine revision. For stale requests, log STALE only, never activate.
- Enforce uniqueness and transactions to avoid duplicate generation or processing. No silent approval, no automatic client decision or publication.
- Guard public portal against private engine record leakage. All SQL parameters bound; no user-supplied arbitrary tenant/role.
- Disposable PG17 integration tests: valid approval, request changes, stale after brand edit, duplicate idempotence, cross-client review isolation, private-record grants. Existing tests unchanged and green.
- Unit tests for engine adapter invocation against mocked external engine response and explicit failure behavior.
- No new routes. This is a privileged worker library and test harness. Production credentials cannot be used in CI.

## Out of scope
- Hosted migration, live Supabase/SMTP, installing private engine on VPS, client provisioning, external content generation, Postiz publishing and payment.
- Client review page already merged in PB-SOCIAL-004A. This phase only processes its recorded decisions.

## Acceptance
From a disposable PG17 DB: a brand intake can create an `EXTERNAL_ENGINE` reviewable draft and trusted worker can activate **only the matching recorded APPROVE** decision. Edits invalidate revisions and cannot be activated. No production data touched.
