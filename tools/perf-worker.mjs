import { catalogs } from "../platform/generated/catalogs.ts";
import { countD1 } from "./perf-d1.mjs";

const names = new Map();
for (const [owner, catalog] of Object.entries(catalogs))
  for (const [name, sql] of Object.entries(catalog.queries)) names.set(sql, `${owner}.${name}`);

export function instrumentWorker(worker) {
  let meter;
  return {
    async fetch(request, env, ctx) {
      meter ??= countD1(env.DB, () => performance.now(), names);
      meter.reset();
      const start = performance.now();
      const response = await worker.fetch(request, { ...env, DB: meter.binding }, ctx);
      const wallMs = performance.now() - start;
      const result = new Response(response.body, response);
      result.headers.set(
        "x-perf-probe",
        JSON.stringify({
          ...meter.snapshot(),
          wallMs,
          cpuApproxMs: Math.max(0, wallMs - meter.snapshot().d1BusyMs),
        }),
      );
      return result;
    },
  };
}
