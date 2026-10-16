import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUiWrite } from "./write-response.mjs";

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
  const title = `Wiki E2E ${randomBytes(4).toString("hex")}`;
  await page.goto("/wiki");
  await page.getByRole("button", { name: "+ New page" }).click();
  await page.getByPlaceholder("Page title").fill(title);
  await expectUiWrite(page, "POST", "/api/wiki", () =>
    page.getByRole("button", { name: "Create page", exact: true }).click(),
  );
  await expect(page).toHaveURL(new RegExp(`/wiki/${title.toLowerCase().replaceAll(" ", "-")}$`));
  await expect(page.getByText(title).first()).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Title" }).fill(`${title} edited`);
  await expectUiWrite(page, "PUT", /^\/api\/wiki\/[^/]+$/, () =>
    page.getByRole("button", { name: "Save", exact: true }).first().click(),
  );
  await expect(page.getByText(`${title} edited`).first()).toBeVisible();
  await page.getByRole("button", { name: /History/ }).click();
  await expect(page.getByText(`${title} edited`).first()).toBeVisible();
  await page.getByRole("searchbox", { name: "Search wiki pages" }).fill(`${title} edited`);
  await expect(page.getByText(`${title} edited`).first()).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await expectUiWrite(page, "DELETE", /^\/api\/wiki\/[^/]+$/, () =>
    page.getByRole("button", { name: "Delete", exact: true }).first().click(),
  );
  await expect(page).toHaveURL(/\/wiki\/?$/);
});
