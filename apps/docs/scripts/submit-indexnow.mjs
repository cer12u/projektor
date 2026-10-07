/**
 * Submits the docs site's sitemap URLs to IndexNow so Bing, Yandex, Seznam, and
 * Naver pick up changes without waiting for their next crawl.
 *
 * Google does not consume IndexNow — its indexing is driven separately via
 * Search Console sitemap submission (see astro.config.mjs's google-site-verification tag).
 *
 * Runs after `astro build`, once dist/sitemap-0.xml exists.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sitemapPath = join(here, "..", "dist", "sitemap-0.xml");

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const BASE_URL = "https://tajd.github.io/projektor";
// Not a secret: an IndexNow key only proves control of the site (by being
// reachable at <BASE_URL>/<KEY>.txt), so committing it alongside the public
// key file is fine.
const KEY = "b26e02e50344f7981441dd8c4abd5cc8";

// This inherited endpoint/key belongs to the upstream site. A fork must not
// announce upstream URLs. Keep forks (and unknown local invocations) offline
// until their own published destination and indexing setup have been verified.
export async function submitIndexNow({
  repository = process.env.GITHUB_REPOSITORY,
  readSitemap = () => readFileSync(sitemapPath, "utf8"),
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (repository?.toLowerCase() !== "tajd/projektor") {
    log("Skipping IndexNow: the inherited indexing destination is upstream-only.");
    return { skipped: true };
  }

  const xml = readSitemap();
  const urlList = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

  const response = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: new URL(BASE_URL).host,
      key: KEY,
      keyLocation: `${BASE_URL}/${KEY}.txt`,
      urlList,
    }),
  });

  if (!response.ok) {
    throw new Error(`IndexNow submission failed: ${response.status} ${response.statusText}`);
  }

  log(`Submitted ${urlList.length} URL(s) to IndexNow.`);
  return { skipped: false, submitted: urlList.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  submitIndexNow().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
