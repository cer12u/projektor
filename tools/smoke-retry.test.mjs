import assert from "node:assert/strict";
import test from "node:test";
import { firstRemoteMigration, waitForReady } from "./smoke-retry.mjs";

test("readiness needs five consecutive responses from the new version", async () => {
  let time = 0;
  const statuses = [405, 405, 403, 405, 405, 405, 405, 405];
  await waitForReady(async () => ({ status: statuses.shift() }), "https://example.test", "secret", {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  assert.equal(statuses.length, 0);
});

test("only first remote migration retries 403", async () => {
  let time = 0;
  const statuses = [403, 403, 200];
  const response = await firstRemoteMigration(
    async () => ({ status: statuses.shift() }),
    "url",
    {},
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(time, 6000);
});

test("remote migration fails after 60 seconds of 403 and immediately on 500", async () => {
  let time = 0;
  let calls = 0;
  const options = {
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  await assert.rejects(
    firstRemoteMigration(
      async () => {
        calls++;
        return { status: 403 };
      },
      "url",
      {},
      options,
    ),
    /HTTP 403/,
  );
  assert.equal(time, 60000);
  assert.equal(calls, 21);
  calls = 0;
  await assert.rejects(
    firstRemoteMigration(
      async () => {
        calls++;
        return { status: 500 };
      },
      "url",
      {},
      options,
    ),
    /HTTP 500/,
  );
  assert.equal(calls, 1);
});
