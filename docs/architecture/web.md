# Step 07 Web

The browser uses one Preact root and an explicit view state. The wire client reads
Gateway’s public `/api/openapi.json` for operation paths and methods. It sends
same-origin cookies; no bearer token or Access assertion is stored or attached by
the browser. Cloudflare Access supplies the assertion to the Worker in production.
The local `tools/web-dev.mjs` fixture signs an assertion and injects it only in its
Node HTTP proxy. Neither that proxy nor its signing key enters `dist/worker.js` or
`dist/assets`. Start the local browser fixture with `pnpm build && node
tools/web-dev.mjs`; open `http://127.0.0.1:8789/`. The fixture migrates an
in-memory Miniflare database and seeds two owner workspaces and test tokens.
`pnpm test:web` runs the wire/state tests and Chromium browser suite. On a VM
without Playwright's supported browser archive, set `WEB_CHROME_PATH` to an
installed Chrome binary. CI uses the pinned official Playwright image.

Navigation: `/api/me` principal/workspace discovery → workspace selection → project
list → issue/wiki/activity/admin views. Typed drafts stay in
memory. On a lost response, the pending command keeps its IDs, version and payload
for an exact retry; a conflict keeps the draft and Wiki fetches the newer page
alongside it. Queries abort on workspace/project changes so old responses cannot
paint the new view. Markdown is sanitized after rendering.

The admin view reads paged members and OAuth clients and revokes a client through
Access. The activity view reads project-scoped sessions, live leases, latest
progress, file claims and WIP cap through Coordination. `/api/me` is the
non-workspace entry point; workspace and actor changes clear old view data.

The Web step also found that the REST-only `access.credential.issue/revoke`
operations had three-part names but Gateway and OpenAPI exposed only two-part
paths. The route and wire description now agree; MCP still excludes credentials.
`issues.list` failed on an omitted nullable `assigneeId`:
Gateway accepted null in JSON but a GET query cannot encode it. Its validation now
treats absent nullable fields as unfiltered. The browser suite covers this route.
Worker Static Assets are built to `dist/assets`, matching `wrangler.jsonc`.
