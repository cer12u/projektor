// A formatting preview of already-public tracked source, never private runner logs.
// The test checkout is never formatted: a disposable worktree holds proposed edits.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PATCH_BYTES = 192 * 1024;
function git(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function formattingPreview(root, requested, summaryPath, format, maxBytes = MAX_PATCH_BYTES) {
	const tracked = new Set(git(root, ["ls-files"]).trim().split("\n"));
	const targets = requested.filter((path) => tracked.has(path) &&
		/^(?:apps\/(?:api|web)\/src\/|packages\/)/.test(path) && /\.tsx?$/.test(path) &&
		!path.split("/").some((part) => part === ".." || part === "node_modules"));
	if (targets.length === 0) return;
	const original = git(root, ["status", "--porcelain", "--untracked-files=all"]);
	const temporary = mkdtempSync(join(tmpdir(), "projektor-format-"));
	const worktree = join(temporary, "source");
	let registered = false;
	let stage = "worktree_create";
	let preview;
	try {
		git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
		registered = true;
		// Tracked symlinks are not repository source files we may expose or modify.
		const modes = git(worktree, ["ls-files", "--stage", "--", ...targets]);
		if (modes.split("\n").some((line) => line.startsWith("120000 "))) throw new Error("Source symlink refused");
		stage = "locked_formatter";
		format(worktree, targets);
		stage = "source_diff";
		const changed = git(worktree, ["diff", "--name-only"]).trim().split("\n").filter(Boolean);
		if (changed.some((path) => !targets.includes(path))) throw new Error("Out-of-scope formatter change");
		const patch = git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--", ...targets]);
		const bytes = Buffer.from(patch);
		const truncated = bytes.length > maxBytes;
		const bounded = bytes.subarray(0, maxBytes).toString("utf8");
		const fence = "`".repeat(Math.max(3, ...[...bounded.matchAll(/`+/g)].map((m) => m[0].length + 1)));
		preview = { patch: bounded, bytes: bytes.length, truncated };
		if (summaryPath) {
			try {
				appendFileSync(summaryPath,
			`\n### Proposed source formatting (lint still fails)\n${truncated ? `TRUNCATED at ${maxBytes} bytes; do not apply as a complete patch.` : `Complete patch, ${bytes.length} bytes.`}\n` +
			`Only allowlisted tracked source from this commit is shown. No formatter edits are applied to the tested checkout.\n${fence}diff\n${bounded}\n${fence}\n`);
			} catch {
				console.warn("Optional formatting summary unavailable; public source notices remain available");
			}
		}
	} catch (error) {
		error.previewStage = stage;
		throw error;
	} finally {
		try {
			if (registered) git(root, ["worktree", "remove", "--force", worktree]);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
			if (git(root, ["status", "--porcelain", "--untracked-files=all"]) !== original) {
				throw new Error("Test checkout changed during formatting preview");
			}
		}
	}
	return preview;
}

function escapeAnnotation(value) {
	return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function publishPreview(preview, emit = console.log) {
	if (!preview) {
		emit("::notice title=Formatting preview::No eligible tracked source targets");
		return;
	}
	const checksum = createHash("sha256").update(preview.patch).digest("hex");
	const chunks = [];
	let chunk = "";
	let size = 0;
	for (const character of preview.patch) {
		const bytes = Buffer.byteLength(character);
		if (size + bytes > 45000) { chunks.push(chunk); chunk = ""; size = 0; }
		chunk += character;
		size += bytes;
	}
	if (chunk || chunks.length === 0) chunks.push(chunk);
	chunks.forEach((part, index) => {
		const header = `SOURCE_FORMAT_PATCH v1 part=${index + 1}/${chunks.length} sha256=${checksum} bytes=${Buffer.byteLength(preview.patch)} truncated=${preview.truncated}`;
		emit(`::notice title=Source formatting patch ${index + 1} of ${chunks.length}::${escapeAnnotation(`${header}\n${part}`)}`);
	});
}

export function lintWithPreview(lint, preview) {
	const code = lint();
	if (code !== 0) {
		try { preview(); } catch { console.warn("Optional source formatting preview unavailable; original lint failure retained"); }
	}
	return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const root = process.cwd();
	const targets = JSON.parse(readFileSync(new URL("./format-targets.json", import.meta.url), "utf8"));
	const preview = () => {
		const binary = join(root, "node_modules", ".bin", "biome");
		const locked = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").match(/'@biomejs\/biome':[\s\S]*?\n\s+version: ([^\s]+)/)?.[1];
		const version = spawnSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const actual = version.stdout?.match(/\b\d+\.\d+\.\d+\b/)?.[0];
		if (!locked || version.status !== 0 || actual !== locked) throw new Error("Locked formatter version mismatch");
		console.log(`::notice title=Formatting preview version::Verified locked Biome ${actual}`);
		const result = formattingPreview(root, targets, process.env.GITHUB_STEP_SUMMARY, (cwd, paths) => {
			// Lint rules are disabled only in this disposable formatting/import preview.
			const formatted = spawnSync(binary, ["check", "--write", "--linter-enabled=false", ...paths], { cwd, stdio: "ignore" });
			if (formatted.error) throw formatted.error;
		});
		publishPreview(result);
	};
	if (process.argv.includes("--preview-only")) {
		try { preview(); } catch (error) {
			const phase = /^[a-z_]+$/.test(error.previewStage ?? "") ? error.previewStage : "setup";
			console.log(`::notice title=Formatting preview unavailable::Source preview could not complete during ${phase}; the original lint gate remains failed`);
		}
	} else {
		process.exitCode = lintWithPreview(
			() => spawnSync("pnpm", ["lint", "--reporter=github", "--max-diagnostics=50"], { stdio: "inherit" }).status ?? 1,
			preview
		);
	}
}
