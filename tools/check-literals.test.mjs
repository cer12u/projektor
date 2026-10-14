import assert from "node:assert/strict";
import test from "node:test";
import { forbiddenLiterals, scan } from "./check-literals.mjs";

test("environment-specific literals are reported by location only", () => {
  // Split so that this fixture does not trip the repository-wide check itself.
  const privateHost = ["registry", "example", "home"].join(".");
  assert.deepEqual(scan("a.yml", `image: ${privateHost}/ci:1`), ["a.yml:1: private hostname"]);
  assert.deepEqual(scan("a.ts", `account = "${"ab".repeat(16)}"`), [
    "a.ts:1: Cloudflare account/zone ID",
  ]);
  assert.deepEqual(scan("a.ts", "x\nhttps://app.team.workers.dev"), [
    "a.ts:2: concrete workers.dev host",
  ]);
  assert.deepEqual(scan("a.ts", "target 192.168.1.10"), ["a.ts:1: private IPv4 address"]);
  assert.deepEqual(scan("a.md", "Contact: Example.ORG staff", ["example.org"]), [
    "a.md:1: forbidden literal",
  ]);
});

test("hashes, generic hosts and test fixtures are allowed", () => {
  assert.deepEqual(scan("a.ts", `sha256 ${"ab".repeat(32)}`), []);
  assert.deepEqual(scan("a.ts", "commit d39852cef35217bc1dbf4c42d646bda1f09994d3"), []);
  assert.deepEqual(
    scan("a.ts", "https://example.cloudflareaccess.com and cloudflare.internal"),
    [],
  );
  assert.deepEqual(
    scan("tools/x.test.mjs", "https://projektor-verify.audit.workers.dev 10.0.0.1"),
    [],
  );
});

test("extra literals come from a comma-separated variable", () => {
  assert.deepEqual(forbiddenLiterals(" A.example , ,b "), ["a.example", "b"]);
  assert.deepEqual(forbiddenLiterals(""), []);
});
