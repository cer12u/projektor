import { expect, test } from "@playwright/test";

const workspace = "web1";
const api = (name) => `/api/w/${workspace}/${name.replace(".", "/")}`;
test("first login discovers workspaces and opens the project list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "web1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "web2" })).toBeVisible();
  await page.getByRole("button", { name: "さらに読み込む" }).click();
  await expect(page.getByRole("button", { name: "zz-web-100" })).toBeVisible();
  await page.getByRole("button", { name: "web1" }).click();
  await expect(page.getByRole("heading", { name: "プロジェクト", exact: true })).toBeVisible();
});
async function get(request, name, args = {}) {
  const url = new URL(api(name), "http://127.0.0.1:8789");
  for (const [key, value] of Object.entries(args)) url.searchParams.set(key, String(value));
  const response = await request.get(url.toString());
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function post(request, name, args) {
  const response = await request.post(api(name), { data: args });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
test("project, issue, MCP agent attribution, wiki conflict and activity", async ({
  page,
  request,
}) => {
  await page.goto(`/?w=${workspace}`);
  await expect(page.getByRole("heading", { name: "プロジェクト", exact: true })).toBeVisible();
  await page.getByLabel("キー").fill("WEB");
  await page.getByLabel("名前").fill("Web E2E");
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page.getByRole("button", { name: /WEB · Web E2E/ })).toBeVisible();
  const project = (await get(request, "projects.list")).projects.find((p) => p.key === "WEB");
  const fixture = await (await request.get("/__test/token?w=web1")).json();
  await post(request, "projects.grant", {
    operationId: crypto.randomUUID(),
    expectedVersion: 1,
    projectId: project.id,
    principalId: fixture.machineId,
    role: "editor",
  });
  await page.getByRole("button", { name: /WEB · Web E2E/ }).click();
  await page.getByLabel("タイトル").fill("日本語の課題");
  await page.getByLabel("説明").fill("初期内容");
  const bodies = [];
  let lost = true;
  await page.route("**/api/w/web1/issues/create", async (route) => {
    bodies.push(route.request().postData());
    if (lost) {
      lost = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page.getByText(/結果が不明です/)).toBeVisible();
  await expect(page.getByLabel("タイトル")).toHaveValue("日本語の課題");
  await page.getByRole("button", { name: "同じ操作を再試行" }).click();
  await expect(page.getByRole("button", { name: /日本語の課題/ })).toBeVisible();
  expect(bodies[0]).toBe(bodies[1]);
  await page.unroute("**/api/w/web1/issues/create");
  const issue = (await get(request, "issues.list", { projectId: project.id })).issues[0];
  await page.getByRole("button", { name: /日本語の課題/ }).click();
  await page.getByRole("heading", { name: `${issue.reference} の詳細` }).waitFor();
  const detail = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: `${issue.reference} の詳細` }) });
  await detail.getByLabel("タイトル").fill("日本語の課題 更新");
  await detail.getByRole("button", { name: "保存" }).click();
  await expect(detail.getByText("edit", { exact: true })).toBeVisible();
  await detail.getByLabel("状態").selectOption("in_progress");
  await detail.getByRole("button", { name: "状態を変更" }).click();
  await expect(detail.getByText("transition", { exact: true })).toBeVisible();
  await detail.getByLabel("コメント").fill("人からのコメント");
  await detail.getByRole("button", { name: "コメントを追加" }).click();
  await expect(detail.getByText("comment", { exact: true })).toBeVisible();
  await detail.getByLabel("アップロード").setInputFiles({
    name: "issue-log.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("issue attachment"),
  });
  const attachment = detail.getByRole("link", { name: /ダウンロード/ });
  await expect(attachment).toBeVisible();
  const attachmentResponse = await request.get(await attachment.getAttribute("href"));
  expect(attachmentResponse.ok()).toBeTruthy();
  expect(await attachmentResponse.text()).toBe("issue attachment");
  const token = fixture.token;
  const current = await get(request, "issues.get", { issueId: issue.id });
  const mcp = await request.post(`/mcp/${workspace}`, {
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "issues.comment",
        arguments: {
          operationId: crypto.randomUUID(),
          issueId: issue.id,
          commentId: crypto.randomUUID(),
          expectedVersion: current.version,
          body: "Agent via MCP",
        },
      },
    },
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
  });
  expect(mcp.ok(), await mcp.text()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: /WEB · Web E2E/ }).click();
  await page.getByRole("button", { name: /日本語の課題 更新/ }).click();
  await expect(page.getByText(/エージェント m_/)).toBeVisible();
  await page.getByRole("button", { name: "Wiki" }).click();
  await page.getByLabel("URL 名").fill("home");
  await page.getByLabel("タイトル").fill("ホーム");
  await page
    .getByLabel("本文（Markdown）")
    .fill(
      '# 最初の版\n<script>window.xss=1</script><img src=x onerror="window.xss=2"><a href="javascript:window.xss=3" onclick="window.xss=4">unsafe</a><svg onload="window.xss=5"></svg>',
    );
  await page.getByRole("button", { name: "作成" }).click();
  await page.getByRole("button", { name: "ホーム" }).click();
  const wiki = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: "ホーム" }) });
  await expect(wiki.getByText("最初の版")).toBeVisible();
  await wiki.getByLabel("アップロード").setInputFiles({
    name: "wiki.patch",
    mimeType: "text/plain",
    buffer: Buffer.from("wiki patch"),
  });
  const wikiAttachment = wiki.getByRole("link", { name: /ダウンロード/ });
  await expect(wikiAttachment).toBeVisible();
  expect(await (await request.get(await wikiAttachment.getAttribute("href"))).text()).toBe(
    "wiki patch",
  );

  await expect(wiki.locator("img")).toHaveAttribute("src", "x");
  expect(await wiki.locator("img").getAttribute("onerror")).toBeNull();
  await expect(wiki.locator(".markdown script, .markdown svg")).toHaveCount(0);
  expect(await wiki.getByText("unsafe", { exact: true }).getAttribute("href")).toBeNull();
  expect(await wiki.getByText("unsafe", { exact: true }).getAttribute("onclick")).toBeNull();
  expect(await page.evaluate(() => window.xss)).toBeUndefined();
  const pageData = (await get(request, "wiki.list", { projectId: project.id })).pages[0];
  await wiki.getByLabel("本文（Markdown）").fill("# 自分の下書き");
  await post(request, "wiki.edit", {
    operationId: crypto.randomUUID(),
    pageId: pageData.id,
    expectedVersion: pageData.version,
    title: "他者の版",
    body: "# 新しい版",
  });
  await wiki.getByRole("button", { name: "保存" }).click();
  await expect(wiki.getByText(/編集が競合しました/)).toBeVisible();
  await expect(wiki.getByLabel("本文（Markdown）")).toHaveValue("# 自分の下書き");
  const session = await request.post(`/mcp/${workspace}`, {
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "coordination.start",
        arguments: {
          operationId: crypto.randomUUID(),
          sessionId: "claude-code",
          agentLabel: "Claude Code",
          clientKind: "Claude Code",
        },
      },
    },
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
  });
  expect(session.ok(), await session.text()).toBeTruthy();
  const lease = await request.post(`/mcp/${workspace}`, {
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "coordination.acquire",
        arguments: {
          operationId: crypto.randomUUID(),
          sessionId: "claude-code",
          issueId: issue.id,
        },
      },
    },
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
  });
  expect(lease.ok(), await lease.text()).toBeTruthy();
  await page.getByRole("button", { name: "エージェント活動" }).click();
  await expect(page.getByText("Claude Code", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/フェンシングトークン/)).toBeVisible();
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByLabel("マシン ID").fill("browser-agent");
  await page.getByRole("button", { name: "登録" }).click();
  await expect(page.getByLabel("マシン ID")).toHaveValue(/^m_/);
  await page.getByLabel("資格情報 ID").fill("browser-key");
  await page.getByRole("button", { name: "30 日の書込トークンを発行" }).click();
  await expect(page.getByText(/pt1\.web1\.browser-key\./)).toBeVisible();
  await page.getByRole("button", { name: "表示を閉じる" }).click();
  await expect(page.getByText(/pt1\.web1\.browser-key\./)).toHaveCount(0);
  const oauth = await (await request.get("/__test/oauth?w=web1")).json();
  const oauthHeaders = {
    authorization: `Bearer ${oauth.token}`,
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  };
  const oauthCall = () =>
    request.post(`/mcp/${workspace}`, {
      data: {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "issues.list", arguments: { projectId: project.id } },
      },
      headers: oauthHeaders,
    });
  expect((await oauthCall()).status()).toBe(200);
  await page.getByRole("button", { name: "管理", exact: true }).click();
  const oauthRow = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: "OAuth クライアント" }) })
    .locator("li")
    .filter({ hasText: oauth.clientId });
  await expect(oauthRow).toContainText("有効");
  const revokes = [];
  let lostRevokeResponse = true;
  await page.route("**/api/w/web1/access/oauthClients/revoke", async (route) => {
    revokes.push(route.request().postData());
    if (lostRevokeResponse) {
      lostRevokeResponse = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await oauthRow.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText(/結果が不明です/)).toBeVisible();
  await page.getByRole("button", { name: "同じ操作を再試行" }).click();
  await expect(oauthRow).toContainText("無効");
  expect(revokes[0]).toBe(revokes[1]);
  await page.unroute("**/api/w/web1/access/oauthClients/revoke");
  expect((await oauthCall()).status()).toBe(401);
  let release;
  await page.route("**/api/w/web1/projects/list*", async (route) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({ json: { projects: [project], nextCursor: null } });
  });
  await page.getByRole("button", { name: "プロジェクト", exact: true }).click();
  await expect.poll(() => typeof release).toBe("function");
  await page.getByRole("button", { name: "切り替え" }).click();
  await page.getByRole("button", { name: "web2" }).click();
  release();
  await expect(page.getByText("web2 · 所有者")).toBeVisible();
  await expect(page.getByRole("button", { name: /WEB · Web E2E/ })).toHaveCount(0);
});

test("mobile workspace and project flow remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "web2" })).toBeVisible();
  await page.getByRole("button", { name: "web2" }).click();
  await expect(page.getByRole("heading", { name: "プロジェクト", exact: true })).toBeVisible();
  await page.getByLabel("キー").fill("MOB");
  await page.getByLabel("名前").fill("携帯確認");
  await page.getByRole("button", { name: "作成" }).click();
  await expect(page.getByRole("button", { name: /MOB · 携帯確認/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
