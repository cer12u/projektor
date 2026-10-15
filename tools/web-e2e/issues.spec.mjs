import { expect, test } from "@playwright/test";

test("original issue pages create, edit, comment, link, board, My Issues and search", async ({
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
  await page.goto("/");
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Issue E2E");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.goto("/issues");
  await expect(page.getByRole("button", { name: "+ New issue" })).toBeVisible();
  await page.getByRole("button", { name: "+ New issue" }).click();
  await page.getByPlaceholder("Issue title").fill("E2E first issue");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(page.getByText("E2E first issue")).toBeVisible();
  await page.getByRole("link", { name: "E2E first issue" }).click();
  await expect(page).toHaveURL(/\/projects\/ISSUEE2E\/issues\/1\/e2e-first-issue$/);
  await expect(page.getByRole("heading", { name: "E2E first issue" })).toBeVisible();
  await page.getByTitle("Edit title", { exact: true }).click();
  await page.getByRole("textbox").first().fill("E2E edited issue");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "E2E edited issue" })).toBeVisible();
  await page.getByRole("combobox", { name: "Change status" }).click();
  await page.getByRole("option", { name: "In Progress" }).click();
  await page.getByRole("combobox", { name: "Change priority" }).click();
  await page.getByRole("option", { name: "High" }).click();
  // The original detail page has no label editor; verify its PATCH contract from this browser flow.
  const labels = await request.patch("/api/issues/ISSUEE2E-1", {
    headers: {
      cookie: `CF_Authorization=${assertion}`,
      "x-workspace-slug": "web1",
      origin: "http://127.0.0.1:8789",
    },
    data: { labels: ["e2e"] },
  });
  expect(labels.ok()).toBeTruthy();
  const labelled = await request.get("/api/issues/ISSUEE2E-1", {
    headers: { cookie: `CF_Authorization=${assertion}`, "x-workspace-slug": "web1" },
  });
  expect(JSON.parse((await labelled.json()).labels)).toEqual(["e2e"]);
  await page.getByPlaceholder("Add a comment…").fill("E2E comment");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("E2E comment")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).last().click();
  await page.locator("textarea").first().fill("E2E edited comment");
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await expect(page.getByText("E2E edited comment")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("E2E edited comment")).toHaveCount(0);
  const me = await request.get("/auth/me", {
    headers: { cookie: `CF_Authorization=${assertion}` },
  });
  const actorId = (await me.json()).user.id;
  const assign = await request.patch("/api/issues/ISSUEE2E-1", {
    headers: {
      cookie: `CF_Authorization=${assertion}`,
      "x-workspace-slug": "web1",
      origin: "http://127.0.0.1:8789",
    },
    data: { assigneeId: actorId },
  });
  expect(assign.ok()).toBeTruthy();
  await page.goto("/my-issues");
  await expect(page.getByRole("link", { name: "E2E edited issue" }).first()).toBeVisible();
  await page.goto("/issues");
  await page.getByRole("button", { name: "+ New issue" }).click();
  await page.getByPlaceholder("Issue title").fill("E2E linked issue");
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  await expect(page.getByRole("link", { name: "E2E linked issue" })).toBeVisible();
  await page.getByRole("link", { name: "E2E edited issue" }).click();
  await page.getByRole("button", { name: /Add relation/ }).click();
  await page.getByPlaceholder("PROJ-12").fill("ISSUEE2E-2");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("link", { name: /ISSUEE2E-2/ })).toBeVisible();
  await page.goto("/issues");
  await page.getByRole("button", { name: "board", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "In Progress column" }).getByText("E2E edited issue"),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Search issues" }).fill("E2E edited issue");
  await expect(page.getByRole("link", { name: "E2E edited issue" }).first()).toBeVisible();
});
