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
  const changed = await request.post("/api/w/web1/issues/transition", {
    data: { operationId: crypto.randomUUID(), issueId, expectedVersion: 1, state: "in_progress" },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  await page.reload();
  await page
    .getByRole("button", { name: new RegExp(`P${id.toUpperCase()} · Planning E2E`) })
    .click();
  await page.getByRole("button", { name: "計画" }).click();
  await page.getByRole("button", { name: "Next batch" }).click();
  await expect(page.getByText(/Live issue · 進行中/)).toBeVisible();
  const archived = await request.post("/api/w/web1/issues/archive", {
    data: { operationId: crypto.randomUUID(), issueId, expectedVersion: 2 },
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
  await page.getByRole("button", { name: "終了", exact: true }).click();
  await expect(page.getByRole("button", { name: "予定に入れる" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "終了", exact: true })).toHaveCount(0);
  await expect(page.getByText(/Live issue · 進行中/)).toBeVisible();
});

test("10a sprint paging reaches the last item and resets when switching sprint", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8),
    projectId = `pages-${id}`;
  const created = await request.post("/api/w/web1/projects/create", {
    data: {
      operationId: crypto.randomUUID(),
      projectId,
      key: `P${id.toUpperCase()}`,
      name: "Pages",
    },
  });
  expect(created.ok()).toBeTruthy();
  const sprint = (sid) => ({
    id: sid,
    projectId,
    name: sid,
    version: 1,
    closed: false,
    archived: false,
  });
  await page.route("**/planning/list?*", (route) =>
    route.fulfill({ json: [sprint("First"), sprint("Second")] }),
  );
  const calls = [];
  await page.route("**/planning/items?*", (route) => {
    const q = new URL(route.request().url()).searchParams;
    const sid = q.get("sprintId"),
      cursor = q.get("cursor");
    calls.push({ sid, cursor });
    const ids =
      sid === "Second"
        ? ["second-item"]
        : cursor
          ? ["last-item"]
          : Array.from({ length: 50 }, (_, i) => `first-${i}`);
    return route.fulfill({
      json: {
        sprint: sprint(sid),
        items: ids.map((issueId) => ({
          issueId,
          archived: false,
          issue: { id: issueId, reference: issueId, title: issueId, state: "todo" },
        })),
        nextCursor: sid === "First" && !cursor ? "first-49" : null,
      },
    });
  });
  await page.goto("/?w=web1");
  await page.getByRole("button", { name: new RegExp(`P${id.toUpperCase()} · Pages`) }).click();
  await page.getByRole("button", { name: "計画" }).click();
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(page.getByText(/first-49 ·/)).toBeVisible();
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(page.getByText(/last-item ·/)).toBeVisible();
  expect(calls.at(-1)).toEqual({ sid: "First", cursor: "first-49" });
  await expect(page.getByText(/first-49 ·/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "次のページ" })).toHaveCount(0);
  await page.getByRole("button", { name: "最初のページ" }).click();
  await expect(page.getByText(/first-49 ·/)).toBeVisible();
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(page.getByText(/last-item ·/)).toBeVisible();
  await page.getByRole("button", { name: "Second", exact: true }).click();
  await expect(page.getByText(/second-item ·/)).toBeVisible();
  expect(calls.at(-1)).toEqual({ sid: "Second", cursor: null });
  await expect(page.getByText(/last-item ·/)).toHaveCount(0);
});
