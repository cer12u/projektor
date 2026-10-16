import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "web-e2e",
  projects: [
    { name: "foundation", testMatch: "ui-foundation.spec.mjs" },
    { name: "issues", testMatch: "issues.spec.mjs" },
    { name: "due-estimate", testMatch: "due-estimate.spec.mjs" },
    { name: "metrics", testMatch: "metrics.spec.mjs" },
    { name: "sprints-files", testMatch: "sprints-files.spec.mjs" },
    { name: "wiki", testMatch: "wiki.spec.mjs" },
    {
      name: "settings-feedback",
      testMatch: "settings-feedback.spec.mjs",
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
