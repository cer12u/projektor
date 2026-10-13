# Current application documentation

- [Architecture specification](architecture-spec.md): authoritative design.
- [OpenAPI](openapi.json): generated current HTTP contract; `npm run docs:generate`.
- [Deployment](deployment.md): local builds, private configuration, migration and rollback boundaries.
- [Repository integration scope](../../../docs/system-integration.md): retained legacy features and data limitations.
- `openapi-base.json` and `execution-openapi-fragment.json`: generation inputs.
- `wasm-provenance.json`: fixed upstream cryptographic binary provenance.
- [A1–A12 acceptance baseline](history/acceptance-baseline.md): public hostname-redacted reference; original requirements are not relaxed by source publication.
- `history/migrations/`: retained historical proposals, never part of the canonical migration runner.

Historical operational reports and private provider observations are not public source inputs. Old acceptance documents and evidence remain in the previous local deliverable; they do not override the current architecture specification.
