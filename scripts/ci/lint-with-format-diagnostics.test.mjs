import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formattingPreview, lintWithPreview, publishPreview } from "./lint-with-format-diagnostics.mjs";

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


test("compressed public source notices survive the UI cap and verify byte/hash provenance", () => {
	const patch = randomBytes(18000).toString("base64") + "\nsource-only%value\n".repeat(1000);
	const notices = [];
	for (let window = 0; window < 3; window++) {
		publishPreview({ patch, bytes: Buffer.byteLength(patch), truncated: false }, (line) => notices.push(line), { head: "a".repeat(40), biome: "2.5.8" }, window);
	}
	const payloads = notices.map((line) => {
		const body = line.slice(line.indexOf("::", 2) + 2).replaceAll("%0D", "\r").replaceAll("%0A", "\n").replaceAll("%25", "%");
		assert.ok(Buffer.byteLength(body) <= 2000);
		assert.equal(body.slice(0, 4096), body);
		const header = body.slice(0, body.indexOf("\n"));
		assert.match(header, /truncated=false/);
		assert.match(header, /biome=2\.5\.8/);
		return { header, data: body.slice(body.indexOf("\n") + 1) };
	});
	const count = Number(payloads[0].header.match(/part=1\/(\d+)/)[1]);
	assert.equal(payloads.length, count);
	const compressed = Buffer.from(payloads.map((p) => p.data).join(""), "base64");
	assert.equal(compressed.length, Number(payloads[0].header.match(/gzip_bytes=(\d+)/)[1]));
	const recovered = gunzipSync(compressed);
	assert.equal(recovered.length, Number(payloads[0].header.match(/raw_bytes=(\d+)/)[1]));
	assert.equal(createHash("sha256").update(recovered).digest("hex"), payloads[0].header.match(/sha256=([a-f0-9]+)/)[1]);
	assert.equal(recovered.toString(), patch);
});
