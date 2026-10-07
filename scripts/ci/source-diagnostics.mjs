// Preserve the command's normal logs and exit status, while exposing only bounded,
// repository-source type diagnostics as GitHub annotations. No environment/log dump.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DIAGNOSTICS = 40;
const MAX_MESSAGE = 800;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function parseDiagnostic(raw, files, repositoryRoot = process.cwd()) {
	const line = raw.replace(ANSI, "").replace(/^@projektor\/[^:]+:type-check:\s*/, "");
	const match = line.match(
		/^(.+\.(?:tsx?|astro|jsx?))(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[:-]?\s*(error|warning)\s+(?:TS(\d+)|ts\((\d+)\)):\s*(.+)$/i
	);
	if (!match) return null;
	let path = match[1].trim().replaceAll("\\", "/");
	if (path.split("/").some((part) => part === ".." || part === "node_modules")) return null;
	if (/^(?:\/|[A-Za-z]:\/)/.test(path)) {
		const root = `${resolve(repositoryRoot).replaceAll("\\", "/")}/`;
		if (!path.startsWith(root)) return null;
		path = path.slice(root.length);
	} else path = path.replace(/^\.\//, "");
	const candidates = files.filter((file) =>
		(file.startsWith("apps/") || file.startsWith("packages/")) &&
		(file === path || file.endsWith(`/${path}`))
	);
	// Never invent a path, publish a dependency diagnostic, or guess among duplicates.
	if (candidates.length !== 1) return null;
	return {
		file: candidates[0],
		line: Number(match[2] ?? match[4]),
		column: Number(match[3] ?? match[5]),
		severity: match[6].toLowerCase(),
		code: `TS${match[7] ?? match[8]}`,
		message: match[9].slice(0, MAX_MESSAGE),
	};
}

function escapeData(value) {
	return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function annotation(diagnostic) {
	const path = escapeData(diagnostic.file).replaceAll(":", "%3A").replaceAll(",", "%2C");
	return `::${diagnostic.severity} file=${path},line=${diagnostic.line},col=${diagnostic.column}::${escapeData(`${diagnostic.code}: ${diagnostic.message}`)}`;
}

export async function run(command, args, files) {
	const diagnostics = new Map();
	const buffers = { stdout: "", stderr: "" };
	function inspect(kind, chunk) {
		buffers[kind] += chunk;
		const lines = buffers[kind].split(/\r?\n/);
		buffers[kind] = lines.pop()?.slice(-8192) ?? "";
		for (const line of lines) {
			if (diagnostics.size >= MAX_DIAGNOSTICS) break;
			const diagnostic = parseDiagnostic(line, files);
			if (diagnostic) diagnostics.set(JSON.stringify(diagnostic), diagnostic);
		}
	}
	const code = await new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
		child.stdout.on("data", (chunk) => { process.stdout.write(chunk); inspect("stdout", chunk.toString()); });
		child.stderr.on("data", (chunk) => { process.stderr.write(chunk); inspect("stderr", chunk.toString()); });
		child.on("error", () => resolve(1));
		child.on("close", (exitCode) => resolve(exitCode ?? 1));
	});
	inspect("stdout", "\n");
	inspect("stderr", "\n");
	for (const diagnostic of diagnostics.values()) console.log(annotation(diagnostic));
	if (process.env.GITHUB_STEP_SUMMARY) {
		const entries = [...diagnostics.values()].map((d) =>
			`- ${d.file}:${d.line}:${d.column} ${d.code}: ${d.message.replace(/[<>&`\r\n]/g, " ")}`
		);
		try {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY,
				`\n### Source type diagnostics\nExit code: ${code}. At most ${MAX_DIAGNOSTICS} bounded source diagnostics.\n${entries.join("\n")}\n`);
		} catch {
			// Optional presentation must never replace the command's actual exit code.
			console.warn("Could not write the optional source diagnostic summary");
		}
	}
	return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [command, ...args] = process.argv.slice(2);
	if (!command) throw new Error("Pass the type-check command and arguments");
	const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
	process.exitCode = await run(command, args, files);
}
