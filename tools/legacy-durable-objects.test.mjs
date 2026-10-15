import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

test("retired Durable Object exports preserve both namespaces' stored data", async () => {
  const fixture = `
    class Fixture {
      constructor(state) { this.state = state; }
      async fetch(request) {
        if (request.method === 'POST') await this.state.storage.put('retained', 'old-data');
        return new Response(await this.state.storage.get('retained'));
      }
    }
    export class WorkspaceHub extends Fixture {}
    export class RateLimiter extends Fixture {}
    export default { fetch() { return new Response('fixture'); } };
  `;
  const options = {
    name: "legacy-preservation-test",
    modules: true,
    compatibilityDate: "2026-07-30",
    durableObjects: {
      HUB: { className: "WorkspaceHub", useSQLite: true },
      LIMITER: { className: "RateLimiter", useSQLite: true },
    },
  };
  const mf = new Miniflare({ ...options, script: fixture });
  const fetchObject = async (binding, method = "GET") => {
    const namespace = await mf.getDurableObjectNamespace(binding);
    return namespace
      .get(namespace.idFromName("existing"))
      .fetch("https://object.test/", { method });
  };
  try {
    for (const binding of ["HUB", "LIMITER"]) await fetchObject(binding, "POST");
    const bundle = await build({
      entryPoints: ["apps/worker/index.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    await mf.setOptions({ ...options, script: bundle.outputFiles[0].text });
    for (const binding of ["HUB", "LIMITER"]) {
      assert.equal((await fetchObject(binding, "POST")).status, 503);
    }
    await mf.setOptions({ ...options, script: fixture });
    for (const binding of ["HUB", "LIMITER"]) {
      assert.equal(await (await fetchObject(binding)).text(), "old-data");
    }
  } finally {
    await mf.dispose();
  }
});
