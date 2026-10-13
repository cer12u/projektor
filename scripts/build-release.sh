#!/usr/bin/env bash
# @module repository.integration
# @role release-entry
# Build only the canonical app. No tag, upload, deployment or hosted migration.
set -euo pipefail
VERSION="${1:?usage: build-release.sh <version>}"
[[ "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release version' >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
npm --prefix apps/system run prepare:wasm
npm --prefix apps/system run build:verified
node scripts/stage-system-release.mjs "$VERSION"
