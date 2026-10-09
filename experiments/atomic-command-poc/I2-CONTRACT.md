# I2 core ports and fixed contract

I1 ports are inherited; this file describes only the I2 additions. All mutations execute inside executeResourceCommand on the same workspace DB. Current authentication/epoch first, then own read-authorized receipt, then new-operation permission/CAS/domain checks. A receipt after expiry/release is an old result, never proof of a live lease. Fresh stores use service schema v4; v3 is rejected, not silently migrated.

## Commands

Envelope schemaVersion=1 and command-json-v1 unchanged. No client actor is accepted. Existing I1 payloads stay frozen without added payload fields; discovery labels their payload version 1 as implicit-frozen-I1. New commands require payload.payloadVersion; unknown version gets CAPABILITY_MISMATCH. WORKFLOW_REGISTRY is the validator/discovery source.

- Issue.Claim, payloadVersion 1: {runtimeInstanceId,attemptId,agentDefinition:{id,revision},expectedClaimVersion}. Outer expectedVersion is Issue CAS. Each successful attempt ID is globally unique in the workspace forever, even after expiry/release. Claim ID fresh, fence increasing decimal string (up to 78 digits), runtime UUID and principal bound independently
- Issue.RenewClaim, version 1: {claim}. Outer CAS is claim slot version; exact principal/runtime/attempt/fence/epoch and unexpired lease required. Renew at serverNow >= renewNotBefore; expires at now+300000, renew not before now+100000
- Issue.ReleaseClaim, version 1: {claim,reason:string}. Nonblank reason <=4096 UTF-8 bytes. Retains slot tombstone/fence and immutable attempt. Does not change Issue status
- Issue.AppendProgress, version 2: {entryId,bodyMarkdown,reason?,result?,claim?,effectCheckpoint?}
- Issue.Transition, version 2: {entryId,toStatus,reason?,waitingFor?,nextStep?,result?,claim?}
- Issue.Reparent, version 1: {parentId,expectedParentVersion?}; same-project parent CAS, cycles/depth32 checked atomically; bounded tree 100 for this normal operation
- Issue.MoveTree, version 1: {targetProjectId,targets:[{id,expectedVersion}]}; root must have no parent, complete descendants <=100, every current ACL/version and both project grants checked before effects. Allocates destination numbers and retains old project/number aliases. Receipt requires all current and original target scopes

ClaimRef = {claimId,fencingToken,runtimeInstanceId,attemptId}. Progress/transition machine actors need current issue read/write, operation scope, claim:write and exact live ClaimRef. Human progress/status rejects supplied claim and requires no lease. Normal body/comment/assignment/priority/parent edits retain CAS and do not require claim. Claims never grant PC execution, external send, credential, delegate or artifact access.

Progress reason={text,code?}; result={summary?,artifactIds:[]}. Aggregate body/reason/result summary/waitingFor/nextStep max 256KiB UTF-8; bytes preserved. Artifact IDs nonempty are ARTIFACT_CAPTURE_UNAVAILABLE until separately reviewed I4 integration. No URL is treated as captured artifact evidence. Progress/transition body is represented once in read results, preventing maximum-size JSON expansion from overflowing bounded pages.

Native done/canceled/reopened records are immutable exact/server-time/native_transition. Reopen clears current resolution columns without changing old records. Resolution chronology uses commit changeSeq then ID, not random UUID order for same-millisecond transitions. Parent done rejects unresolved or unknown-state children. Historical progress/transition and resolution reads apply historicRead; ordinary current comments retain I1 current-read behavior.

## External effect checkpoints

Optional effectCheckpoint on AppendProgress v2 is {effectId:UUID,state:external_outcome_unknown|reconciled,reference:nonblank string <=4096 UTF8 bytes}. This records the client assertion/evidence reference; it does not verify a destination receipt, fetch, retry or execute an external effect. Runtime approval and destination reconciliation remain independent responsibilities.

At most 64 unique effect IDs per Issue (lifetime); a known ID cannot be reintroduced as a new unknown. Each unknown can have one later explicit reconciliation. This bounds the complete query to at most 64 current states/128 immutable rows, including worst-case escaping. The 65th unique ID fails EFFECT_CHECKPOINT_LIMIT. This operational bound is advertised; exceeding it requires a reviewed future checkpoint design, never silent deletion.

Current claim or new attempt alone does not clear unknown. Done is blocked by any current unknown. Reconcile requires historicRead for original unknown and latest checkpoint and preserves original attempt, while the new progress author/attempt identifies the reconciler. Query checks all original/latest ACLs before returning any effects or aggregate blocked flag; no page-one safety inference. Unreadable source evidence yields CHECKPOINT_ACCESS_REQUIRED even if current resource ACL widened.

## Queries and surfaces

Shared exports: queryClaim, queryResolutionRecords, queryAttemptCheckpoint, queryCapabilities, queryIssueAlias. Thin MCP names: claim_get, resolution_records_list, attempt_checkpoint_get, capabilities_get, issue_alias_get. Existing commandTools adds the seven workflow names.

Product HTTP: existing /commands, /issues/{id}/claim, /issues/{id}/resolutions (paged), /issues/{id}/checkpoint (complete bounded), /capabilities, /projects/{projectUuid}/issues/{positiveNumber}. Machine routes use /machine/v1/workspaces/{uuid}; human routes use /v1/workspaces/{uuid}. UUID/number alias resolves stable ID only under original project and current Issue permission. Original legacy project-key deployment URLs still require migration mapping.

Claim query live compares current workspace epoch. currentWriteAllowed is a momentary current permission hint, not an execution grant. Discovery authzVersion changes on principal/credential scope mutations and existing ACL changes. Shared commands always reauthorize regardless of cached discovery.

## Client and unfinished integrations

MachineWorkflowClient requires an injected trusted transport and durable journal. Persist-before-send failure prevents dispatch. Lost/invalid result remains unknown; not_observed never authorizes a new ID. A restart cannot dispatch old-runtime bound work. Pause/partition/clock rollback or conservative lease deadline stop new work. Resume reads current profile, claim, checkpoint and Issue state. No external tools or real credentials run here.

This small coordinator reconciles unknown and deliberately does not implement automatic resends; it does not claim the full persistent 1/3/10s Retry-After coordinator. Production limiter/reserved renewal headroom, server discovery of runtime-configured deadlines, maximum in-flight policy, complete negotiated client retry budgets and production perimeter/provider/MCP SDK/local dot connector remain I5 acceptance gates. DeepSeek Harness remains NOT_RUN/Pending. Browser protocol coverage is configured for exact-head approved CI; local Chromium is not claimed.

No I4 capture integrated, no populated v3 migration/import, no I3 Wiki/link integration, no production UI completion, no capacity/independent restore/writer cutover/deploy approval gate passed by this slice.

Client helper limitation: execution resumption intentionally refuses an unresolved external checkpoint or non-executable task state. A separate control/recovery-write helper for Renew/Release/reconciliation while execution is paused is NOT integrated here; those shared DB/HTTP commands remain available to an independently authorized caller. This helper is not a fully resumable connector. Revalidation generation guards prevent a late success from undoing pause/revocation, dispatch rechecks after journal awaits, and only complete bound success receipts settle committed. Independent six-case client counterexamples are retained in the publication suite.

Durable journal injection additionally requires listUnresolved(): it must enumerate prepared/unknown records across restarts. Revalidate fails closed if this inspection is missing, any unresolved record exists, or in-process unknown has not been successfully reconciled and persisted. Post-dispatch invalid response/storage failure pauses before another await. Production journal security/storage and bounded transport are integration responsibilities, not supplied by the in-test Map adapter.
