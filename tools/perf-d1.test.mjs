import assert from "node:assert/strict";
import { test } from "node:test";
import { countD1 } from "./perf-d1.mjs";

test("counts direct calls and one multi-statement batch with rows read", async () => {
  let now = 0;
  const stmt = {
    bind() {
      return this;
    },
    async all() {
      now += 2;
      return { results: [], meta: { rows_read: 4 } };
    },
    async first() {
      now += 3;
      return { id: 1 };
    },
    async run() {
      now += 1;
      return { meta: { rows_read: 2 } };
    },
  };
  const db = {
    prepare() {
      return stmt;
    },
    async batch(statements) {
      assert.deepEqual(statements, [stmt, stmt]);
      now += 5;
      return [{ meta: { rows_read: 3 } }, { meta: { rows_read: 7 } }];
    },
  };
  const meter = countD1(
    db,
    () => now,
    new Map([
      ["a", "access.admission"],
      ["d", "issues.issue"],
    ]),
  );
  await meter.binding.prepare("a").bind(1).all();
  await meter.binding.prepare("b").first();
  await meter.binding.prepare("c").run();
  await meter.binding.batch([meter.binding.prepare("d"), meter.binding.prepare("e").bind(2)]);
  assert.deepEqual(meter.snapshot(), {
    roundTrips: 4,
    statements: 5,
    rowsRead: 16,
    sequentialWaves: 4,
    d1BusyMs: 11,
    statementsByName: { "access.admission": 1, uncataloged: 3, "issues.issue": 1 },
  });
  meter.reset();
  await meter.binding.prepare("again").all();
  assert.deepEqual(meter.snapshot(), {
    roundTrips: 1,
    statements: 1,
    rowsRead: 4,
    sequentialWaves: 1,
    d1BusyMs: 2,
    statementsByName: { uncataloged: 1 },
  });
});
