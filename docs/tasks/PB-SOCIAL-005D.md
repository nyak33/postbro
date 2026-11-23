# PB-SOCIAL-005D — Read-only Postiz customer/channel preflight

## Goal
Verify Postiz tenant/customer-group mappings before any future controlled draft dispatch. The preflight uses only GET /public/v1/groups and GET /public/v1/integrations?group=... and returns minimal verified channel records.

## Read-only live observation, 23 November 2026
The connected self-hosted Postiz reported 4 channels: FB Post Bro, IG Post Bro, Threads syaqir_sharani, Threads post_bro33. Its customer group list returned ZERO groups. Therefore there is no verified customer-group isolation to authorize live client draft creation. Do not move or reassign existing channels to make this test pass.

## Scope
- Strict HTTPS + fixed read-only API paths, no provider POST or any other mutating method.
- Operator mapping checked against a fresh group list and current group-filtered integrations. Fail closed on missing/duplicate groups, disabled/ungrouped/cross-group channels, mismatched providers and invalid API responses.
- Only minimum channel ID/provider/group data is returned. API credentials, headers and upstream error details are never logged or returned.
- Unit tests simulate both successful and invalid provider responses and verify existing draft payload builder still returns type=draft.
- No database change, no production deployment, no customer group creation, no upload, no scheduling or publishing.

## Separate prerequisites for an authorized end-to-end Postiz draft test
1. Have a dedicated staging/test customer group with its own dedicated test channels.
2. Independently verify per-client API credential scope and account isolation.
3. Use PB-SOCIAL-005C one-shot ledger with new GET verification immediately before one draft-only POST, followed by provider response reconciliation.
4. Never retry uncertain responses automatically; preserve existing live channel/calendar state.

## Validation
GitHub Actions Social unit tests and disposable PostgreSQL 17.11 rehearsal. The plugin observation above was read-only; no API key was accessed or printed.

References:
- https://docs.postiz.com/public-api/integrations/groups
- https://docs.postiz.com/public-api/integrations/list
- https://docs.postiz.com/public-api/posts/create
