# Step 07 Web

The browser uses one Preact root and an explicit view state. The wire client reads
Gateway’s public `/api/openapi.json` for operation paths and methods. It sends
same-origin cookies; no bearer token or Access assertion is stored or attached by
the browser. Cloudflare Access supplies the assertion to the Worker in production.
The local `tools/web-dev.mjs` fixture signs an assertion and injects it only in its
Node HTTP proxy. Neither that proxy nor its signing key enters `dist/worker.js` or
`dist/assets`. Start the local browser fixture with `pnpm build && node
tools/web-dev.mjs`; open `http://127.0.0.1:8789/?w=web1`. The fixture migrates an
in-memory Miniflare database and seeds two owner workspaces and machine tokens.
`pnpm test:web` runs the wire/state tests and Chromium browser suite. On a VM
without Playwright's supported browser archive, set `WEB_CHROME_PATH` to an
installed Chrome binary. CI uses the pinned official Playwright image.

Navigation: known workspace ID → project list → issue/wiki/activity/admin views.
Recent workspace IDs are cosmetic `ui:*` localStorage values. Typed drafts stay in
memory. On a lost response, the pending command keeps its IDs, version and payload
for an exact retry; a conflict keeps the draft and Wiki fetches the newer page
alongside it. Queries abort on workspace/project changes so old responses cannot
paint the new view. Markdown is sanitized after rendering.

The Web view is limited by current Gateway contracts. Initial workspace discovery
requires a known ID because `access.workspaces` itself requires a workspace path.
Access has no member list REST route and OAuth clients have no list/revoke REST
routes. Coordination has no project-wide progress, file-claim or WIP-limit read
route, so activity reads the published per-issue and per-repo/session operations.
An external principal change cannot be observed reliably because Gateway exposes
no current-principal endpoint; reloading resets in-memory state. These contracts
need a later owner-approved Gateway change rather than private server imports.

The Web step also found that the REST-only `access.credential.issue/revoke`
operations had three-part names but Gateway and OpenAPI exposed only two-part
paths. The route and wire description now agree; MCP still excludes credentials.
`issues.list` failed on an omitted nullable `assigneeId`:
Gateway accepted null in JSON but a GET query cannot encode it. Its validation now
treats absent nullable fields as unfiltered. The browser suite covers this route.
Worker Static Assets are built to `dist/assets`, matching `wrangler.jsonc`.
