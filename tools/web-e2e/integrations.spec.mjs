import { expect, test } from "@playwright/test";

const api = (name) => `/api/w/web1/${name.replaceAll(".", "/")}`;
test("external refs, feedback inbox, source and webhook administration", async ({
  page,
  request,
}) => {
  const tag = crypto.randomUUID().slice(0, 8);
  const projectId = `int-${tag}`,
    issueId = `issue-${tag}`,
    pageId = `page-${tag}`;
  for (const [name, data] of [
    [
      "projects.create",
      {
        operationId: crypto.randomUUID(),
        projectId,
        key: `I${tag.toUpperCase()}`,
        name: "Integrations E2E",
      },
    ],
    [
      "issues.create",
      {
        operationId: crypto.randomUUID(),
        issueId,
        projectId,
        title: "Linked issue",
        description: "",
        priority: "medium",
      },
    ],
    [
      "wiki.create",
      {
        operationId: crypto.randomUUID(),
        pageId,
        projectId,
        slug: `guide-${tag}`,
        title: "Linked page",
        body: "Guide",
      },
    ],
  ]) {
    const response = await request.post(api(name), { data });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await page.goto("/?w=web1");
  await page
    .getByRole("button", { name: new RegExp(`I${tag.toUpperCase()} · Integrations E2E`) })
    .click();
  await page.getByRole("button", { name: /Linked issue/ }).click();
  const issueRefs = page.getByRole("heading", { name: "外部参照" }).locator("..");
  for (const unsafeUrl of ["http://github.com/example/project/issues/1", "javascript:alert(1)"]) {
    await issueRefs.getByLabel("外部参照 URL").fill(unsafeUrl);
    const rejected = page.waitForResponse((response) =>
      response.url().endsWith(api("integrations.link")),
    );
    await issueRefs.getByRole("button", { name: "追加" }).click();
    expect((await rejected).status()).toBe(400);
    await expect(issueRefs.getByRole("status")).toContainText("Invalid HTTPS URL");
    await expect(issueRefs.getByLabel("外部参照 URL")).toHaveValue(unsafeUrl);
    await expect(issueRefs.getByRole("link")).toHaveCount(0);
    await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  }
  await issueRefs.getByLabel("外部参照 URL").fill("https://github.com/example/project/issues/1");
  await issueRefs.getByRole("button", { name: "追加" }).click();
  await expect(issueRefs.getByRole("link", { name: /github_issue/ })).toBeVisible();
  await page.getByRole("button", { name: "Wiki" }).click();
  await page.getByRole("button", { name: /Linked page/ }).click();
  const wikiRefs = page.getByRole("heading", { name: "外部参照" }).locator("..");
  await wikiRefs.getByLabel("外部参照の種類").selectOption("gitlab_mr");
  await wikiRefs
    .getByLabel("外部参照 URL")
    .fill("https://gitlab.com/example/project/-/merge_requests/1");
  await wikiRefs.getByRole("button", { name: "追加" }).click();
  await expect(wikiRefs.getByRole("link", { name: /gitlab_mr/ })).toBeVisible();
  await page.getByRole("button", { name: "管理" }).click();
  const admin = page.getByRole("heading", { name: "外部連携" }).locator("..");
  await admin.getByLabel("Project ID").fill(projectId);
  await admin.getByLabel("名前", { exact: true }).fill("Form source");
  await admin.getByRole("button", { name: "受信ソースを作成" }).click();
  await expect(admin.getByLabel("作成した秘密鍵")).toBeVisible();
  const secret = await admin.getByLabel("作成した秘密鍵").textContent();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  const sources = await (await request.get(api("integrations.sources"))).json();
  const source = sources.items.find((x) => x.name === "Form source" && x.projectId === projectId);
  expect(source).toBeTruthy();
  expect(JSON.stringify(sources)).not.toContain(secret);
  await page.getByRole("button", { name: "フィードバック" }).click();
  await page.getByRole("button", { name: "管理" }).click();
  await expect(admin.getByLabel("作成した秘密鍵")).toHaveCount(0);
  await expect(admin).not.toContainText(secret);
  await admin.getByLabel("Source ID").fill(source.id);
  await admin.getByLabel("HTTPS URL").fill("https://example.com/hook");
  await admin.getByRole("button", { name: "Webhook を設定" }).click();
  await expect(admin.getByText("https://example.com/hook")).toBeVisible();
  await expect(admin.getByLabel("作成した秘密鍵")).toBeVisible();
  const webhookSecret = await admin.getByLabel("作成した秘密鍵").textContent();
  expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  expect(webhookSecret).not.toBe(secret);
  await page.reload();
  await page.getByRole("button", { name: "管理" }).click();
  await expect(admin.getByText("https://example.com/hook")).toBeVisible();
  await expect(admin.getByLabel("作成した秘密鍵")).toHaveCount(0);
  await expect(admin).not.toContainText(secret);
  await expect(admin).not.toContainText(webhookSecret);
  const listedSources = await (await request.get(api("integrations.sources"))).json();
  expect(JSON.stringify(listedSources)).not.toContain(secret);
  expect(JSON.stringify(listedSources)).not.toContain(webhookSecret);
  const feedbackTitle = `From feedback ${tag}`;
  const body = JSON.stringify({ title: feedbackTitle, body: "Details" });
  const timestamp = Math.floor(Date.now() / 1000),
    deliveryId = `delivery-${tag}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${deliveryId}.${body}`),
    ),
  ).toString("hex");
  const feedbackRequest = {
    data: body,
    headers: {
      "content-type": "application/json",
      "x-projektor-timestamp": String(timestamp),
      "x-projektor-delivery-id": deliveryId,
      "x-projektor-signature": signature,
    },
  };
  const feedback = await request.post(`/integrations/feedback/web1/${source.id}`, feedbackRequest);
  expect(feedback.ok(), await feedback.text()).toBeTruthy();
  const received = await feedback.json();
  const duplicate = await request.post(`/integrations/feedback/web1/${source.id}`, feedbackRequest);
  expect(duplicate.ok(), await duplicate.text()).toBeTruthy();
  expect(await duplicate.json()).toEqual(received);
  await page.getByRole("button", { name: "フィードバック" }).click();
  const feedbackRow = page
    .getByRole("listitem")
    .filter({ has: page.getByText(feedbackTitle, { exact: true }) });
  await expect(feedbackRow).toHaveCount(1);
  const conversion = page.waitForResponse((response) =>
    response.url().endsWith(api("integrations.convert")),
  );
  await feedbackRow.getByRole("button", { name: "Issue に変換" }).click();
  const converted = await conversion;
  expect(converted.ok()).toBeTruthy();
  const convertedBody = await converted.json();
  await expect(
    feedbackRow.getByText(`Issue ${convertedBody.issueId}`, { exact: true }),
  ).toBeVisible();
  await expect(feedbackRow.getByRole("button", { name: "Issue に変換" })).toHaveCount(0);
  const retry = await request.post(api("integrations.convert"), {
    data: converted.request().postDataJSON(),
  });
  expect(retry.ok(), await retry.text()).toBeTruthy();
  expect(await retry.json()).toEqual(convertedBody);
  const issues = await (await request.get(`${api("issues.list")}?projectId=${projectId}`)).json();
  expect(issues.issues.filter((issue) => issue.title === feedbackTitle)).toHaveLength(1);
  await page.getByRole("button", { name: "管理" }).click();
  await page.getByRole("button", { name: "フィードバック" }).click();
  await expect(feedbackRow).toHaveCount(1);
  await expect(
    feedbackRow.getByText(`Issue ${convertedBody.issueId}`, { exact: true }),
  ).toBeVisible();
  await expect(feedbackRow.getByRole("button", { name: "Issue に変換" })).toHaveCount(0);
});
