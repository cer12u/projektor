// A formatting preview of already-public tracked source, never private runner logs.
// The test checkout is never formatted: a disposable worktree holds proposed edits.
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
	if (!summaryPath || targets.length === 0) return;
	const original = git(root, ["status", "--porcelain", "--untracked-files=all"]);
	const temporary = mkdtempSync(join(tmpdir(), "projektor-format-"));
	const worktree = join(temporary, "source");
	let registered = false;
	try {
		git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
		registered = true;
		// Tracked symlinks are not repository source files we may expose or modify.
		const modes = git(worktree, ["ls-files", "--stage", "--", ...targets]);
		if (modes.split("\n").some((line) => line.startsWith("120000 "))) throw new Error("Source symlink refused");
		format(worktree, targets);
		const changed = git(worktree, ["diff", "--name-only"]).trim().split("\n").filter(Boolean);
		if (changed.some((path) => !targets.includes(path))) throw new Error("Out-of-scope formatter change");
		const patch = git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--", ...targets]);
		const bytes = Buffer.from(patch);
		const truncated = bytes.length > maxBytes;
		const bounded = bytes.subarray(0, maxBytes).toString("utf8");
		const fence = "`".repeat(Math.max(3, ...[...bounded.matchAll(/`+/g)].map((m) => m[0].length + 1)));
		appendFileSync(summaryPath,
			`\n### Proposed source formatting (lint still fails)\n${truncated ? `TRUNCATED at ${maxBytes} bytes; do not apply as a complete patch.` : `Complete patch, ${bytes.length} bytes.`}\n` +
			`Only allowlisted tracked source from this commit is shown. No formatter edits are applied to the tested checkout.\n${fence}diff\n${bounded}\n${fence}\n`);
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
	process.exitCode = lintWithPreview(
		() => spawnSync("pnpm", ["lint", "--reporter=github", "--max-diagnostics=50"], { stdio: "inherit" }).status ?? 1,
		() => formattingPreview(root, targets, process.env.GITHUB_STEP_SUMMARY, (cwd, paths) => {
			// Use the locked binary already installed by this job. Lint rules are
			// disabled only in the disposable formatting/import-order preview.
			const result = spawnSync(join(root, "node_modules", ".bin", "biome"),
				["check", "--write", "--linter-enabled=false", ...paths], { cwd, stdio: "ignore" });
			if (result.error) throw result.error;
		})
	);
}
