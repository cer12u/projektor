# Read-only prerequisite adapter

The read collector is implemented in `prerequisite-reader.mjs` and composed by the official Wrangler adapter. It uses only `https://api.cloudflare.com/client/v4/accounts/{configured-account}`. Account, Worker, database and hostname are bound once from validated private configuration; action inputs cannot substitute another target or SQL command.

## Closed read set

- GET Worker deployments: exact single current version at100%, bracketed around every scan.
- GET `/workers/services/{worker}`: exact `default_environment.script` source/tag/migration fields used by pinned Wrangler's own preupload path.
- GET Worker settings: placement, usage_model, tags, tail_consumers, logpush and observability.
- GET Workers domains: selected routing-ownership fields id/hostname/service/environment/zone_id/zone_name, filtered by configured Worker or hostname and sorted by id. Certificate state is not claimed equivalent.
- GET Access applications and policies: only applications whose domain matches the configured hostname, selected application metadata plus complete policy predicates. Returned evidence contains hashes, not identities/policy bodies.
- POST configured D1 query endpoint: a constant read-only SELECT/PRAGMA command for ledger, gate, integrity and security-relevant0018/0019 sqlite_schema definitions. No request/body-derived SQL or DDL/DML is reachable.

`schema-contract.json` is generated from the actual canonical migration bytes applied to empty local SQLite. All migration hashes are checked before reads. SQL definitions preserve content except outer trim and CRLF normalization. Same-name no-op triggers or non-unique indexes fail.

## Transport and error contract

Node24.19.0 must start with `--use-env-proxy`; the inverse flag is rejected. The existing HTTP(S) proxy and CA configuration are retained, with target bypass and TLS weakening rejected. Redirects, changed response URLs,401/403, explicit authorization errors, TLS errors and opaque refusals are terminal. Only recognized transient transport failures or429/500/502/503/504 receive up to three spaced read retries (1,2,4 seconds), bounded by a90-second observation deadline. Reads are not token renewal.

Responses are bounded to4MB, parsed strictly and never logged raw. Two matching normalized scans are required. No Worker source, secret values or business bodies are read. Credential values remain only in the authorized execution context/standard request header and never enter the use case or journal.

## Compatibility evidence and limits

Official Wrangler4.149.0 is pinned by launcher SHA256 `780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77` and CLI bundle SHA256 `31866b9a3686777254819158e60ebe4920d1d91141cde68846c62b52f75d7a66`. The exact service GET/default_environment branch appears in that bundle at180442–180455 and169667–169678. This is a pinned legacy CLI dependency, not a claim of a stable public service API. Changed source or response shape stops.

The ordinary read APIs are documented at [Cloudflare API](https://developers.cloudflare.com/api/). Deployment roles are described in [Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/). A Worker-only deployment role does not imply Access, domains or D1 query rights. The kit does not create or expand any permission.

Local deterministic tests establish parsing, guards, proxy CONNECT/default-TLS rejection and no-mutation behavior after failed proof. They do not establish real provider permission coverage, platform secret substitution, owner eligibility, durable journals, production data completeness or successful rollout.
