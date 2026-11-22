# PostBro Social — onboarding foundation (development only)

This package starts the Social application inside the existing public PostBro repository.

## Scope

- Starter/Growth plan selection and five-client pilot cap.
- Tenant-scoped business/brand intake.
- Optional explicit consent for analysing historical posts (**no API calls implemented**).
- Draft persona review, edit/version invalidation and explicit approval.
- Minimal interface contract for consuming the existing **private Persona Engine** externally.

The previous standalone VPS prototype was NOT automatically incorporated by this commit.
This is a small verified foundation; integrate its UI after review, avoiding duplicate
business logic. Existing Threads engagement API and Postiz remain untouched.

## Checks

From repository root after installing root dependencies:

```sh
./node_modules/.bin/tsc -p apps/social-web/tsconfig.json
node --test apps/social-web/dist/tests/*.test.js
```

No HTTP server, authentication, persistence or Postiz API integration exists here yet.
The in-memory store is **not appropriate for production**. Do not expose this package
to customers until secure login, persistent tenant-scoped storage, rate limiting and
database-level isolation tests are implemented.

The `MOCK_PREVIEW` persona source can be reviewed for demos but will never
resolve as an active persona. Actual personas must be sourced from the private
Persona Engine through a reviewed external adapter.
