import { expect, test } from "@playwright/test";

test("sprint view schedules and removes an issue with live state", async ({ page, request }) => {
  const id = crypto.randomUUID().slice(0, 8);
  const projectId = `plan-${id}`,
    issueId = `issue-${id}`;
  const create = await request.post("/api/w/web1/projects/create", {
    data: {
      operationId: crypto.randomUUID(),
      projectId,
      key: `P${id.toUpperCase()}`,
      name: "Planning E2E",
    },
  });
  expect(create.ok(), await create.text()).toBeTruthy();
  const issue = await request.post("/api/w/web1/issues/create", {
    data: {
      operationId: crypto.randomUUID(),
      issueId,
      projectId,
      title: "Live issue",
      description: "",
      priority: "medium",
    },
  });
  expect(issue.ok(), await issue.text()).toBeTruthy();
  await page.goto("/?w=web1");
  await page
    .getByRole("button", { name: new RegExp(`P${id.toUpperCase()} · Planning E2E`) })
    .click();
  await page.getByRole("button", { name: "計画" }).click();
  await page.getByLabel("スプリント名").fill("Next batch");
  await page.getByRole("button", { name: "作成" }).click();
  await page.getByRole("button", { name: "Next batch" }).click();
  await page.getByLabel("課題 ID").fill(issueId);
  await page.getByRole("button", { name: "予定に入れる" }).click();
  await expect(page.getByText(/Live issue · 未着手/)).toBeVisible();
  await page.getByRole("button", { name: "予定から外す" }).click();
  await expect(page.getByText(/Live issue · 未着手/)).toHaveCount(0);
  await page.getByLabel("課題 ID").fill(issueId);
  await page.getByRole("button", { name: "予定に入れる" }).click();
  const archived = await request.post("/api/w/web1/issues/archive", {
    data: { operationId: crypto.randomUUID(), issueId, expectedVersion: 1 },
  });
  expect(archived.ok(), await archived.text()).toBeTruthy();
  await page.reload();
  await page
    .getByRole("button", { name: new RegExp(`P${id.toUpperCase()} · Planning E2E`) })
    .click();
  await page.getByRole("button", { name: "計画" }).click();
  await page.getByRole("button", { name: "Next batch" }).click();
  await expect(page.getByText("アーカイブ済み")).toBeVisible();
  await expect(page.getByRole("button", { name: "予定から外す" })).toHaveCount(0);
});
