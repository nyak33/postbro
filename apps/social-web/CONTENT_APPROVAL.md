# PostBro Social — Client Content Approval (PB-SOCIAL-005A)

This code handles **content planning and explicit client decisions only**. It
does not make any Postiz API calls, publish, or schedule.

- Agency-trusted code creates text-only `THREADS` or `FB_IG` drafts for a
  currently approved Persona V1.
- `FB_IG` is a single content piece intended to be crossposted to two
  channels later. Customer approvals are version-specific, immutable and
  associated with verified Supabase Auth user IDs through PostgreSQL RLS.
- Approving a draft creates a **review request**. Only a separately trusted
  processor changes the draft to `APPROVED` after verifying the active
  persona and content revision. No post is sent anywhere.
- `REQUEST_CHANGES` requires meaningful text. Agency can revise the text;
  this creates a new content revision and requires another client decision.
- If a brand edit revokes the approved persona, previously approved drafts
  become ineligible for dispatch.
- Database trigger serializes quota checks: Starter 2 FB+IG and 3 Threads
  pieces per MYT day; Growth 3 FB+IG and 5 Threads. These correspond to
  the pilot targets 35/56 unique pieces per week. Enforced by PostBro's
  database, NOT by self-host Postiz's subscription configuration.
- Content data may only be read by the current organization. Owner/editor
  may submit decisions. Viewers may read but never approve, alter content,
  change plans, or write to audit tables.

Files:
- `migrations/004_social_content_approval.sql`: isolated, opt-in migration.
- `src/content/trusted-workflow.ts`: admin-only draft/revision/decision code.
- `src/content/customer-store.ts`: verified tenant-RLS client access.
- `public/portal.html`, `public/portal.mjs`: safe text-only review UI.
- `tests/content-api.test.ts`, `tests/rls-pg17.test.mjs`: API and real
  disposable PG17 acceptance tests.

## Still missing

Actual content generation/rewriting with LLM, image/media workflow,
independent Postiz organization and verified channel mappings, dry-run
payload/adapter, safe dispatch reconciliation and real service deployment.

**No live database, Postiz posts, Supabase Auth users, VPS or DNS were
changed during this phase.**
