# Postiz Draft Adapter — PB-SOCIAL-005B

**Development only: payload preview, no Postiz request is performed.**

The current PostBro Social content queue has tenant-authenticated client
approval with exact content revisions and a trusted `APPROVED` status.
The next step is verifying connected Postiz channels without allowing any
client to substitute another business's integration.

`src/postiz/draft-preview.ts` builds a Postiz `POST /public/v1/posts`
JSON body with **type `draft` only**, after
`getTrustedApprovedContent()` confirms:
1. Client approved the exact content revision;
2. Trusted worker processed that approval;
3. The client's Persona V1 is still active and matches the draft.

For the channel mapping to pass, an operator must supply verified channel
IDs from the correct client Postiz customer group and compare them to the
fresh provider `GET /public/v1/integrations` response. Disabled channels,
missing accounts and mismatched groups are rejected. Clients cannot enter
Postiz integration IDs in the portal.

Provider rules:
- THREADS: one verified Threads integration, text <=500 characters,
  `settings.__type='threads'`.
- FB_IG: verified Facebook and Instagram integrations, **both** in the
  same customer group, at least one previously uploaded **ready** media item,
  `settings.__type='facebook'` and Instagram `post_type='post'`.
- This builder does not upload, generate or inspect media; only trusted ready
  Postiz media records may be provided by a future operator integration.
- These are **drafts**, not scheduled posts; the stored proposed date is
  included in the payload but no publishing action is enabled.

No network POST function has been implemented: a real Postiz draft could
otherwise be created without durable idempotency, authorization and
reconciliation. Later rollout requires per-client Postiz organization/API
credentials, fresh integration verification, a durable attempted-dispatch
record and manual handling of ambiguous timeouts to prevent duplicates.

Official API references used:
- https://docs.postiz.com/public-api/posts/create
- https://docs.postiz.com/public-api/integrations/list
- https://docs.postiz.com/public-api/providers/instagram

**Not performed:** no Postiz API calls, credentials, DNS changes, social
media posts, Supabase schema migration or VPS deployments.
