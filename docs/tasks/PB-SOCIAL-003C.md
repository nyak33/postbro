# PB-SOCIAL-003C — Isolated Social staging launch preparation

**Owner authorization:** 2026-11-22 "go" after PR #27 review/merge, to prepare staging setup. No authority to send real OTPs, apply hosted SQL, change tunnels/DNS/VPS services, deploy or modify production.

## Goal and success criteria

Make the Social client portal introduced in PR #27 runnable in its **own** explicitly selected, isolated staging environment, without linking it to the production Threads API, the existing Postiz instance, or the existing PostBro Supabase database by default.

- Provide a standalone entry point and strict preflight validation of environment variables.
- Reject missing configuration, non-Supabase URL, insecure database URLs, mixed Auth/DB project refs, invalid ports or non-loopback bind targets.
- Never accept a staging config that silently falls back to root `DATABASE_URL`.
- Keep database credentials and secret keys in server-only private environment configuration. Only the project URL and publishable key may be sent to the browser.
- Start/stop instructions and separate service/tunnel rollout plan are documented but **not executed**.
- Check safe local health responses and invalid configuration using automated tests.
- Root engagement tests and existing Social/PG17 regression checks remain green.
- No migrations in root `db/migrations`, no new Supabase project creation or hosted DB writes, no staging HTTPS origin/DNS/tunnel changes, no login emails sent.

## Deployment decision gate

A future action requires explicit selection of a Supabase staging project plus a reviewed SQL schema rollout and test accounts, with costs/security examined. The connected account has active projects named `Hermes Threads Media` and `postbro-core`, as well as inactive historical projects; none was established as the Social staging project in this task.

Run first via localhost and operator-authenticated SSH port forwarding, then only after review expose a separate HTTPS origin. Production must not change.

## Technical outline

- `apps/social-web/src/staging/config.ts`: pure env parser, accepted project URL and database endpoint must identify the **same** Supabase project ref, require strict TLS and loopback binding.
- `apps/social-web/src/staging/server.ts`: opt-in executable to create a Pool, construct isolated Fastify app, bind to loopback and implement graceful termination; no import from production `src/index.ts`.
- `apps/social-web/tests/staging-config.test.ts`: unit tests for misconfiguration, cross-project/unsafe URL rejection and valid direct/session pooler examples; health handler smoke.
- `apps/social-web/staging.env.example`: placeholders only, no secrets.
- `apps/social-web/STAGING.md`: clear prerequisites, local run commands, rollback and decision gates.

## Note

This is a **preparation-only PR**. CI green is not evidence that the Supabase stage, SMTP delivery, Cloudflare route or real clients work.
