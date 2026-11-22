# PostBro Social — onboarding foundation (development only)

This package starts the Social application inside the existing public PostBro repository.

## Scope

- Starter/Growth plan selection and five-client pilot cap.
- Tenant-scoped brand intake in the existing server-side domain module; the browser preview is tenantless and local.
- Optional explicit consent for analysing historical posts (**no API calls implemented**).
- Draft persona review, edit/version invalidation and explicit approval.
- Minimal interface contract for consuming the existing **private Persona Engine** externally.

The original VPS prototype's responsive presentation is now adapted into `public/`.
Its temporary HTTP backend, demo authentication, and mock API routes have **not**
been copied. The browser preview deliberately does not call the server-side domain.
Existing Threads engagement API and Postiz remain untouched.

## Responsive onboarding preview

The original local UI's dark colors, sticky header, step indicators, responsive
cards and input fields have been adapted into `public/` without its loopback
demo login or mock HTTP endpoints.

The preview uses a small **in-memory browser-only state machine**:
Starter/Growth selection, required brand fields, optional historical-analysis
consent (default OFF), sample Persona V1, editing/revision and simulated approval.
It makes **no fetch requests**, stores nothing in localStorage/cookies, and never
produces a server-activated persona.

To try it without deploying or changing PostBro production:

```sh
cd apps/social-web/public
python3 -m http.server 8765 --bind 127.0.0.1
# Open http://127.0.0.1:8765 in a browser on the same machine.
```

Use a disposable test profile. This local static server is not suitable for
customer access or Internet exposure. Do not deploy it to the VPS yet.

## Invite-only client portal (development source)

Phase PB-SOCIAL-003B adds a separate, **non-deployed** portal under
`public/portal.html` and `public/portal.mjs`, plus the standalone API
`src/http/portal.ts`. It uses Supabase email OTP with self-registration
disabled, verified Auth identity and server-side PostgreSQL tenant RLS
transactions for agency-provisioned client profiles.

**Not wired into the existing Threads backend.** There is still no live customer
portal, real OTP test, or hosted database migration. Sessions live only in a
browser tab; signing out clears that memory, not the remote Supabase session.
The original `public/index.html` remains a separate local-only preview.

Read [PORTAL.md](PORTAL.md) for staging prerequisites and rollout gates.

## Checks

From repository root after installing root dependencies:

```sh
./node_modules/.bin/tsc -p apps/social-web/tsconfig.json
node --test apps/social-web/dist/tests/*.test.js
node --test apps/social-web/tests/*.test.mjs
```

The standalone portal HTTP/API and persistence adapter are implemented as isolated
source modules but are not started or connected to hosted Supabase. The original
in-memory preview store is **not appropriate for production**. Do not expose this
package to customers until staging authentication, RLS, rate limiting and tenant
isolation checks are completed.

The browser preview uses `LOCAL_TEMPLATE` and its simulated approval never
resolves as an active production persona. Separately, the server domain rejects
`MOCK_PREVIEW` from `getActivePersona()`. Real personas must come from the
private Persona Engine through a reviewed, authenticated adapter.
