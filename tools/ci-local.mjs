import { execFileSync } from "node:child_process";
import fs from "node:fs";

// Keep in sync with .gitlab-ci.yml.
const jobs = [
  [
    ["pnpm", "check:boundaries"],
    [
      "node",
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      "--test-reporter-destination=reports/boundaries.xml",
      "tools/boundaries.test.mjs",
    ],
  ],
  [
    ["pnpm", "lint"],
    ["pnpm", "typecheck"],
    ["pnpm", "check:contracts"],
    ["pnpm", "check:literals"],
  ],
  [
    ["pnpm", "test:modules", "--coverage"],
    ["pnpm", "test:migrations"],
    ["pnpm", "test:gateway"],
  ],
  [["pnpm", "test:web:unit"]],
  [["pnpm", "test:web"]],
  [["pnpm", "build"]],
  [
    ["pnpm", "check:artifact"],
    ["pnpm", "test:smoke"],
  ],
];
fs.mkdirSync("reports", { recursive: true });
for (const job of jobs) {
  for (const [command, ...args] of job) {
    execFileSync(command, args, { stdio: "inherit" });
  }
}
