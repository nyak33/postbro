# ADR-001 — PostBro becomes one modular npm-workspaces monorepo

- **Status:** Accepted (owner architecture decision, 2026-11-15)
- **Date:** 2026-11-15
- **Decision makers:** Owner (approval recorded in task instruction 2026-11-15)
- **Scope:** Documentation-only. This ADR locks the architecture decision and the
  phased migration plan. NO runtime code is moved, no directories are created,
  no infrastructure, deployment, restart, live social/API action, DB migration,
  or private-code copying is performed or authorized by this ADR.

## Context

PostBro today is a single-package TypeScript/Fastify service in this repository
(`postbro-threads-engagement`, MIT, `private: true`). The current production
service — Fastify API, direct Meta Threads OAuth with encrypted token
persistence, Supabase Cloud PostgreSQL, Cloudflare in front — is deployed from
this root layout and must be preserved.

Adjacent capabilities currently live elsewhere:

- Threads transport: separate repo `nyak33/postbro-engagement-threads`
  (originated as a Postiz bridge; the new monorepo uses independent direct Meta
  auth and the token DB in this repository — no new OAuth source of truth).
- Persona Engine and Reply Decision Engine: separate **PRIVATE** repositories.
  Their code must NOT be copied into this PUBLIC repository without a separate
  explicit owner decision on repo visibility and licensing.

Production objective: finish a usable Threads inbound **Semi-Auto** engagement
MVP for account `post_bro33`, while keeping the option to grow into a modular
monorepo without a disruptive rewrite.

## Decision

PostBro becomes **ONE modular npm-workspaces monorepo**. Postiz is maintained
as a **separate repository/product** and exclusively owns posting and
scheduling; PostBro has no Postiz runtime dependency (unchanged, per PRD).

### Alternatives considered

1. **Full monorepo including Postiz — REJECTED.** Postiz is an independent
   product with its own lifecycle; merging it would couple release cadence,
   licensing and blame, and contradicts the PRD boundary that Postiz owns
   publishing/scheduling.
2. **Permanent multi-repo per engine — REJECTED.** Cross-repo coordination
   cost (version skew, duplicated types, PR chains) is already the main drag on
   delivering the Semi-Auto MVP; the engines are logically one product.
3. **Modular npm-workspaces monorepo (Postiz separate) — CHOSEN.** Keeps one
   build/test/deploy surface for PostBro, allows engines to become versioned
   workspaces gradually, and leaves Postiz cleanly external.

### Target structure (target only — nothing is created yet)

```
apps/
  api/                 # current backend transitions here (one deployable app initially)
  worker/              # ONLY when durable jobs are added; same image/VPS is acceptable
packages/
  threads/             # direct Meta Threads adapter (transport from postbro-engagement-threads)
  inbound/             # reply decision workflow integration (private source, see constraints)
  persona/             # account-scoped persona integration (private source, see constraints)
  shared/              # only if a concrete shared need is demonstrated
db/                    # preserved as-is (migrations authority unchanged)
```

Constraints on the target structure:

- **One deployable app initially.** `apps/api` is the only service; an
  `apps/worker` process is introduced only when durable jobs exist, and may run
  on the same VPS from the same image.
- **Interim runtime unchanged.** Until a phase explicitly moves code, the
  production service continues to run from the current root layout. No dual
  deployments.
- **Tooling:** npm workspaces + strict TypeScript only. No Nx, Turborepo, or
  other orchestration tooling without demonstrated need.
- **Repo name** `postbro-threads-engagement` remains for now; an optional
  rename is possible after the pilot, separately approved.
- **Private engine code:** consumed through a versioned adapter boundary
  (pinned dependency, submodule, or vendored-with-review). A prepublication
  legal/licensing check is required before any private code enters this public
  repo. Open-source status of the engines is NOT assumed.

## Phased, test-gated migration plan

Each phase is its own reviewed PR. Minimal-change first; no empty directories,
no code moves in this PR.

| Phase | Work | Exit gate |
|---|---|---|
| 0 | Lock this decision: ADR + docs references + source inventory of current modules (`src/app`, `src/modules/auth`, `src/integrations/threads`, `src/db`, `src/shared`). | This docs PR merged. |
| 1 | READ-ONLY verification of the connected account's API access and permissions for `post_bro33`. Live callback on 2026-11-15 reported `status=connected, accountId=1, operatorId=1, scopesVerified=false, grantedScopes=[]` — this is NOT proof of denial; granted scopes must be positively queried. | Documented read-only scope/account/thread retrieval smoke plan and its reviewed results; no claim of engagement capability until positively observed. |
| 2 | Port/adapt the Threads transport from `nyak33/postbro-engagement-threads` behind `packages/threads` (or interim adapter), keeping THIS repo's direct Meta OAuth + encrypted token DB as the sole auth source of truth. No new OAuth flow. | Transport unit/integration tests pass against mocked provider; existing OAuth callback tests stay green. |
| 3 | Integrate Persona and Inbound engines behind versioned adapters with correct immutable account ID mapping. Must reproduce and fix the known Semi-Auto routing bug: the existing separate inbound engine returns AUTO_SEND at high score; in PostBro Semi-Auto mode every externally visible reply MUST require explicit operator approval regardless of score. | Regression test proving Semi-Auto never auto-sends at any score; cross-account binding tests stay green. |
| 4 | PostBro product Telegram bot approvals + durable dedupe/reconcile (unique external action key, NEEDS_RECONCILIATION on ambiguous outcomes). | Replay/duplicate-callback tests; unauthorized-sender tests. |
| 5 | Real owned-post/reply live smoke (owner-approved, single account), then — and only then — routine polling. Pilot sequence: own Threads root post -> inbound reply -> persona-aligned proposal -> operator Telegram approval -> exactly one confirmed reply with durable audit. | Live evidence of exactly one confirmed approved reply; no duplicates on replay; audit rows persisted. |

Postiz remains a separate product even if self-hosted/forked; it is never a
PostBro runtime dependency.

## Acceptance tests and reversible boundaries (for every migration phase)

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass.
- Current OAuth flow still returns HTTP 200 on a valid callback (test-double
  provider), and `GET /health` returns 200.
- No root route (`GET /`) is expected or added.
- No data loss: migrations remain additive/backward-compatible; existing
  account/token rows readable before and after each phase.
- No credential leakage: secret-scan/diff review per PR; no tokens, codes,
  connection strings or secrets in logs, tests, docs or PR text.
- Reversibility: each phase lands behind workspace/adapter boundaries such that
  reverting the phase's PR restores the prior runtime layout without data
  migration.

## Migration blockers / open dependencies

- **Private source visibility/licensing** for Persona and Inbound engines
  (owner decision required before any code enters this public repo).
- **Permission verification:** granted Threads scopes not yet positively
  confirmed (`scopesVerified=false, grantedScopes=[]` observed 2026-11-15).
- **PostBro product Telegram bot token/account** not yet provisioned.
- **LLM provider choice** for the application adapter unresolved.
- **Account/persona binding** for `post_bro33` to an approved persona version.
- **Semi-Auto fail-safe:** AUTO_SEND contradiction in the existing inbound
  engine must be fixed and regression-tested before adoption.
- **Rate limits and idempotency** for inbound sync and reply send must be
  designed against official Meta documentation and verified capability.

## Consequences

- Single build/test/CI surface for PostBro; engines version together once
  onboarded.
- No immediate runtime change; production keeps running from the current root
  until an approved phase moves it.
- No speculative cost is incurred by this decision; hosting remains one VPS +
  Supabase Cloud + Cloudflare.
