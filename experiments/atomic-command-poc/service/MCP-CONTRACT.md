# R10 dual-era MCP transport candidate

Baseline: reviewed selected PR7 overlay 94637dd4ae3690758671c46bab705260ec218b15. This is a tools-only Streamable HTTP implementation, not a deployment or real-Harness acceptance claim.

## Pinned protocols and primary sources

Checked 2026-10-08 against official specification pages:

- Modern 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning and https://modelcontextprotocol.io/specification/2026-07-28/basic/index
- Modern HTTP: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Modern discovery: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- Tools: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Legacy lifecycle: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Legacy HTTP: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

2026-07-28 uses per-request version/capabilities, mirrored method/name HTTP headers, server/discover and resultType=complete. No initialization or protocol session is required. clientInfo is optional in the normative base-fields table; examples showing it do not make it mandatory. Header mismatches use -32020, unsupported versions -32022, missing required metadata -32602, unknown methods HTTP404/-32601.

2025-11-25 uses initialize followed by notifications/initialized, with the selected protocol returned in InitializeResult. Unknown proposed versions negotiate to the supported legacy version; later unsupported version headers reject. Sessions bind to the verified principal, credential, workspace and current epoch. The adapter never uses clientInfo as authentication.

## Endpoint and capabilities

Existing /machine/v1/workspaces/{workspaceUUID}/mcp. POST handles requests. Both eras use JSON responses; no SSE stream, server-initiated request, sampling, elicitation, tasks or subscription is advertised. GET returns405 (expired/unknown legacy session404). Legacy DELETE removes the protocol session; modern DELETE405. No credential is created or saved.

Only tools are advertised. tools/list pages have at most16 definitions, deterministic names/order and versioned cursors. Commands import the established commandTools map; tool calls use executeCommand and the established query functions, including operation_get. Future integration of the separately reviewed SetResourceAccess map activates its exact descriptor without adding an authorization path. No stopped implementation is imported.

Input JSON Schemas use 2020-12. Descriptors expose the existing command envelope, payload fields and basic bounds; shared runtime validators remain authoritative for UTF-8 byte limits, cross-field conditions, CAS, workflow rules and authorization. No external schema references are fetched.

## Fixed bounds and security

- Input2MiB, strict UTF-8 and duplicate-key rejection, maximum nesting16 via existing strictJson parser
- Output4MiB including text fallback and structuredContent. This preserves a legal256KiB all-control-character Markdown body through both representations, without truncation
- JSON-RPC integer IDs must be safe integers; string IDs at most128 UTF-8 bytes
- Legacy sessions: at most64/workspace,4/principal+credential+epoch binding, fixed30-minute lifetime, no TTL extension. Restart/eviction means404 then reinitialize
- Body and outer request deadlines use existing operator configuration (body100ms–request deadline; request1–30s)
- Request Origin is validated for all methods. Both entry Worker and Store verify the established machine credential. Identity mapping, current credential/membership/expiry/fence and dispatch run under the existing Store transaction
- Discovery does not confer permission; every query and command retains current scope/resource/historic authorization. Revocation blocks discovery, ping, sessions, reads and writes
- No actor field is accepted in tool arguments; caller metadata is not consulted for identity or permission

## Exact recovery semantics

JSON-RPC id identifies an attempt. operationId remains the client-journaled UUID in the command envelope. A supplied HTTP Idempotency-Key must match it, but MCP clients need not supply that extra nonstandard header. REST and both MCP eras share fingerprints, CAS, original receipts and current receipt access checks. The adapter never retries commands.

A lost response, timeout, internal failure or oversized response remains outcome=unknown. Reinitializing a lost legacy session does not change operationId. operation_get or an exact same-envelope resend reconciles through the existing receipt. Cancellation never asserts rollback; already-committed synchronous work cannot be undone. Errors contain fixed safe messages/codes, no SQL, stack, credential or payload echo.

## Verification and limitations

