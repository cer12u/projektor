import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUiWrite } from "./write-response.mjs";

test("settings token and signed feedback flow", async ({ page, request, context }) => {
  test.setTimeout(90000);
  const { assertion } = await (await request.get("/__test/assertion")).json();
  await context.addCookies([
    { name: "CF_Authorization", value: assertion, url: "http://127.0.0.1:8789" },
  ]);
  await page.goto("/");
  const suffix = randomUUID().slice(0, 8);
  const projectName = `Feedback E2E ${suffix}`;
  const sourceName = `E2E Widget ${suffix}`;
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.goto("/settings/tokens");
  await expect(page.getByText("/mcp/", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "+ New token" }).click();
  await page.getByRole("textbox", { name: "Name *" }).fill("E2E Agent");
  await expectUiWrite(page, "POST", "/api/workspaces/web1/tokens", () =>
    page.getByRole("button", { name: "Create token" }).click(),
  );
  await expect(page.getByText("Token created:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("table").getByText("E2E Agent")).toBeVisible();
  const tokenRow = page.getByRole("row").filter({ hasText: "E2E Agent" });
  await tokenRow.getByRole("button", { name: "Revoke" }).click();
  await expectUiWrite(page, "DELETE", /^\/api\/workspaces\/web1\/tokens\/[^/]+$/, () =>
    tokenRow.getByRole("button", { name: "Yes" }).click(),
  );
  await expect(page.getByRole("table").getByText("E2E Agent")).toHaveCount(0);

  await page.goto("/");
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(projectName);
  await page
    .getByRole("textbox", { name: "Key" })
    .fill(`FB${randomUUID().slice(0, 8).toUpperCase()}`);
  await expectUiWrite(page, "POST", "/api/projects", () =>
    page.getByRole("button", { name: "Create project" }).click(),
  );
  await page.getByRole("link", { name: new RegExp(projectName) }).click();
  await expect(page).toHaveURL(/projectId=/);
  const projectId = new URL(page.url()).searchParams.get("projectId");
  expect(projectId).toBeTruthy();
  await page.goto(`/feedback?projectId=${projectId}`);
  await page.getByRole("button", { name: "+ New source" }).click();
  await page.getByRole("textbox", { name: "Name *" }).fill(sourceName);
  await expectUiWrite(page, "POST", `/api/projects/${projectId}/feedback-sources`, () =>
    page.getByRole("button", { name: "Create source" }).click(),
  );
  const secret = await page.getByRole("dialog").locator("code").textContent();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  await page.getByRole("button", { name: "Done" }).click();
  const sources = await context.request.get(`/api/projects/${projectId}/feedback-sources`, {
    headers: { "x-workspace-slug": "web1" },
  });
  const source = (await sources.json()).find((item) => item.name === sourceName);
  const payload = JSON.stringify({ title: "E2E feedback", body: "Feedback E2E body" });
  const timestamp = Math.floor(Date.now() / 1000),
    deliveryId = randomUUID();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.${payload}`)
    .digest("hex");
  const incoming = await request.post(`/integrations/feedback/web1/${source.id}`, {
    headers: {
      "content-type": "application/json",
      "x-projektor-timestamp": String(timestamp),
      "x-projektor-delivery-id": deliveryId,
      "x-projektor-signature": signature,
    },
    data: payload,
  });
  expect(incoming.ok()).toBeTruthy();
  await page.getByRole("link", { name: new RegExp(sourceName) }).click();
  await expect(page.getByRole("table").getByText("Feedback E2E body")).toBeVisible();
  await expectUiWrite(
    page,
    "POST",
    new RegExp(`^/api/projects/${projectId}/feedback/[^/]+/convert-to-issue$`),
    () => page.getByRole("button", { name: "Convert to issue" }).first().click(),
  );
  await expect(page.getByRole("table").getByText("actioned")).toBeVisible();
});
