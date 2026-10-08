# Browser DraftVault / recovery slice

Status: implementation candidate, **actual browser execution pending CI**. Local
Chromium 154.0.8037.57 cannot launch in this executor (Unix socket EPERM). That
failed prerequisite is not a browser pass. Runtime acceptance remains pending CI.

## Scope and contracts

This isolated Issue title laboratory extends the frozen authenticated transport
candidate. It does not claim full Issue/comment/Wiki UI, production provider
renewal, production key backup/rotation, multi-workspace product navigation,
WCAG compliance, real IdP redirects, or actual bfcache restoration.

- `draft-vault.mjs`: browser IndexedDB and non-extractable WebCrypto AES-256-GCM
  keys. Random 96-bit IV for each write, canonical binding/metadata AAD, digest
  inside encrypted payload, read-back/decrypt verification, 7-day retention
  metadata. Neither credential, raw key nor plaintext digest is persisted.
- Server-issued keys bind actor/workspace/epoch/resource/editor/draft/protection
  project. Key issuance checks current and original project read. Lease is capped
  by five minutes and actual signed/DB credential expiry.
- Encrypted payload includes exact editor revision, acknowledged revision,
  operation envelope and retry counters/floor/deadline, plus recovery manifest.
  Reload reconciles receipts and current authorized resource before display. It
  does not automatically submit an unsent draft.
- Actor/session/epoch guards prevent late results from unlocking or acknowledging
  another context. Page hide/visibility hide lock the DOM synchronously; show
  revalidates. A BroadcastChannel notification triggers server checks and is not
  accepted as authorization. Logout has durable session tombstones; shared-device
  discard also increments a principal deletion generation to fence stale writers.
- Cross-tab writes use the head the editor actually observed, plus transaction
  CAS. A conflicting branch is preserved in memory and fails protection instead
  of overwriting another tab's protected text.
- Autosave debounce is 150ms. Flush/readback must succeed before recovery
  navigation. Storage/key/crypto failures remain visible and block navigation.
  A no-op navigation has a five-second watchdog; a thrown navigation callback
  settles immediately. The laboratory recovery manifest uses only its fixed `/`
  return route; it is not a general-purpose redirect validator/provider adapter.
- Sent snapshots alone are acknowledged; later edits survive. Fully acknowledged
  old text adopts a newer authorized server revision; dirty newer text remains
  a conflict. Failed key/cipher restore is quarantined from overwrite.

## Reproduce in a supported runner

From `experiments/atomic-command-poc`:

    npm ci
    npm run test:all
    node --test browser-test/fixture-authz.test.mjs
    npx playwright install --with-deps chromium
    npm run test:browser

Use `CHROMIUM_PATH=/path/to/chromium` only when explicitly selecting an installed
browser. Default uses the pinned Playwright browser. Node >=24.19.0 is required.
Run Miniflare via `.mjs`, not Node eval/`--input-type` (its proxy worker inherits
those flags). The fixture creates ephemeral local signing keys and SQLite DO;
no production provider credential, persistent service access or deploy is needed.

The fixture's controls and synthetic login are private Node helpers. Public
loopback routes remain signed-cookie authenticated; no test control HTTP route
is exposed. The harness binds loopback only. Do not deploy test fixture classes.

## Evidence boundaries

`evidence/browser-baseline-all.log`: 129 existing regressions passed unchanged.
`evidence/browser-fixture.tap`: new HTTP-only fixture tests (not browser proof).
`evidence/browser-local-blocked.log`: local browser prerequisite failure.
CI must establish actual browser results and upload screenshots before this
slice can be called verified. Back-navigation tests are actual browser history;
synthetic `pagehide/pageshow` tests are explicitly synthetic and do not prove
browser bfcache behavior. Crash-before-debounce input and malicious copying of
previously authorized plaintext/keys cannot be recovered or remotely erased.
