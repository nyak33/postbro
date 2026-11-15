# PB-P2 (scoped): Account-scoped inbound reply persistence + DB-backed inbox

Status: implemented (this PR). No live provider calls, no deploy, no scheduler,
no token handling, no MCP route, no automation.

## What this is

The minimal persistence/inbox foundation for PostBro's engagement loop:

- `src/modules/inbox/reply-sync.ts`
  - `persistInboundReplies(pool, operatorId, accountId, replies)` — idempotent
    storage of inbound replies into `postbro.engagement_events`.
  - `listInboxEvents(pool, operatorId, accountId, limit=25)` — read-only,
    bounded (1..100), newest-first inbox listing.

## Contract

- Authorization (both functions): active `operators` row + `operator_accounts`
  ownership + active `threads_accounts` row, verified under RLS as the app
  role. Deliberately WITHOUT `persona_bindings` — persona onboarding is not
  yet integrated and must not gate inbound sync. Disabled operator/account or
  unknown ownership fail closed with `account_not_authorized`; no writes occur.
- Input trust boundary: `replies[]` MUST be pre-validated by the caller /
  provider adapter as belonging to CONFIRMED OWN root posts, with
  `isReplyOwnedByMe === false` and trusted `ownRootId` / `providerReplyId`.
  This function never accepts caller-supplied arbitrary roots and never
  performs account-ownership guessing: anything own (`true`), unknown
  (`undefined`), or malformed/oversized/untrusted ID is skipped and counted,
  never stored. Authorization still re-checked server-side before any insert.
- Persistence: `INSERT ... ON CONFLICT (account_id, provider_reply_id)
  DO NOTHING` into `postbro.engagement_events` with `content.source =
  'own_post'` plus root id, parent id, text (capped at 2000 chars), provider
  timestamp and fetch time. Existing rows are never overwritten; re-runs
  dedupe. Returns `{ received, inserted, existing, skipped }`.
- Inbox: read-only transaction under `setRlsContext`, authorization re-check,
  total count + bounded page sorted `received_at DESC, id DESC`. Safely typed
  output; malformed legacy rows are filtered out.

No public routes, no DB migrations, no Meta requests, no persona requirement,
no provider token material, no approvals, no jobs are involved here.

## Next missing piece (not in this PR)

- Read-only sync orchestrator on top of the merged `ThreadsReadClient`
  (`GET /me/threads` for verified own roots, then `GET /{id}/replies`),
  an encrypted token resolver, owned-root checks and bounded fan-out — feeding
  `persistInboundReplies`.
- Conversation-nested replies and external-root (replies to our comments under
  other people's posts) remain UNVERIFIED against live Meta field/scope
  availability; not supported until explicitly verified and approved.
- Control surface: MCP-first (ChatGPT/Claude MCP + Hermes workers), NOT
  Telegram as the primary interface.
- Outbound replies: proposals/approvals flow first; Full-Auto only with
  per-account opt-in and dry-run before any live send.

## Tests

`tests/reply-sync.test.ts` runs against disposable embedded PostgreSQL 17 with
the real migrations and RLS: first ingestion, re-run dedupe (no updates),
cross-account isolation with the same provider reply id, disabled
operator/account and unknown ownership fail closed, missing persona permitted,
own/unknown/malformed replies skipped, invalid caller input rejected, bounded
read-only inbox with newest-first ordering, and proof that no
proposals/approvals/jobs/execution rows are created.
