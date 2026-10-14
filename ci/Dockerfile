# CI image: pinned Node or Playwright base + pnpm + a pnpm store prefetched from the
# lockfile, so jobs skip the pnpm download and most of `pnpm install`.
# Build and push with tools/ci-image.sh, then point CI_NODE_IMAGE / CI_BROWSER_IMAGE at the result.
ARG BASE
FROM ${BASE}
ENV npm_config_store_dir=/pnpm-store
RUN npm install --global pnpm@10.18.0 --ignore-scripts \
  && pnpm config set store-dir /pnpm-store --global
WORKDIR /prefetch
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch && rm -rf /prefetch
WORKDIR /
