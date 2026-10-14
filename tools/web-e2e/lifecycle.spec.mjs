import { expect, test } from "@playwright/test";

test("owner can confirm a project purge and recover its durable job after reload", async ({
  page,
  request,
}) => {
  const projectId = crypto.randomUUID();
  const key = `P${projectId.slice(0, 7).toUpperCase()}`;
  const created = await request.post("/api/w/web1/projects/create", {
    data: { operationId: crypto.randomUUID(), projectId, key, name: "Lifecycle E2E" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto("/?w=web1");
  await page.getByRole("button", { name: `${key} · Lifecycle E2E` }).click();
  await page.getByRole("button", { name: "管理", exact: true }).click();
  const projectZone = page.getByRole("region", { name: "プロジェクトの削除" });
  await expect(projectZone.getByText(`対象 ID: ${projectId}`)).toBeVisible();
  const confirmation = projectZone.getByLabel("削除を確認するため対象 ID を正確に入力");
  const start = projectZone.getByRole("button", { name: "削除を開始" });
  await expect(start).toBeDisabled();
  await confirmation.fill(`${projectId}-wrong`);
  await expect(start).toBeDisabled();
  await confirmation.fill(projectId);
  await expect(start).toBeEnabled();
  await start.click();
  await expect(projectZone.getByText(/ジョブ .* · (凍結中|削除中|完了)/)).toBeVisible();
  await expect(projectZone.getByRole("button", { name: "削除を開始" })).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "管理", exact: true }).click();
  const recovered = page.getByRole("region", { name: "プロジェクトの削除" });
  const jobLine = recovered.getByText(/ジョブ .* · (凍結中|削除中|完了)/);
  await expect(jobLine).toBeVisible();
  if (await recovered.getByRole("button", { name: "削除を再開" }).count()) {
    const initialVersion = Number((await jobLine.innerText()).match(/v(\d+)/)?.[1]);
    let failed = true;
    await page.route("**/api/w/web1/lifecycle/resumePurge", async (route) => {
      if (failed) {
        failed = false;
        await route.fulfill({
          status: 503,
          json: { code: "unavailable", message: "一時的に再開できません" },
        });
      } else await route.continue();
    });
    await recovered.getByRole("button", { name: "削除を再開" }).click();
    await expect(recovered.getByRole("status")).toContainText("一時的に再開できません");
    await recovered.getByRole("button", { name: "削除を再開" }).click();
    await expect
      .poll(async () => Number((await jobLine.innerText()).match(/v(\d+)/)?.[1]))
      .toBeGreaterThan(initialVersion);
    await page.unroute("**/api/w/web1/lifecycle/resumePurge");
  }
  await recovered.getByRole("button", { name: "状態を更新" }).click();
  await expect(recovered.getByText(/ジョブ .* · (凍結中|削除中|完了)/)).toBeVisible();
});
