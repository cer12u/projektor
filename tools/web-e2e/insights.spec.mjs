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
