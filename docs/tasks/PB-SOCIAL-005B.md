# PB-SOCIAL-005B — Postiz Dry-run Payload Gate

**No live Postiz writes.** Build a validated API payload from a fully approved PostBro Social content draft.

## Objective
Implement a pure, testable provider adapter for Postiz `POST /public/v1/posts`
using `type: "draft"` **only**. Prevent accidentally creating scheduled or
immediately published posts during pre-launch development. Actual network
write will be a later separately authorized phase with per-client credentials
and durable idempotency/reconciliation.

## Constraints
- Start with `getTrustedApprovedContent()`, which returns non-null only when
  exact content revision is explicitly client-approved and its persona remains
  approved.
- Operator-supplied per-client Postiz group/channel mapping must match a
  fresh Postiz GET /integrations response. Never use a caller-supplied
  integration ID, platform or group without verification.
- THREADS draft requires one connected Threads integration; FB_IG requires
  both connected Facebook/Instagram integrations with a shared customer group
  and **at least one ready, already-uploaded media attachment**. No text-only
  Instagram draft is treated as publish-ready.
- Confirm provider settings: Threads `{__type:'threads'}`; Instagram feed
  `{__type:'instagram',post_type:'post'}`; Facebook
  `{__type:'facebook'}`.
- Payload is *draft only*, despite storing a proposed future schedule date.
  No live API call/POST is implemented in this task.
- Tests verify wrong customer, disabled integration, duplicate mapping,
  missing media, invalid URL/id, output exact shape, stale persona
  gate and lack of any network/post operation.
- Keep credentials out of code/config and never alter existing Postiz
  organizations, integrations or scheduled posts.

Docs checked from official Postiz Public API Create Post, List Integrations and
Instagram Settings references (November 2026).

## Acceptance
CI green. Only a durable explicitly approved content record with known
provider mapping can produce a valid Postiz *draft* request object. No live
Postiz traffic. This prepares the safest next integration test.
