export async function waitForReady(send, url, secret, options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 120_000;
  let consecutive = 0;
  let status = "network error";
  for (;;) {
    const probe = await send(`${url}/__smoke/migrate`, {
      headers: { "x-smoke-secret": secret },
    }).catch(() => null);
    status = probe?.status ?? "network error";
    consecutive = status === 405 ? consecutive + 1 : 0;
    if (now() >= deadline) throw new Error(`Verification Worker not ready (last status ${status})`);
    if (consecutive === 5) return;
    await sleep(3000);
  }
}

export async function firstRemoteMigration(send, url, init, options = {}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 60_000;
  for (;;) {
    const response = await send(url, init);
    if (response.status !== 403) {
      if (response.status < 200 || response.status >= 300)
        throw new Error(`/__smoke/migrate: HTTP ${response.status}`);
      return response;
    }
    if (now() >= deadline) throw new Error("/__smoke/migrate: HTTP 403");
    await sleep(3000);
  }
}
