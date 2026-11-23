# PB-SOCIAL-004B — Private Persona Engine CLI Adapter (development source only)

## Goal

Integrate the existing **private** `nyak33/postbro-persona-engine` through a
small, safe adapter in public PostBro. Use it to produce a structured
**external-engine** Persona V1 draft from already verified client brand inputs.

The existing private engine supports `session create`, `session patch`,
`persona finalize` and `persona compile` JSON CLI commands, with
`--data-dir` parameter. Its quick interview accepts a patch that supplies
the required fields. No private repository files are copied into public PostBro.

## Scope

- `apps/social-web/src/persona/private-cli-adapter.ts`: `execFile` a
  specifically configured compiled private CLI executable through Node 22.
  Uses `shell: false`, bounded runtime/output, unique temporary data dir
  per run, cleanup, limited environment, strict response shape validation.
- Convert verified brand input into the private engine's public Quick
  `PersonaPatch` contract. Do not use AI generation to invent claims.
- Return a **non-active** `EXTERNAL_ENGINE` draft with review fields and
  captured private PersonaRecord; do not approve or schedule content.
- Unit test success, missing input, malformed CLI JSON, refused finalize,
  process error, cleanup, command argument safety and no private source
  copied.
- Keep the adapter unregistered in live Threads backend and web routes.
  An agency-only trusted job will later call it and store draft after
  revision-matched DB checks, in a separate phase.

## Non-goals / security

- No live database operations, Auth token calls, emails, VPS processes,
  Postiz actions, project-wide secrets or public client generation route.
- No source code from the private engine in this repo.
- No `spawn(..., shell: true)`, no user-supplied arbitrary filesystem path,
  no global JSON FileStore shared across customers.
- Temporary data is discarded after each run; full versioned PersonaRecord
  must be persisted durably to DB by a separately reviewed trusted worker
  before real use. A private CLI file path is operator configuration only.

## Acceptance

Node+TypeScript/CI all pass; mock-runner test proves exactly create -> patch
-> finalize with a unique temp directory, cleans it even if CLI fails, and
rejects incomplete or fake engine responses. Unconnected adapter must not
create an active persona, request approval, or send anything publicly.
