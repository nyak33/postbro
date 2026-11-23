# PB-SOCIAL-005C — Postiz Draft Dispatch Ledger (source-only)

## Goal
Safely prepare a **Postiz draft**, with a durable one-shot attempt reservation before a future authorized API call. Postiz Public API does not document a client-supplied create-post idempotency key. **Never automatically retry after a request may have been sent.**

## Delivered
- Social-only migration 005: one ledger per content draft; immutable payload hash and tenant/channel snapshot; hard no-client-access RLS/grants.
- Trusted-worker functions (no HTTP implementation):
  1. Prepare: lock client + approved revision, verify exact client/group/channels and media, store hash/payload; conflicting retries rejected.
  2. Claim: repeat approval and channel verification, consume PREPARED to ATTEMPTED in DB transaction; exactly one claimant wins. Crash/timeout remains ATTEMPTED.
  3. Finish: verified Postiz draft response -> CONFIRMED; timeout, 5xx, malformed 2xx or uncertainty -> NEEDS_RECONCILIATION; definitive 4xx -> REJECTED. None can be reclaimed automatically.
- No API key, HTTP POST, scheduling, publishing, customer-accessible endpoint or production migration.

## Boundaries
- A trusted operator supplies per-client mapping and **fresh provider GET /integrations response**; customers cannot provide mapping IDs.
- A later live sender must use a per-client scoped credential or equally proven authorization, fetch integrations before claim, then perform **one** draft-only POST.
- After an ambiguous outcome, manually reconcile using Postiz records; do not invoke claim again or create a second dispatch.
- Physical DB privileges/RLS are tested against disposable PostgreSQL 17.11. Hosted Supabase remains untouched.

## Validation
CI: Social typecheck, unit receipt verification, RLS and concurrent claim tests. No live network calls.

References:
- https://docs.postiz.com/public-api/posts/create
- https://docs.postiz.com/public-api/integrations/list
