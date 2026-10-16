import { expect, test } from "@playwright/test";

test("original Wiki UI creates, edits, searches, reads history and deletes a page", async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(90000);
  const { assertion } = await (await request.get("/__test/assertion")).json();
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  await page.goto("/wiki");
  await page.getByRole("button", { name: "+ New page" }).click();
  await page.getByPlaceholder("Page title").fill("Wiki E2E");
  await page.getByRole("button", { name: "Create page", exact: true }).click();
  await expect(page).toHaveURL(/\/wiki\/wiki-e2e/);
  await expect(page.getByText("Wiki E2E").first()).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Title" }).fill("Wiki E2E edited");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Wiki E2E edited").first()).toBeVisible();
  await page.getByRole("button", { name: /History/ }).click();
  await expect(page.getByText("Wiki E2E edited").first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Search wiki pages" }).fill("Wiki E2E edited");
  await expect(page.getByText("Wiki E2E edited").first()).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await expect(page).toHaveURL(/\/wiki\/?$/);
});
