# PB-SOCIAL-005A — Client Content Review Queue

**Pre-launch / development-only.** Add a minimal tenant-safe content queue and explicit approval workflow. Keep Postiz completely disconnected until a separately tested dispatch adapter is ready.

## Workflow
1. Trusted agency process can create a text-only `THREADS` or `FB_IG` content draft **only** for a client with current, recorded `READY` approved Persona V1.
2. Each draft has a local-Malaysia schedule target, current persona revision and immutable content revision.
3. The customer signs in to their Social portal, reads their organization's content, and explicitly submits one `APPROVE` or `REQUEST_CHANGES` per revision. Viewer may read but cannot approve. No customer API can create or modify content or switch tenant.
4. Trusted process checks current persona and revision before marking a draft `APPROVED` or `CHANGES_REQUESTED`. Stale requests never approve anything. Requested changes require a new content revision.
5. **Nothing calls Postiz or publishes.** The separate posting bridge will require approved content and a verified tenant channel mapping.

## Boundaries
- Count one FB+IG crosspost as **one content piece**. Starter: max 2 FB_IG and 3 THREADS per MYT day; Growth: max 3 FB_IG and 5 THREADS per MYT day. This also caps weekly pieces at 35/56. Enforce server-side transactionally, not via self-host Postiz's subscription checks.
- No auto-posting, no draft "now" publishing, no account creation, no public service deployment.
- RLS with auth.uid() and organization ownership on content reads and customer approvals.
- Lock rows and compare `client.persona_approved_revision` to draft to prevent publishing content from stale personas.
- Apply a new isolated `004_social_content_approval.sql` migration **only in a disposable DB** during development CI.
- Keep test accounts, DNS, Postiz instances and live Supabase untouched.

## Acceptance
- Real PostgreSQL 17.11 test covers Starter/Growth caps, explicit approval, viewer/cross-client denial, stale persona revocation, revisioned changes, concurrent duplicate decisions and no network publishing.
- Fastify and browser tests cover authenticated content listing and decisions.
- Postiz integration/bindings and actual schedule dispatch remain separate tasks.
