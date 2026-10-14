# CI image: pinned Node or Playwright base + pnpm + a pnpm store prefetched from the
# lockfile, so jobs skip the pnpm download and most of `pnpm install`.
# Build and push with tools/ci-image.sh; .gitlab-ci.yml pins the resulting tags.
ARG BASE
FROM ${BASE}
RUN npm install --global pnpm@10.18.0 --ignore-scripts \
  && pnpm config set store-dir /pnpm-store --global
WORKDIR /prefetch
COPY package.json pnpm-lock.yaml ./
RUN pnpm fetch && rm -rf /prefetch
WORKDIR /
