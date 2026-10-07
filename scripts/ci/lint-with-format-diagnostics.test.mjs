import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formattingPreview, lintWithPreview } from "./lint-with-format-diagnostics.mjs";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "format-preview-test-"));
	const root = join(directory, "repo"); mkdirSync(root);
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	git("init", "-q"); mkdirSync(join(root, "apps/api/src"), { recursive: true });
	writeFileSync(join(root, "apps/api/src/demo.ts"), "export const value=1;\n");
	git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
	return { directory, root, git, summary: join(directory, "summary.md"), clean: () => rmSync(directory, { recursive: true, force: true }) };
}

test("shows only tracked source and leaves the tested checkout untouched", () => {
	const f = fixture(); let copy;
	try {
		formattingPreview(f.root, ["apps/api/src/demo.ts", "untracked.ts", "../outside.ts"], f.summary, (cwd, targets) => {
			copy = cwd; assert.deepEqual(targets, ["apps/api/src/demo.ts"]);
			writeFileSync(join(cwd, targets[0]), "export const value = 1;\n");
		});
		assert.equal(readFileSync(join(f.root, "apps/api/src/demo.ts"), "utf8"), "export const value=1;\n");
		assert.equal(f.git("status", "--porcelain"), ""); assert.equal(existsSync(copy), false);
		assert.match(readFileSync(f.summary, "utf8"), /Complete patch/);
	} finally { f.clean(); }
});

test("cleanup occurs on summary failure and original lint exit code survives", () => {
	const f = fixture(); let copy;
	try {
		assert.equal(lintWithPreview(() => 7, () => formattingPreview(f.root, ["apps/api/src/demo.ts"], f.directory, (cwd, targets) => {
			copy = cwd; writeFileSync(join(cwd, targets[0]), "export const value = 1;\n");
		})), 7);
		assert.equal(existsSync(copy), false); assert.equal(f.git("status", "--porcelain"), "");
	} finally { f.clean(); }
});

test("truncation is explicit and successful lint does not run a preview", () => {
	const f = fixture();
	try {
		formattingPreview(f.root, ["apps/api/src/demo.ts"], f.summary, (cwd, targets) => writeFileSync(join(cwd, targets[0]), "export const value = 1;\n"), 25);
		assert.match(readFileSync(f.summary, "utf8"), /TRUNCATED at 25 bytes/);
		assert.equal(lintWithPreview(() => 0, () => { throw new Error("must not run"); }), 0);
	} finally { f.clean(); }
});
