import { Hono } from "hono";

const app = new Hono();
app.get("/health", (c) => c.json({ phase: "scaffold", deployable: false }));
app.notFound((c) => c.json({ error: "not_implemented" }, 404));

/** Only scaffold readiness. No authentication or business endpoints exist yet. */
export async function handleHttp(request: Request): Promise<Response> {
  return app.fetch(request);
}
