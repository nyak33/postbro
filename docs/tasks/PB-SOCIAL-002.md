# PB-SOCIAL-002 — Bring responsive onboarding UI into PostBro monorepo

**Owner authorization:** 2026-11-22, "go" after PR #24 merged, to continue development of the existing responsive onboarding prototype.

## Objective

Migrate the previously developed **responsive onboarding interface** from isolated local scratch prototype into the public `nyak33/postbro` repository as an additive, reviewable module.

## Agreed MVP user experience

1. Show plan selection for Starter/Growth and explain the five-client pilot.
2. Let the user supply business name, niche, audience, preferred language/tone, brand restrictions and optional samples.
3. Present the **optional** "Analyze my existing posts" choice with explicit consent. Historical reading is not yet enabled.
4. Show a reviewable/editable proposed Persona V1 preview. Future product flow requires actual engine compilation and explicit client approval.
5. Make it obvious that this stage is a **local preview** with no permanent account, login, approval record or publishing action.

## Constraints

- **No deployment**, no live API calls, no Postiz/Meta integration, no production DB migrations and no production service changes.
- Keep the existing root Threads engagement API and its CI tests working.
- Do not put private Persona Engine code into this public repo. Any mock previews must be clearly marked and must never turn into a usable active persona.
- Reuse/adapt the existing local prototype's design rather than create an unrelated interface from scratch.
- Prefer a lightweight responsive UI without adding unnecessary frameworks/dependencies.
- Do not rely on localStorage as a surrogate for secure customer persistence.
- Preserve safe input handling: use textContent, no untrusted innerHTML and no credential handling in static preview.

## Acceptance checks

- Responsive mobile and desktop onboarding steps render.
- Required fields validated and optional consent defaults off.
- Persona review/edit preview works, including reset after intake modification.
- A dry-run approval is clearly labelled "preview only", never production approval.
- UI contains no demo auth endpoints, tokens, API secrets, payment links or actual social account connects.
- Automated smoke tests and existing root CI pass.
- Changes only to development-only `apps/social-web/` paths, docs and necessary CI checks; PR remains reviewable.

## Follow-up tasks (NOT part of this PR)

- PB-SOCIAL-003: Secure login and durable client-owned data with DB-level isolation.
- PB-SOCIAL-004: Connect existing private Persona Engine via reviewed API/adapter; build immutable approved persona versions.
- PB-SOCIAL-005: Verify Postiz client-organization mapping and approval-before-scheduling integration.
