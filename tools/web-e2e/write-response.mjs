import { expect } from "@playwright/test";

export async function expectUiWrite(page, method, path, action) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      (typeof path === "string"
        ? new URL(response.url()).pathname === path
        : path.test(new URL(response.url()).pathname)),
  );
  await action();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  return response;
}
