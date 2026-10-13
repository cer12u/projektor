# Security policy

Report vulnerabilities **privately**, including the affected commit, impact and
reproduction steps. For upstream Projektor, the upstream maintainer's reporting
address is **tajdickson@protonmail.com**. For this Fork's code or deployment,
contact the Fork operator through an established private channel; do not assume
the upstream maintainer operates this Fork. Allow time for a fix before disclosure.

This rewrite is currently **non-deployable**. Access implements assertion
verification, scoped machine credentials, MCP OAuth authorization commands and live
workspace authorization as a module API. It has no business/OAuth HTTP endpoints or supported
migration path from existing deployments. See the [Access contract](docs/architecture/access.md)
for credential handling, bootstrap capabilities and admission-time revoke semantics. The old implementation's security
claims and operational instructions do not describe this branch.

Module ownership checks prevent accidental coupling; they are not a sandbox for
hostile code in the same Worker. Changes to the registry, checker, generated
catalog or CI require review together. Never commit credentials, `.dev.vars`,
browser sessions or real user payloads. Test/build artifacts contain synthetic
fixtures only. Real Cloudflare smoke and deployment remain disabled until their
resources, access and behavior have been approved and tested.

Deleting old source leaves existing deployed resources and data untouched.
