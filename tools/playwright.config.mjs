import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "web-e2e",
  projects: [
    { name: "foundation", testMatch: "ui-foundation.spec.mjs" },
    { name: "issues", testMatch: "issues.spec.mjs", dependencies: ["foundation"] },
    { name: "metrics", testMatch: "metrics.spec.mjs", dependencies: ["foundation"] },
    { name: "sprints-files", testMatch: "sprints-files.spec.mjs", dependencies: ["foundation"] },
    { name: "wiki", testMatch: "wiki.spec.mjs", dependencies: ["foundation"] },
    {
      name: "settings-feedback",
      testMatch: "settings-feedback.spec.mjs",
      dependencies: ["foundation"],
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:8789",
    browserName: "chromium",
    headless: true,
    launchOptions: process.env.WEB_CHROME_PATH
      ? { executablePath: process.env.WEB_CHROME_PATH }
      : {},
  },
  webServer: {
    command: "PUBLIC_WORKSPACE_SLUG=web1 pnpm build && node tools/web-dev.mjs",
    cwd: new URL("..", import.meta.url).pathname,
    url: "http://127.0.0.1:8789/",
    timeout: 120000,
    reuseExistingServer: false,
  },
  workers: 1,
  reporter: "dot",
});
