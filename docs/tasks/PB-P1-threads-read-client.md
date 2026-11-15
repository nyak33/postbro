# PB-P1 slice: READ-ONLY Threads media/replies transport client

Status: implemented on branch `feat/pb-p1-threads-read-client` (code + deterministic tests; NO live Meta calls under this task, NO DB changes, NO routes, NO deployment).

## Scope

First small read-only Threads transport integration in the current backend, per owner "go" after the successful read-only API smoke. Interim adapter at `src/integrations/threads/threads-read-client.ts` per ADR-001 (existing `src/` layout stays the runtime reality; this module is the seed for the future `packages/threads` npm-workspaces package).

- `ThreadsReadClient.listOwnThreads(token, limit)` -> GET `/v1.0/me/threads?fields=id,has_replies,timestamp,permalink&limit=N`
- `ThreadsReadClient.listRepliesForMedia(token, mediaId, limit)` -> GET `/v1.0/{mediaId}/replies?fields=id,text,timestamp,permalink,replied_to,root_post,is_reply_owned_by_me&limit=N`
- `ThreadsReadClient.listOwnReplies(token, limit)` -> GET `/v1.0/me/replies` (same fields)

No POST/write methods, no HTTP routes, no DB access, no pagination following (first page only; `hasNextPage` flag only, cursor values never surfaced). Token is injected per call from the caller's existing secure stored account token; no new env var, no Postiz dependency.

## Security contract

- Injected `HttpTransport` (reuses oauth-client-http.ts port + fetch transport); fixed host `https://graph.threads.net`, redirects denied, bounded timeout/body/limit (1..100).
- Token in `Authorization: Bearer` header ONLY; never in URL query.
- `mediaId` path segment validated to numeric-string before any network call.
- Provider errors sanitized: numeric HTTP status / Meta error.code / error_subcode only; never body text, URLs, tokens, or social content.
- Reply `text` and third-party content is UNTRUSTED; never logged by this client.
- Ownership fields (`is_reply_owned_by_me`, `replied_to`, `root_post`) are pass-through only when the provider returns a usable value; otherwise undefined = ownership UNKNOWN = callers fail closed.
- This client does NOT mark scopes verified: granted scopes remain `{ verified: false, scopes: [] }`.

## Read-only live evidence (owner-run smoke 2026-11-15, prior to this task; NOT re-run here)

- Account post_bro33, internal accountId=1 / operatorId=1, valid encrypted stored token, immutable provider ID match.
- GET /v1.0/me -> 200; GET /me/threads (id,has_replies,timestamp, limit=5) -> 200, 5 posts; GET /{owned_post_id}/replies -> 200 (0 replies); GET /me/replies -> 200 (1 reply).
- No permission-specific errors observed => effective read capability. scopesVerified stays false, grantedScopes stays [] (no authoritative scope enumeration endpoint). No live write tests performed.

## Integration path (next milestones, NOT this task)

1. Account-scoped read-only sync/inbox: worker resolves account -> stored encrypted token -> `ThreadsReadClient` -> eligibility (owned root id + has_replies) -> persist replies with account isolation in existing DB schema. Idempotent upserts keyed by provider reply id.
2. Telegram approval surface for proposed replies (Semi-Auto default; explicit per-reply approval).
3. ADR-001 phased migration moves this module to `packages/threads` once npm-workspaces gate is met.
