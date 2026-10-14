import { expect, test } from "@playwright/test";

test("project metrics, unified activity and watch marker render", async ({ page, request }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const projectId = `ins-${suffix}`;
  const issueId = `ins-issue-${suffix}`;
  const created = await request.post("/api/w/web1/projects/create", {
    data: {
      operationId: crypto.randomUUID(),
      projectId,
      key: `I${suffix.toUpperCase()}`,
      name: "Insights E2E",
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const issue = await request.post("/api/w/web1/issues/create", {
    data: {
      operationId: crypto.randomUUID(),
      issueId,
      projectId,
      title: "Activity task",
      description: "",
      priority: "medium",
    },
  });
  expect(issue.ok(), await issue.text()).toBeTruthy();
  await page.goto("/?w=web1");
  await expect(page.getByRole("button", { name: /Insights E2E/ })).toBeVisible();
  await page.getByRole("button", { name: /Insights E2E/ }).click();
  await page.getByRole("button", { name: "プロジェクト", exact: true }).click();
  await expect(page.getByRole("heading", { name: "指標" })).toBeVisible();
  await expect(page.getByText(/未着手 1/)).toBeVisible();
  await page.getByRole("button", { name: "エージェント活動" }).click();
  await expect(page.getByRole("heading", { name: "統合アクティビティ" })).toBeVisible();
  await expect(page.getByText("Activity task", { exact: true })).toBeVisible();
  await expect(page.getByText(/issues #/)).toBeVisible();
  await page.getByRole("button", { name: "課題", exact: true }).click();
  await page.getByRole("button", { name: /Activity task/ }).click();
  await page.getByRole("button", { name: "この課題を監視" }).click();
  await expect(page.getByRole("button", { name: "監視を解除" })).toBeVisible();
  await page.getByRole("button", { name: /通知/ }).click();
  await expect(page.getByRole("heading", { name: /通知/ })).toBeVisible();
});

test("11a feed shows OAuth clients, applies filters and removes archived targets on refresh", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8),
    projectId = `audit-${suffix}`,
    issueId = `task-${suffix}`;
  const oauth = await (await request.get("/__test/oauth?w=web2")).json();
  const headers = {
    authorization: `Bearer ${oauth.token}`,
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  };
  const call = async (name, input) => {
    const response = await request.post("/mcp/web2", {
      headers,
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { operationId: crypto.randomUUID(), ...input } },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
  };
  for (const [owner, action, input] of [
    ["projects", "create", { projectId, key: `A${suffix.toUpperCase()}`, name: `Audit ${suffix}` }],
    [
      "issues",
      "create",
      { projectId, issueId, title: `Private ${suffix}`, description: "", priority: "medium" },
    ],
    ["planning", "create", { projectId, sprintId: `s-${suffix}`, name: `Sprint ${suffix}` }],
  ]) {
    await call(`${owner}.${action}`, input);
  }
  await page.goto("/?w=web2");
  await page.getByRole("button", { name: new RegExp(`Audit ${suffix}`) }).click();
  await page.getByRole("button", { name: "エージェント活動" }).click();
  const feed = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "統合アクティビティ" }) });
  await expect(feed.getByText(`${oauth.clientId} 経由`, { exact: false })).toHaveCount(3);
  await page.getByLabel("クライアント ID", { exact: true }).fill("unrelated");
  await expect(feed.locator("li")).toHaveCount(0);
  await page.getByLabel("クライアント ID", { exact: true }).fill(oauth.clientId);
  await expect(feed.locator("li")).toHaveCount(3);
  await call("issues.archive", { issueId, expectedVersion: 1 });
  await feed.getByRole("button", { name: "更新", exact: true }).click();
  await expect(feed.getByText(`Private ${suffix}`, { exact: true })).toHaveCount(0);
  await expect(feed.locator("li")).toHaveCount(2);
});
