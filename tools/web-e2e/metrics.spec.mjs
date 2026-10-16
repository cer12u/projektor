import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

test("flow charts render on metrics and project pages after issue transitions", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(90000);
  const fixture = await request.get("/__test/assertion");
  expect(fixture.ok()).toBeTruthy();
  const { assertion } = await fixture.json();
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  const headers = {
    cookie: `CF_Authorization=${assertion}`,
    "x-workspace-slug": "web1",
    origin: "http://127.0.0.1:8789",
  };
  const projectResponse = await request.post("/api/projects", {
    headers,
    data: {
      name: `Flow E2E ${randomBytes(4).toString("hex")}`,
      key: `FL${randomBytes(4).toString("hex").toUpperCase()}`,
    },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const createIssue = async (title) => {
    const response = await request.post("/api/issues", {
      headers,
      data: { projectId: project.id, title },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).id;
  };
  const active = await createIssue("Active flow");
  const done = await createIssue("Done flow");
  for (const [issueId, statuses] of [
    [active, ["status_in_progress"]],
    [done, ["status_in_progress", "status_done"]],
  ])
    for (const statusId of statuses)
      expect(
        (await request.patch(`/api/issues/${issueId}`, { headers, data: { statusId } })).status(),
      ).toBe(200);
  await page.goto(`/metrics?projectId=${project.id}`);
  await expect(page.getByRole("heading", { name: "Metrics", exact: true })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /flow-metrics/ })).toHaveCount(0);
  await page.goto(`/projects/view/${project.slug}?projectId=${project.id}`);
  await expect(page.getByRole("heading", { name: "Flow (last 6 weeks)" })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: /flow-metrics/ })).toHaveCount(0);
});
