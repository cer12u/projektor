/**
 * Deploy-only migration entry point. tools/cloudflare-deploy.mjs uploads it as a
 * short-lived Worker bound to the production D1, calls it once with a per-job secret
 * and deletes it again. It exposes nothing but the migration ledger.
 */
import { migrate } from "../platform/migrate";

/** Production owners in manifest order, injected by tools/build.mjs. */
declare const __MIGRATION_OWNERS__: Parameters<typeof migrate>[1];

interface Env {
  readonly DB: D1Database;
  readonly MIGRATE_SECRET: string;
}

const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/__migrate") return reply({ error: "not_found" }, 404);
    if (!env.MIGRATE_SECRET || request.headers.get("x-migrate-secret") !== env.MIGRATE_SECRET)
      return reply({ error: "forbidden" }, 403);
    // GET is the side-effect-free readiness probe for the fresh deploy.
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    try {
      await migrate(env.DB, __MIGRATION_OWNERS__);
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_schema_versions").first<{
        n: number;
      }>();
      return reply({ migrations: row?.n ?? 0, owners: __MIGRATION_OWNERS__ });
    } catch (error) {
      return reply({ error: error instanceof Error ? error.message : "migration failed" }, 500);
    }
  },
};
