import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUiWrite } from "./write-response.mjs";

test("original project UI loads, creates a project, and opens its slug route", async ({
  page,
  request,
  context,
}) => {
  const fixture = await request.get("/__test/assertion");
  expect(fixture.ok()).toBeTruthy();
  const { assertion } = await fixture.json();
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  const suffix = randomBytes(4).toString("hex");
  const key = `FO${suffix.toUpperCase()}`;
  const name = `Foundation Project ${suffix}`;
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Key" }).fill(key);
  await expectUiWrite(page, "POST", "/api/projects", () =>
    page.getByRole("button", { name: "Create project" }).click(),
  );
  const card = page.getByRole("link", { name });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", `/projects/view/${key.toLowerCase()}`);
  await card.click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/view/${key.toLowerCase()}\\?projectId=[0-9a-f-]{36}$`),
  );
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
});
