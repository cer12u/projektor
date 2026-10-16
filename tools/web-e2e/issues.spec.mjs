import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUiWrite } from "./write-response.mjs";

test("original issue pages create, edit, comment, link, board, My Issues and search", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(90000);
  const fixture = await request.get("/__test/assertion");
  expect(fixture.ok()).toBeTruthy();
  const { assertion } = await fixture.json();
  const key = `IS${randomBytes(4).toString("hex").toUpperCase()}`;
  const headers = {
    cookie: `CF_Authorization=${assertion}`,
    "x-workspace-slug": "web1",
    origin: "http://127.0.0.1:8789",
  };
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  const projectResponse = await request.post("/api/projects", {
    headers,
    data: { name: `Issue E2E ${key}`, key },
  });
  expect(projectResponse.status()).toBe(201);
  await page.goto(`/issues?project=${key}`);
  await expect(page.getByRole("button", { name: "+ New issue" })).toBeVisible();
  await page.getByRole("button", { name: "+ New issue" }).click();
  if (await page.getByRole("combobox", { name: "Select project" }).count()) {
    await page.getByRole("combobox", { name: "Select project" }).click();
    await page.getByRole("option", { name: `Issue E2E ${key}` }).click();
  }
  await page.getByPlaceholder("Issue title").fill("E2E first issue");
  const firstCreated = page.waitForResponse(
    (response) => response.url().endsWith("/api/issues") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const firstResponse = await firstCreated;
  expect(firstResponse.ok()).toBeTruthy();
  const first = await firstResponse.json();
  const firstRef = `${key}-${first.number}`;
  await expect(page.getByText("E2E first issue")).toBeVisible();
  await page.getByRole("link", { name: firstRef, exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${key}/issues/${first.number}/e2e-first-issue$`),
  );
  await expect(page.getByRole("heading", { name: "E2E first issue" })).toBeVisible();
  await page.getByTitle("Edit title", { exact: true }).click();
  await page.getByRole("textbox").first().fill("E2E edited issue");
  await expectUiWrite(page, "PATCH", `/api/issues/${first.id}`, () =>
    page.getByRole("button", { name: "Save", exact: true }).first().click(),
  );
  await expect(page.getByRole("heading", { name: "E2E edited issue" })).toBeVisible();
  await page.getByRole("combobox", { name: "Change status" }).click();
  await expectUiWrite(page, "PATCH", `/api/issues/${first.id}`, () =>
    page.getByRole("option", { name: "In Progress" }).click(),
  );
  await page.getByRole("combobox", { name: "Change priority" }).click();
  await expectUiWrite(page, "PATCH", `/api/issues/${first.id}`, () =>
    page.getByRole("option", { name: "High" }).click(),
  );
  // The original detail page has no label editor; verify its PATCH contract from this browser flow.
  const labels = await request.patch(`/api/issues/${firstRef}`, {
    headers,
    data: { labels: ["e2e"] },
  });
  expect(labels.ok()).toBeTruthy();
  const labelled = await request.get(`/api/issues/${firstRef}`, {
    headers: { cookie: `CF_Authorization=${assertion}`, "x-workspace-slug": "web1" },
  });
  expect(JSON.parse((await labelled.json()).labels)).toEqual(["e2e"]);
  await page.getByPlaceholder("Add a comment…").fill("E2E comment");
  await expectUiWrite(page, "POST", `/api/issues/${first.id}/comments`, () =>
    page.getByRole("button", { name: "Comment", exact: true }).click(),
  );
  await expect(page.getByText("E2E comment")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).last().click();
  await page.locator("textarea").first().fill("E2E edited comment");
  await expectUiWrite(page, "PATCH", new RegExp(`^/api/issues/${first.id}/comments/[^/]+$`), () =>
    page.getByRole("button", { name: "Save", exact: true }).last().click(),
  );
  await expect(page.getByText("E2E edited comment")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await expectUiWrite(page, "DELETE", new RegExp(`^/api/issues/${first.id}/comments/[^/]+$`), () =>
    page.getByRole("button", { name: "Delete", exact: true }).click(),
  );
  await expect(page.getByText("E2E edited comment")).toHaveCount(0);
  const me = await request.get("/auth/me", {
    headers: { cookie: `CF_Authorization=${assertion}` },
  });
  const actorId = (await me.json()).user.id;
  const assign = await request.patch(`/api/issues/${firstRef}`, {
    headers,
    data: { assigneeId: actorId },
  });
  expect(assign.ok()).toBeTruthy();
  await page.goto("/my-issues");
  await expect(page.getByRole("link", { name: firstRef, exact: true })).toBeVisible();
  await page.goto(`/issues?project=${key}`);
  await page.getByRole("button", { name: "+ New issue" }).click();
  if (await page.getByRole("combobox", { name: "Select project" }).count()) {
    await page.getByRole("combobox", { name: "Select project" }).click();
    await page.getByRole("option", { name: `Issue E2E ${key}` }).click();
  }
  await page.getByPlaceholder("Issue title").fill("E2E linked issue");
  const linkedCreated = page.waitForResponse(
    (response) => response.url().endsWith("/api/issues") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const linkedResponse = await linkedCreated;
  expect(linkedResponse.ok()).toBeTruthy();
  const linked = await linkedResponse.json();
  const linkedRef = `${key}-${linked.number}`;
  await expect(page.getByRole("link", { name: "E2E linked issue" })).toBeVisible();
  await page.getByRole("link", { name: firstRef, exact: true }).click();
  await page.getByRole("button", { name: /Add relation/ }).click();
  await page.getByPlaceholder("PROJ-12").fill(linkedRef);
  await expectUiWrite(page, "POST", `/api/issues/${first.id}/links`, () =>
    page.getByRole("button", { name: "Add", exact: true }).click(),
  );
  await expect(page.getByRole("link", { name: new RegExp(linkedRef) })).toBeVisible();
  await page.goto(`/issues?project=${key}`);
  await page.getByRole("button", { name: "board", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "In Progress column" }).getByText("E2E edited issue"),
  ).toBeVisible();
  await page.getByRole("searchbox", { name: "Search issues" }).fill("E2E edited issue");
  await expect(
    page
      .getByRole("row", { name: new RegExp(firstRef) })
      .getByRole("link", { name: "E2E edited issue" }),
  ).toBeVisible();
});
