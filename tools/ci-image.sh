#!/bin/sh
# Build and push the optional prebuilt CI images (pnpm + a store prefetched from the
# lockfile). Registry and bases come from the environment, never from this repository:
#   CI_IMAGE_REPO   target repository, e.g. <registry>/<project>/projektor-ci (required)
#   NODE_BASE       default: the public Node image pinned in .gitlab-ci.yml
#   BROWSER_BASE    default: the public Playwright image pinned in .gitlab-ci.yml
# Then set the CI/CD variables CI_NODE_IMAGE and CI_BROWSER_IMAGE to the printed refs.
set -eu
cd "$(dirname "$0")/.."
: "${CI_IMAGE_REPO:?set CI_IMAGE_REPO}"
pinned() { sed -n "s/^  $1: //p" .gitlab-ci.yml; }
NODE_BASE=${NODE_BASE:-$(pinned CI_NODE_IMAGE)}
BROWSER_BASE=${BROWSER_BASE:-$(pinned CI_BROWSER_IMAGE)}
lock=$(sha256sum pnpm-lock.yaml | cut -c1-12)
for kind in node browser; do
  if [ "$kind" = node ]; then base=$NODE_BASE; var=CI_NODE_IMAGE; else base=$BROWSER_BASE; var=CI_BROWSER_IMAGE; fi
  tag="$CI_IMAGE_REPO:$kind-$lock"
  docker build --pull --build-arg BASE="$base" -f ci/Dockerfile -t "$tag" .
  docker push "$tag"
  echo "$var=$tag@$(docker inspect --format "{{index .RepoDigests 0}}" "$tag" | cut -d@ -f2)"
done
