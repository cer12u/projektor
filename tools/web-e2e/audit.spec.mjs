import { expect, test } from "@playwright/test";

test("07c late decoded response cannot paint after workspace switch", async ({ page }) => {
  // Fetch has completed, but body decoding is delayed. Aborting the network alone
  // cannot suppress this already fulfilled response's continuation.
  await page.addInitScript(() => {
    const send = window.fetch;
    window.fetch = async (url, init) => {
      const response = await send(url, init);
      if (String(url).includes("/api/w/web1/access/workspaces")) {
        const data = await response.json();
        const old = data.map((w) => (w.id === "web2" ? { ...w, name: "STALE WORKSPACE" } : w));
        response.json = () =>
          new Promise((resolve) => {
            window.releaseOld = () => resolve(old);
          });
      }
      return response;
    };
  });
  await page.goto("/?w=web1");
  await expect.poll(() => page.evaluate(() => typeof window.releaseOld)).toBe("function");
  await page.getByRole("button", { name: "切り替え" }).click();
  await page.getByRole("button", { name: "web2", exact: true }).click();
  await expect(page.getByText("web2 · 所有者")).toBeVisible();
  await page.evaluate(async () => {
    window.releaseOld();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.getByText("web2 · 所有者")).toBeVisible();
  await expect(page.getByText(/STALE WORKSPACE/)).toHaveCount(0);
});

test("07c validation error keeps typed input and credential secret dies on navigation", async ({
  page,
  request,
}) => {
  await page.goto("/?w=web1");
  await page.getByLabel("キー").fill("DRAFT");
  await page.getByLabel("名前").fill("入力を保持");
  await page.route("**/api/w/web1/projects/create", (route) =>
    route.fulfill({ status: 400, json: { code: "validation", message: "audit validation error" } }),
  );
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByText("audit validation error")).toBeVisible();
  await expect(page.getByLabel("キー")).toHaveValue("DRAFT");
  await expect(page.getByLabel("名前")).toHaveValue("入力を保持");
  await page.getByRole("button", { name: "管理", exact: true }).click();
  const fixture = await (await request.get("/__test/token?w=web1")).json();
  await page.getByLabel("マシン ID", { exact: true }).fill(fixture.machineId);
  await page.getByLabel("資格情報 ID", { exact: true }).fill("audit-secret");
  await page.getByRole("button", { name: "30 日の書込トークンを発行" }).click();
  const secret = page.locator(".secret");
  await expect(secret).toContainText("pt1.web1.audit-secret.");
  const token = await secret.textContent();
  const raw = token.split(".").at(-1);
  const storage = () => page.evaluate(() => JSON.stringify({ ...localStorage }));
  expect(await storage()).not.toContain(token);
  expect(await storage()).not.toContain(raw);
  await page.getByRole("button", { name: "プロジェクト", exact: true }).click();
  await expect(secret).toHaveCount(0);
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect(secret).toHaveCount(0);
  expect(await page.locator("body").textContent()).not.toContain(token);
  expect(await storage()).not.toContain(raw);
  await page.reload();
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect(secret).toHaveCount(0);
});
