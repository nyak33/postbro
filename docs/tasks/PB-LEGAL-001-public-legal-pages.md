# PB-LEGAL-001: Public legal pages (privacy, terms, data deletion)

Status: APPROVED (owner signoff 2026-11-17) and IMPLEMENTED — routes, tests,
spec and copy committed on feat/PB-LEGAL-001-public-legal-pages, PR #23 open.
Pending: owner content review of the published page copy, then deploy
(owner-gated). History: spec first written as DRAFT before signoff; updated
here after approval and implementation to reflect actual state.

## Task ID

PB-LEGAL-001

## Objective

Add three PUBLIC, unauthenticated, responsive HTML routes to the existing
Fastify service so the Meta App (postbro.syaqirshaq.online) can satisfy Meta
App Review requirements:

- GET /privacy
- GET /terms
- GET /data-deletion

No auth, no database, no static file dependencies, no external scripts, no
tracking, no cookies, no secrets. Pages link to each other and to the support
contact.

## Operator / brand facts (approved by owner)

- Brand/operator name shown publicly: "PostBro", privately operated and
  controlled by an individual. NOT a company; do NOT mention Packtica.
- Public support/privacy contact email: postbro33@gmail.com
- Do NOT publish owner legal name, home address, personal Gmail (other than
  the support address above), or any Meta app secrets.
- Effective date shown on pages: 17 November 2026.
- Scope of the Meta app: connects Facebook Pages, Instagram and Threads
  profiles. Posting/scheduling happens through separately self-hosted Postiz;
  engagement happens through PostBro.
- Honesty constraint (repo-audited): current PostBro implements ONLY Threads
  OAuth + read client + inbound reply inbox persistence. Pages must NOT claim
  Facebook/Instagram engagement, AI automated replies, an automated deletion
  pipeline, or a retention/purge job already exist. Postiz data-retention and
  token-encryption behaviour is UNVERIFIED and must be described as such.

## Content requirements

### /privacy

- Describe the service and operator, with contact email.
- PostBro Threads data: provider user ID, username, granted permissions/scopes,
  encrypted access token, own thread IDs/permalinks/timestamps as needed, and
  other users' reply text/timestamps/relationships stored for engagement
  management.
- Postiz (distinct service, same operator): handles authorised Facebook /
  Instagram / Threads profile connections, post scheduling/publishing, and
  necessarily processes submitted content and relevant profile/account
  details. Explicitly state Postiz retention/storage practices are not yet
  verified by this policy's author.
- Distinguish current Threads processing from future capabilities (e.g.
  AI-assisted drafting — not currently live).
- Processors actually in use: Meta APIs, Supabase PostgreSQL, cloud hosting
  infrastructure (VPS provider), self-hosted Postiz. Do NOT assert Telegram or
  an AI/LLM provider as connected today.
- PostBro tokens encrypted at rest, access restricted to the operator; no
  guarantee of absolute security. Do NOT claim Postiz token encryption.
- No sale of personal data; no use of this app's data for targeted
  advertising.
- Lawful use: users connect accounts voluntarily and grant permissions; how to
  request access/correction/deletion via email.
- Retention: kept while needed to provide the service, until a deletion
  request; a formal retention schedule is not yet finalized — do NOT describe
  an automatic purge job. Meta may retain its own data independently.
- Policy change process and contact.

### /terms

- Authorised use only (owner's personal/company/friends' authorised accounts).
- Meta's third-party/platform terms apply.
- Publish/engage only through authorised features; user responsible for
  content; no unsolicited bulk messaging, spam or abuse; user may revoke Meta
  authorisation at any time.
- Features subject to change; no guarantee of uptime or availability;
  liability wording that does not attempt to disclaim liability that cannot be
  disclaimed by law.
- Support email and effective date.

### /data-deletion

- Instruction: email postbro33@gmail.com with subject
  "PostBro Data Deletion Request", identifying the connected social
  handle/platform and a safe verification method. NEVER ask for passwords,
  App Secrets or tokens.
- Manual process (current truth): operator verifies account ownership,
  disconnects/revokes where possible, removes account-specific PostBro data,
  assesses linked self-hosted Postiz data, and follows up with written
  confirmation — subject to necessary legal/security records and backup
  retention.
- Meta-side instructions for removing the app's permissions; explain that
  revoking Meta access stops future API access but does NOT automatically
  delete PostBro/Postiz stored data — email separately.
- Third-party reply authors: how to contact and request deletion of stored
  content referring to their content, without exposing other users' data.
- Do NOT claim a deletion button, immediate/automatic deletion, or a fixed
  SLA. Commit only to responding without undue delay.

## Technical requirements

- Strict TypeScript, Fastify v5, no new runtime dependencies; HTML served as
  inline template strings from a module under src/modules/legal/ (or similar).
- Semantic HTML (h1/h2, main, nav), responsive viewport meta, minimal inline
  CSS only; lang="en"; content-type text/html; charset=utf-8; HTTP 200.
- Routes registered unconditionally (like /health) — no env/DB dependency.
- Each page cross-links the other two and shows the contact email.
- Trailing-slash and case behaviour: rely on Fastify defaults; verify in
  tests what /privacy/ does and document it.
- Works over the public HTTPS origin once deployed (deployment is OUT of
  scope for this task).

## Tests

- Fastify inject tests (tests/legal-pages.test.ts): for each of the three
  routes — 200, content-type text/html, no auth required, presence of key
  static content (contact email, cross-links, effective date, subject line on
  deletion page), no cookies set.
- npm run test, npm run lint, npm run typecheck, npm run build — record exact
  results; NOT_RUN where not feasible.

## Explicitly out of scope

- No production deployment, no service restart, no Meta App Dashboard publish.
- No secret/config modification, no DNS/Cloudflare changes, no Postiz changes.
- No automated deletion endpoint or button.
- No PRD amendment; legal pages are infrastructure for Meta App Review, not a
  product feature change.

## Outstanding / needs owner confirmation

1. Spec signoff (this document).
2. Legal copy review: the full drafted text of all three pages must be
   reviewed and approved by the owner BEFORE merge and BEFORE deploy. The
   copy is legal-facing; operator identity description ("privately operated
   by an individual") may need independent legal confirmation.
3. Postiz data-handling statements are marked UNVERIFIED; if the owner can
   substantiate Postiz retention/token-encryption behaviour, the copy should
   be updated in a follow-up.

## Acceptance checks

- A1: GET /privacy, /terms, /data-deletion return 200 text/html without auth.
- A2: Copy constraints above honoured (no unverifiable claims).
- A3: Cross-links and contact present on all pages; responsive + accessible
  markup.
- A4: tests/lint/typecheck/build run and recorded.
- A5: Task spec exists (this file); owner copy review recorded before deploy.
