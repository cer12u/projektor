import { expect, test } from "@playwright/test";

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
  await expect(page.getByText("No projects yet.")).toBeVisible();
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Foundation Project");
  await expect(page.getByRole("textbox", { name: "Key" })).toHaveValue("FOUNDATION");
  await page.getByRole("button", { name: "Create project" }).click();
  const card = page.getByRole("link", { name: /Foundation Project/ });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", "/projects/view/foundation");
  await card.click();
  await expect(page).toHaveURL(/\/projects\/view\/foundation$/);
  await expect(page.getByRole("heading", { level: 1, name: "Foundation Project" })).toBeVisible();
});
