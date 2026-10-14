#!/bin/sh
# Build and push the CI images to Harbor (needs `docker login harbor.vp25.home`).
# Rerun after a lockfile, Node, Playwright or pnpm change, then update the tags
# in .gitlab-ci.yml. A stale store still works: pnpm downloads only what is missing.
set -eu
cd "$(dirname "$0")/.."
repo=harbor.vp25.home/tkdev/projektor-ci
lock=$(sha256sum pnpm-lock.yaml | cut -c1-12)
node_base=harbor.vp25.home/dockerhub/library/node:22.22.1-bookworm@sha256:f90672bf4c76dfc077d17be4c115b1ae7731d2e8558b457d86bca42aeb193866
browser_base=mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d
for kind in node browser; do
  if [ "$kind" = node ]; then base=$node_base; else base=$browser_base; fi
  tag="$repo:$kind-$lock"
  docker build --pull --build-arg BASE="$base" -f ci/Dockerfile -t "$tag" .
  docker push "$tag"
  echo "$kind: $tag@$(docker inspect --format "{{index .RepoDigests 0}}" "$tag" | cut -d@ -f2)"
done
