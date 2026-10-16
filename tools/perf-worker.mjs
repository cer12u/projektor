import worker from "../dist/worker.js";
import { countD1 } from "./perf-d1.mjs";

let meter;
export default {
  async fetch(request, env, ctx) {
    meter ??= countD1(env.DB);
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
