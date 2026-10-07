import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { annotation, parseDiagnostic, run } from "./source-diagnostics.mjs";

const files = ["apps/web/src/islands/Page.tsx", "apps/web/src/pages/index.astro", "apps/api/src/index.ts", "packages/types/src/index.ts"];

test("recognizes tsc and Astro source positions without altering message semantics", () => {
	assert.deepEqual(parseDiagnostic("src/islands/Page.tsx(12,3): error TS2322: Type mismatch", files), { file: files[0], line: 12, column: 3, severity: "error", code: "TS2322", message: "Type mismatch" });
	assert.deepEqual(parseDiagnostic("\u001b[31msrc/pages/index.astro:4:5 - error ts(2345): Bad input\u001b[0m", files), { file: files[1], line: 4, column: 5, severity: "error", code: "TS2345", message: "Bad input" });
});

test("refuses environment, raw logs, dependency paths, unknown paths and ambiguous source suffixes", () => {
	for (const line of ["TOKEN=do-not-publish", "ordinary log", "node_modules/private/index.ts(1,1): error TS1: dependency", "unknown.ts(1,1): error TS1: unknown", "src/index.ts(1,1): error TS1: ambiguous"]) assert.equal(parseDiagnostic(line, files), null);
});

test("bounds messages and escapes annotation control characters", () => {
	assert.equal(parseDiagnostic(`src/islands/Page.tsx(1,1): error TS1: ${"x".repeat(900)}`, files).message.length, 800);
	assert.equal(annotation({ file: "apps/web/a,b.ts", line: 1, column: 2, severity: "error", code: "TS1", message: "one\n::notice::two%" }), "::error file=apps/web/a%2Cb.ts,line=1,col=2::TS1: one%0A::notice::two%25");
});

test("preserves failure and success exit codes", async () => {
	assert.equal(await run(process.execPath, ["-e", "process.exit(7)"], files), 7);
	assert.equal(await run(process.execPath, ["-e", "process.exit(0)"], files), 0);
});


test("accepts only in-repository absolute paths and rejects dependency/traversal disguises", () => {
	assert.equal(parseDiagnostic("/checkout/apps/web/src/islands/Page.tsx(1,1): error TS1: source", files, "/checkout").file, files[0]);
	for (const file of ["node_modules/dependency/apps/web/src/islands/Page.tsx", "/tmp/outside/apps/web/src/islands/Page.tsx", "../apps/web/src/islands/Page.tsx", "/checkout/apps/../web/src/islands/Page.tsx"]) {
		assert.equal(parseDiagnostic(`${file}(1,1): error TS1: outside`, files, "/checkout"), null);
	}
});

test("an unwritable optional summary does not change the command's exit code", async () => {
	const directory = mkdtempSync(join(tmpdir(), "source-diagnostics-"));
	const previous = process.env.GITHUB_STEP_SUMMARY;
	process.env.GITHUB_STEP_SUMMARY = directory;
	try {
		assert.equal(await run(process.execPath, ["-e", "process.exit(7)"], files), 7);
	} finally {
		if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
		else process.env.GITHUB_STEP_SUMMARY = previous;
		rmSync(directory, { recursive: true });
	}
});
