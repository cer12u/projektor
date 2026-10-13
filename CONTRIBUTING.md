# Contributing

The upstream Projektor is Thomas Dickson's personal project, built with AI agents
and released under the [MIT license](LICENSE). This repository is a Fork carrying
out the modular rewrite described in [the approved plan](docs/architecture/rewrite-plan.md).
Upstream authorship and history are retained; this Fork's changes and reviews are
managed in GitLab.

Use one bounded module branch/MR, follow [AGENTS.md](AGENTS.md), and run
`pnpm verify` before requesting review. Do not restore the previous implementation
or claim that this scaffold is a deployable replacement. For vulnerabilities,
follow [SECURITY.md](SECURITY.md) and report privately.
