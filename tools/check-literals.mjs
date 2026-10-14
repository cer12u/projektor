// Rejects environment-specific literals in tracked files: private hostnames and
// addresses, Cloudflare account/zone IDs, concrete workers.dev hosts, and any extra
// literal listed in the FORBIDDEN_LITERALS CI/CD variable (comma separated, so the
// list itself never lives in this public repository). Such values belong in CI/CD
// variables or deploy-time configuration. See docs/operations.md.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const skipped = [/^pnpm-lock\.yaml$/, /^platform\/generated\//, /^LICENSE$/];
const isTest = (file) =>
  /(^|\/)tests?\//.test(file) ||
  /\.test\.[cm]?[jt]s$/.test(file) ||
  /^tools\/(web-e2e|audit-)/.test(file);
const rules = [
  {
    name: "private hostname",
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:home|lan|corp|intranet)\b/i,
  },
  { name: "Cloudflare account/zone ID", pattern: /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/ },
  {
    name: "private IPv4 address",
    pattern: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/,
    tests: false,
  },
  {
    name: "concrete workers.dev host",
    pattern: /\b[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i,
    tests: false,
  },
];

export function scan(file, text, extra = []) {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.tests === false && isTest(file)) continue;
      if (rule.pattern.test(line)) findings.push(`${file}:${index + 1}: ${rule.name}`);
    }
    const lower = line.toLowerCase();
    for (const literal of extra)
      if (lower.includes(literal)) findings.push(`${file}:${index + 1}: forbidden literal`);
  });
  return findings;
}

export function forbiddenLiterals(value = process.env.FORBIDDEN_LITERALS ?? "") {
  return value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !skipped.some((pattern) => pattern.test(file)));
  const extra = forbiddenLiterals();
  const findings = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    if (buffer.includes(0)) continue;
    findings.push(...scan(file, buffer.toString("utf8"), extra));
  }
  if (findings.length) {
    // Print locations only: the matched value may itself be the sensitive part.
    console.error(findings.join("\n"));
    console.error(
      `${findings.length} environment-specific literal(s); move them to CI/CD variables.`,
    );
    process.exit(1);
  }
  console.log(`Literal check passed (${files.length} files, ${extra.length} extra literals)`);
}
