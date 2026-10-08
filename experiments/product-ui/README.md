# Projektor I5 product view adapter

React + TypeScript + Vite, with the reviewed I2 client protocol reused unchanged.
This is a source checkpoint, not a release-ready production application.

## Build and checks

- Node >=24.19.0
- npm ci --ignore-scripts
- npm run verify
- npm run test:e2e (only the approved PR Chromium environment)

The production build is dist/. It intentionally has no fixture issuer or default
workspace. The separate fixture build is dist-fixture/ and must not be deployed.

Core fixture tests locate ../projektor_agent_workflow_20261008/experiments/atomic-command-poc by default.
For repository integration beside experiments/atomic-command-poc set:
PROJEKTOR_CORE_SOURCE=../atomic-command-poc npm run test:e2e

No secrets or authentication tokens are expected in that variable.

## Dependency provenance

Registry metadata was read from official registry.npmjs.org on 2026-10-08:
react/react-dom 19.3.0, @types/react and @types/react-dom 19.3.0,
vite 8.3.3, TypeScript 5.9.3, Playwright 1.62.1 (existing I2 pin).
Exact versions and integrity hashes are in package-lock.json.
Lifecycle scripts were disabled for installation; the tested build uses packaged
platform binaries. No additional router, CSS framework, state store, auth SDK or
Markdown HTML renderer is introduced.

Primary framework references:
- https://react.dev/learn/build-a-react-app-from-scratch
- https://react.dev/versions
- https://vite.dev/guide/

## Port ownership

src/contracts.ts describes the UI-facing boundary. It is not an independently
invented service wire schema. The session/key owner maps authenticated service
responses into these fields. src/product-ports.ts maps the explicit session-owner service client; missingProductPorts remains a negative test fixture. Endpoint failure is fail-closed.

Four vendor modules are byte-identical frozen I2 dependencies. vendor/client/issue-content.mjs is the reviewed shared manual-recovery patch, SHA-256 5881771e1d14a42a8c9d5073947bf34b40ac7d29cdd524a283cda26188264f99. Two session-ports modules are byte-identical owner checkpoint dependencies. No local protocol fork is maintained. They are not
forked domain implementations. On repository integration, replace the vendor
paths with the equivalent frozen shared package or keep the copies with hashes;
never modify a second auth, transport, receipt, encryption or Store implementation.

## UI security

- Canonical plaintext is displayed through React text nodes, never innerHTML
- All mutations go through the reviewed coordinator, which retains one journal
- No entity text, credentials or tokens in URL/localStorage
- Latest protected draft required before in-app navigation
- Hidden/pagehide/session-change views remove plaintext synchronously
- Fresh verified session/resource access precedes restored plaintext
- Invalid workspace/deep link never silently falls back to another workspace
- Product and synthetic fixture entrypoints are distinct

See ACCEPTANCE.md for every deliberately unclosed gate and PROGRESS.md for checks.
