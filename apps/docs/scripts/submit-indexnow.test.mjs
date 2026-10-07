import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { submitIndexNow } from "./submit-indexnow.mjs";

for (const repository of ["cer12u/projektor", "other/projektor", "", "TAJD/projektor-copy"]) {
  test(`does not read or submit the upstream sitemap from ${repository || "an unknown repo"}`, async () => {
    const forbidden = () => assert.fail("must skip before any file/network access");
    assert.deepEqual(await submitIndexNow({
      repository, readSitemap: forbidden, fetchImpl: forbidden, log: () => {},
    }), { skipped: true });
  });
}

test("preserves the original upstream submission with case-insensitive repository names", async () => {
  let calls = 0;
  const result = await submitIndexNow({
    repository: "TAJD/projektor",
    readSitemap: () => "<urlset><url><loc>https://tajd.github.io/projektor/</loc></url></urlset>",
    fetchImpl: async (endpoint, options) => {
      calls++;
      assert.equal(endpoint, "https://api.indexnow.org/indexnow");
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      assert.equal(body.host, "tajd.github.io");
      assert.equal(body.keyLocation, `https://tajd.github.io/projektor/${body.key}.txt`);
      assert.deepEqual(body.urlList, ["https://tajd.github.io/projektor/"]);
      return { ok: true };
    },
    log: () => {},
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { skipped: false, submitted: 1 });
});

test("does not suppress an upstream submission failure", async () => {
  await assert.rejects(submitIndexNow({
    repository: "tajd/projektor", readSitemap: () => "<urlset/>",
    fetchImpl: async () => ({ ok: false, status: 503, statusText: "Unavailable" }),
    log: () => {},
  }), /IndexNow submission failed: 503 Unavailable/);
});

test("the fork and an unset repository CLI skip without a built sitemap or network access", () => {
  for (const repository of ["cer12u/projektor", undefined]) {
    const env = { ...process.env };
    if (repository) env.GITHUB_REPOSITORY = repository;
    else delete env.GITHUB_REPOSITORY;
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./submit-indexnow.mjs", import.meta.url))], {
      env, encoding: "utf8", timeout: 3000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /Skipping IndexNow/);
  }
});

test("the Docs workflow gates inherited indexing and canonical CI runs these regressions", () => {
  const docs = readFileSync(new URL("../../../.github/workflows/docs.yml", import.meta.url), "utf8");
  assert.match(docs, /if: \$\{\{ github\.repository == 'TAJD\/projektor' \}\}\s+run: node scripts\/submit-indexnow\.mjs/);
  const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /run: node --test apps\/docs\/scripts\/submit-indexnow\.test\.mjs/);
});