New dependency-free Node protocol tests and native workerd service tests use synthetic signed Access JWT fixtures and mocked JWKS; unmocked network is denied. They cover dual-era discovery/calls, headers/version failures, session limits/expiry/restart/binding, malformed/oversized bodies, current revocation, REST/MCP replay,100 same-operation deliveries, principal identity, claims and byte preservation. Existing Wiki MCP tests were adapted only to send valid current transport headers/metadata; assertions remain unchanged.

The existing test:service glob includes both new suites; the existing full CI job can run them without new dependencies or workflow privilege changes. No local Chromium is used.

Real Access host/token exchange/OAuth/resource-server configuration, approved credential enrollment, live localdots/Harness connection, provider revocation latency and real network/proxy behavior remain unverified. Those are separate R10 acceptance gates. No deployment, external agent connection, Access modification or production migration is part of this candidate.

## Text duplication decision and budget comparison

Both pinned Tools specifications, Structured Content section, say serialized JSON in a TextContent block is a backwards-compatibility SHOULD, not MUST. This candidate retains full duplication when it fits4MiB. If duplication alone exceeds the cap, it replaces only the redundant TextContent copy with an explicit notice and retains the complete unchanged structuredContent. Initialization, modern discovery and query descriptions announce that large results require structuredContent. Both eras use this rule. Text-only compatibility for such results is not met; actual client acceptance remains unverified. No body-size limit or common domain page budget was reduced. The read-only client/mcp-query-port.mjs offers explicit textOnly mode (limit=1, one page per call, original cursor preserved, no automatic retries); it rejects the notice rather than treating it as an empty result.

The synthetic all-control-character fixture is3,408,160 wire bytes. The checkpoint02 Node serializer plus bounded client reader probe records median39.49ms/p9574.72ms and process peak RSS192,692KiB across20 iterations (evidence/mcp-checkpoint02-budget.json). The earlier checkpoint01 baseline was median27.9ms/p9538.1ms and RSS169,860KiB; timings vary and are not a fixed runtime guarantee. It includes client decoding and retained garbage; it is not an isolate memory or Workers CPU/load acceptance measurement. Concurrency, actual provider plan and actual client budgets remain open release gates.

## Invocation limits and production admission

No production rate defaults exist. An operator-owned MCP_RATE_LIMIT_CONFIG JSON must explicitly provide workspaceBurst, workspacePerSecond, identityBurst and identityPerSecond (positive integers1..1000, identity values no greater than workspace values). These validation ceilings bound configuration; they do not establish a safe production rate. Missing/invalid policy fails tools/call closed with503 MCP_RATE_LIMIT_CONFIG_REQUIRED. Release preflight requires an explicit valid policy. Capacity/CPU/memory/quota evidence for the exact configured policy must be independently approved before deployment; merely satisfying the parser/preflight is not that evidence.

Both eras share one invocation limiter. Separate current principal and credential token buckets intersect with the workspace bucket. Credential renewal cannot reset the principal bucket. Each identity map is capped at256 entries; idle entries expire after10minutes.429 contains Retry-After calculated from the exhausted buckets (or bounded identity-slot expiry). No automatic command resend is introduced. Counters are instance-local and reset on DO restart/eviction, so they are not durable quotas and cannot prove protection across restarts or multiple deployed instances. Production ingress limits/concurrency control and restart behavior remain acceptance gates. Synthetic tests alone use workspace128burst/50per second and identity100burst/25per second. No production setting was changed.

## Cursor and multi-record regression closure

Wiki’s signed title cursor now has one exported64KiB bound used by runtime and MCP descriptors. A legal4096-byte title can expand sixfold in JSON and then base64; the previous8192 runtime bound was insufficient for controls, as well as the previous2048 schema being insufficient for ASCII. Native tests roundtrip generated cursors for both ASCII and worst-control-escaped titles through both eras without modifying titles, signatures or ordering. Other query families retain their2048 contract.

Native regression tests also retain both legal control-character records (262144 and61000 source bytes) in a single domain page. Both eras deliver exactly the REST structured result under the4MiB limit, and the text-only one-row port can traverse both records with the original signed cursor.
