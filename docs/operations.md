# Operations: configuration lives outside the repository

This repository is published as-is (it is also mirrored to a public GitHub repository).
It must not contain values that belong to one installation:
- registries;
- account, zone or resource IDs;
- hostnames;
- workers.dev subdomains;
- Access team domains or audiences;
- secrets.

Those values are supplied as GitLab CI/CD variables, or by deploy-time configuration that a job generates from them.
`pnpm check:literals` (run in the `static` job and in `pnpm verify`) enforces this.

## CI/CD variables

| Variable | Protected | Masked | Purpose |
|---|---|---|---|
| `CI_NODE_IMAGE` | no | no | Optional prebuilt Node CI image. Without it, the pinned public `node` image is used and pnpm is installed per job. |
| `CI_BROWSER_IMAGE` | no | no | Optional prebuilt Playwright CI image. Without it, the pinned public Playwright image is used. |
| `FORBIDDEN_LITERALS` | no | no | Comma-separated installation-specific strings (internal domains, registry names, account handles) that `check:literals` must reject. Keeping the list here keeps it out of the repository. |
| `CLOUDFLARE_API_TOKEN` | yes | yes | Token for the verify smoke, the inventory and the deploy. |
| `CLOUDFLARE_ACCOUNT_ID` | yes | yes | Cloudflare account. |
| `CF_VERIFY_NAME` | yes | no | Optional name of the verify Worker, D1, KV and R2 (default `projektor-verify`). |
| `CF_VERIFY_RATELIMIT_IDS` | yes | no | Optional `register,token,feedback` rate-limit namespace IDs for the verify Worker (default `1001,1002,1003`). Rate-limit namespaces are account-wide, so pick IDs that no other Worker uses. |
| `CF_ZONE_NAME` | yes | no | Optional zone that the inventory job inspects for Worker routes. |

Production deploy variables are added together with the deploy job.

## Prebuilt CI images
`ci/Dockerfile` adds pnpm and a store prefetched from `pnpm-lock.yaml` to the pinned public bases.
1. Build and push the images with `CI_IMAGE_REPO=<registry>/<project>/projektor-ci tools/ci-image.sh`.
2. Set `CI_NODE_IMAGE` and `CI_BROWSER_IMAGE` to the printed digests.
3. Rebuild after a lockfile, Node, Playwright or pnpm change. A stale store still works, because jobs install with
   `--prefer-offline`.
