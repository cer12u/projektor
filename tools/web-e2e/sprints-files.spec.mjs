import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUiWrite } from "./write-response.mjs";

test("create and start a sprint, assign an issue, upload and link attachments", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(90000);
  const { assertion } = await (await request.get("/__test/assertion")).json();
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  const key = `SF${randomBytes(4).toString("hex").toUpperCase()}`;
  const projectName = `Sprint Files ${key}`;
  const sprintName = `Sprint ${key}`;
  await page.goto("/");
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(projectName);
  await page.getByRole("textbox", { name: "Key" }).fill(key);
  await expectUiWrite(page, "POST", "/api/projects", () =>
    page.getByRole("button", { name: "Create project" }).click(),
  );
  await page.getByRole("link", { name: new RegExp(projectName) }).click();
  await expect(page).toHaveURL(/projectId=/);
  const projectId = new URL(page.url()).searchParams.get("projectId");
  expect(projectId).toBeTruthy();
  await page.goto(`/issues?project=${key}`);
  await page.getByRole("button", { name: "+ New issue" }).click();
  if (await page.getByRole("combobox", { name: "Select project" }).count()) {
    await page.getByRole("combobox", { name: "Select project" }).click();
    await page.getByRole("option", { name: projectName }).click();
  }
  await page.getByPlaceholder("Issue title").fill("Sprint attachment issue");
  const issueCreated = page.waitForResponse(
    (response) => response.url().endsWith("/api/issues") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create issue", exact: true }).click();
  const issueResponse = await issueCreated;
  expect(issueResponse.ok()).toBeTruthy();
  const issue = await issueResponse.json();
  const issueRef = `${key}-${issue.number}`;
  await page.goto(`/sprints?projectId=${projectId}`);
  await page.getByRole("button", { name: "+ New sprint" }).click();
  await page.getByPlaceholder("e.g. Sprint 1").fill(sprintName);
  await expectUiWrite(page, "POST", "/api/sprints", () =>
    page.getByRole("button", { name: "Create sprint" }).click(),
  );
  await expect(page.getByText(sprintName)).toBeVisible();
  await page.getByRole("link", { name: "View issues →" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const sprintId = new URL(page.url()).searchParams.get("sprintId");
  expect(sprintId).toBeTruthy();
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("active");
  await expectUiWrite(page, "PATCH", `/api/sprints/${sprintId}`, () =>
    page.getByRole("button", { name: "Save", exact: true }).click(),
  );
  await expect(page.getByText("active", { exact: true }).first()).toBeVisible();
  await page.goto(`/issues?project=${key}`);
  await page.getByRole("link", { name: issueRef, exact: true }).click();
  await expectUiWrite(page, "PATCH", `/api/issues/${issue.id}`, () =>
    page.getByLabel("Change sprint").selectOption({ label: sprintName }),
  );
  await expect(page.getByLabel("Change sprint")).toHaveValue(/.+/);
  await page.getByRole("button", { name: /Attach file/ }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello sprint"),
  });
  await expectUiWrite(page, "POST", "/api/files", () =>
    page.getByRole("button", { name: "Upload", exact: true }).click(),
  );
  const fileLink = page.getByRole("link", { name: "note.txt" });
  await expect(fileLink).toBeVisible();
  const download = await request.get(
    new URL(await fileLink.getAttribute("href"), "http://127.0.0.1:8789").toString(),
    {
      headers: { cookie: `CF_Authorization=${assertion}`, "x-workspace-slug": "web1" },
    },
  );
  expect(download.ok()).toBeTruthy();
  expect(await download.text()).toBe("hello sprint");
  await page.getByRole("button", { name: /Add URL/ }).click();
  await page.getByPlaceholder("https://example.com/…").fill("https://example.test/doc");
  await page.getByPlaceholder("Label (optional)").fill("Sprint docs");
  await expectUiWrite(page, "POST", "/api/files/links", () =>
    page.getByRole("button", { name: "Add", exact: true }).click(),
  );
  await expect(page.getByRole("link", { name: "Sprint docs" })).toBeVisible();
  await page.goto(`/issues?sprintId=${sprintId}`);
  await expect(page.getByText(sprintName, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: issueRef, exact: true })).toBeVisible();
});
