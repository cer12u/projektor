import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUiWrite } from "./write-response.mjs";

test("due date and estimate appear across detail, list, board and sprint", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(90000);
  const { assertion } = await (await request.get("/__test/assertion")).json();
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  const headers = {
    cookie: `CF_Authorization=${assertion}`,
    "x-workspace-slug": "web1",
    origin: "http://127.0.0.1:8789",
  };
  const key = `DE${randomBytes(4).toString("hex").toUpperCase()}`;
  const projectResponse = await request.post("/api/projects", {
    headers,
    data: { name: `Due ${key}`, key },
  });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json();
  const create = async (title) => {
    const response = await request.post("/api/issues", {
      headers,
      data: { projectId: project.id, title, statusId: "status_in_progress" },
    });
    expect(response.status()).toBe(201);
    return response.json();
  };
  const first = await create("Earlier due issue");
  const second = await create("Later due issue");
  const past = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  const future = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 10);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  expect(
    (
      await request.patch(`/api/issues/${key}-${second.number}`, {
        headers,
        data: { dueDate: future },
      })
    ).status(),
  ).toBe(200);
  await page.goto(`/projects/${key}/issues/${first.number}/earlier-due-issue`);
  await expect(page.getByRole("heading", { name: "Earlier due issue" })).toBeVisible();
  await expectUiWrite(page, "PATCH", `/api/issues/${first.id}`, () =>
    page.getByLabel("Due date").fill(past),
  );
  await expect(page.getByLabel("Due date")).toHaveValue(past);
  await page.getByTitle("Edit story points").click();
  await page.locator('input[type="number"]').last().fill("5");
  await expectUiWrite(page, "PATCH", `/api/issues/${first.id}`, () =>
    page.getByRole("heading", { name: "Earlier due issue" }).click(),
  );
  await expect(page.getByText("5 pts")).toBeVisible();
  const sprintResponse = await request.post("/api/sprints", {
    headers,
    data: { projectId: project.id, name: `Sprint ${key}` },
  });
  expect(sprintResponse.status()).toBe(201);
  const sprint = await sprintResponse.json();
  expect(
    (
      await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: "active" } })
    ).status(),
  ).toBe(200);
  await page.reload();
  await expectUiWrite(page, "PATCH", `/api/issues/${first.id}`, () =>
    page.getByLabel("Change sprint").selectOption(sprint.id),
  );
  await page.goto(`/issues?project=${key}`);
  await page.getByRole("combobox", { name: "Sort by" }).click();
  await page.getByRole("option", { name: "Due date" }).click();
  await expect(
    page.getByRole("link", { name: `${key}-${first.number}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("5 SP")).toBeVisible();
  await expect(page.locator(".text-danger-text").first()).toBeVisible();
  await page.getByRole("button", { name: "Overdue" }).click();
  await expect(
    page.getByRole("link", { name: `${key}-${first.number}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: `${key}-${second.number}`, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Overdue" }).click();
  await page.getByRole("button", { name: "board", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "In Progress column" }).getByText("Earlier due issue"),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "In Progress column" }).locator(".text-danger-text").first(),
  ).toBeVisible();
  await page.goto(`/sprints?projectId=${project.id}`);
  await page.getByRole("button", { name: "Complete sprint" }).click();
  await expectUiWrite(page, "PATCH", `/api/sprints/${sprint.id}`, () =>
    page.getByRole("button", { name: "Yes, complete" }).click(),
  );
  await expect(page.getByText("Story points:")).toBeVisible();
  await expect(page.getByText("0/5").first()).toBeVisible();
});
