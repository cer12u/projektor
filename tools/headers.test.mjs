import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("built Astro assets are hashed and immutable while HTML retains CSP", () => {
  const headers = fs.readFileSync("dist/assets/_headers", "utf8");
  assert.match(headers, /^\/\*\n {2}Content-Security-Policy: /);
  assert.match(headers, /\n\/_astro\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n/);
  assert.equal(/^\/\*\n {2}Cache-Control:/m.test(headers), false);
  for (const name of fs.readdirSync("dist/assets/_astro")) {
    assert.match(name, /\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/);
    assert(fs.statSync(path.join("dist/assets/_astro", name)).isFile());
  }
});
