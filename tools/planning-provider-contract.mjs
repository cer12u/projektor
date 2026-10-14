import assert from "node:assert/strict";

// The historical-read contract consumed by Planning, executed on fakes and owners.
export async function planningHistoricalContract({ get, authorized, denied, id, archive }) {
  assert.equal((await get(authorized, id)).archived, false);
  await assert.rejects(get(denied, id), (e) => e.code === "not_found");
  await assert.rejects(get({ ...authorized }, id), (e) => e.code === "forbidden");
  await assert.rejects(get(authorized, "missing"), (e) => e.code === "not_found");
  await archive();
  assert.equal((await get(authorized, id)).archived, true);
  await assert.rejects(get(denied, id), (e) => e.code === "not_found");
}
