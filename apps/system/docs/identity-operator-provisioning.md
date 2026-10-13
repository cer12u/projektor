# Private Identity operator provisioning

The private operator entry is `createIdentityOperator` in `src/adapters/d1/identity/operator-assembly.ts`. It composes pure Identity application/rules, specific receipt/read/atomic commit ports, a D1 binding, cryptographic effects and a named `SecureCredentialDelivery` port. It is not registered in HTTP, MCP, browser code or the application credential path.

An independently authorized operator host must inject the approved database binding and a secure destination implementing `storeCredential(CredentialEnvelope)`. The host is responsible for verifying the operator and approval scope before exposing this entry. Merely providing an operator ID does not establish that authorization. No default local filename, VM, process or storage provider is required or silently selected. The source does not install a production operator host or persistent credential store.

## Supported operations

- `provisionPrincipal(context, principal)` performs explicit principal creation with typed kind, display name, login policy and initial project rights. The private bootstrap path may create an explicitly approved human administrator. Agents cannot be assigned global administration by this input. Normal authenticated principal registration also exists through the Identity management application; neither route automatically enrolls a person or Agent.
- `issueCredential(context, credential, origin)` creates an individual Agent API credential, with the exact expected active principal auth version, expiration and grant subset. The commit atomically rechecks the target/version/time/membership conditions, writes the credential hash and grants, and records an immutable operation receipt. Immediately before delivery it rechecks current credential, principal version and membership/grant authority.

Context contains the approved operator ID, stable operation ID and explicit environment. Reusing an ID with changed normalized input fails. The historical canonical fingerprint encoding is retained, so existing receipts keep their identity.

Only a winning credential creation can reach secure delivery. Receipt recovery never generates or redisplays a token. A lost issuance acknowledgement must be queried/retried with the same operation; it must not create another credential automatically. No plaintext token is persisted in D1, operation receipts, logs or returned metadata. A failed delivery returns the confirmed receipt with `handoff_failed_revoke_and_reissue_explicitly`. The operator must separately authorize revocation and new issuance if needed; the application never guesses whether an external store accepted an ambiguous delivery and never automatically retries it. Current authority loss before delivery returns `delivery_not_authorized` without passing the secret to the destination.

## Reproducible synthetic example

Run `node tests/integration/d1/check-identity-operator-runtime.mjs` with the locked local dependencies. The example composes the actual private operator entry in disposable local workerd/D1. It provides an explicitly synthetic in-memory `storeCredential` implementation, creates one synthetic Agent and a scoped credential, then verifies that credential through the normal Identity API authentication application. The fixture does not expose tokens in its responses or evidence and does not call an external provider.

The same example verifies same-ID receipt recovery, changed-input rejection, concurrent one-winner delivery, failed handoff without automatic reissue, atomic scope/version/expiry rejection, late authority loss before delivery and receipt-write rollback. Separate pure tests check malformed input before persistence and unchanged receipt fingerprint encoding.

This establishes a usable dependency-injected operator code path and local behavior. It does not establish approval to run it against a real database, an installed secure store, real credentials, external store durability, provider renewal or cross-executor continuity. Those are explicit operational prerequisites, not promises inferred from an interface.
