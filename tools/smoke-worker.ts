/** Verification-only entry point. Built once with the production catalogs. */
import gateway, { type Env as GatewayEnv } from "../apps/worker/index";
import { createModuleStore, createSecretVault } from "../platform/adapters";
import { migrate } from "../platform/migrate";

interface Env extends GatewayEnv {
  readonly R2: R2Bucket;
  readonly SMOKE_ENABLED: string;
  readonly SMOKE_SECRET: string;
}

/** Production owners in manifest order, injected by tools/build.mjs. */
declare const __MIGRATION_OWNERS__: Parameters<typeof migrate>[1];
const owners = __MIGRATION_OWNERS__;
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^smoke_[a-z0-9_]{8,80}$/.test(value);

async function bootstrap(env: Env, value: unknown): Promise<string> {
  if (!value || typeof value !== "object") throw new Error("Invalid bootstrap body");
  const { workspaceId, secret } = value as Record<string, unknown>;
  if (!validId(workspaceId) || typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret))
    throw new Error("Invalid smoke workspace or secret");
  const principalId = `bot_${workspaceId}`;
  const db = env.DB;
  // Verification-only seed: machine credentials must never gain source administration.
  const feedbackSecret = await createSecretVault(env.INTEGRATIONS_KEY ?? "").inboundSecret(
    `${workspaceId}:smoke`,
  );
  const feedbackHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(feedbackSecret))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const tokenHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare("INSERT INTO access_workspaces(workspace_id,name,version) VALUES(?,?,1)")
      .bind(workspaceId, "Smoke"),
    db
      .prepare("INSERT INTO access_principals(id,kind,issuer,subject) VALUES(?,'machine',?,?)")
      .bind(principalId, `machine:${workspaceId}`, principalId),
    db
      .prepare(
        "INSERT INTO access_memberships(workspace_id,principal_id,role,active,version) VALUES(?,?,'member',1,1)",
      )
      .bind(workspaceId, principalId),
    db
      .prepare(
        "INSERT INTO access_credentials(workspace_id,id,principal_id,token_hash,scope,expires_at,version) VALUES(?,'smoke',?,?,'write',?,1)",
      )
      .bind(workspaceId, principalId, tokenHash, now + 3600),
    db
      .prepare(
        "INSERT INTO projects_projects(workspace_id,id,project_key,name,version,description,slug,created_at,updated_at) VALUES(?,'smoke','SMOKE','Smoke',1,'','smoke',?,?)",
      )
      .bind(workspaceId, now, now),
    db
      .prepare(
        "INSERT INTO projects_grants(workspace_id,project_id,principal_id,role,active) VALUES(?,'smoke',?,'editor',1)",
      )
      .bind(workspaceId, principalId),
    db
      .prepare(
        "INSERT INTO integrations_sources(workspace_id,id,project_id,name,secret_hash,webhook_events) VALUES(?,'smoke','smoke','Smoke',?,'[]')",
      )
      .bind(workspaceId, feedbackHash),
  ]);
  return feedbackSecret;
}

async function probes(env: Env, workspaceId: string) {
  if (!validId(workspaceId)) throw new Error("Invalid smoke workspace");
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO issues_guards(workspace_id,id,changed) VALUES(?,?,1)").bind(
        workspaceId,
        id,
      ),
      env.DB.prepare("INSERT INTO issues_guards(workspace_id,id,changed) VALUES(?,?,0)").bind(
        workspaceId,
        `${id}_fail`,
      ),
    ]);
    throw new Error("D1 accepted a failing batch");
  } catch (error) {
    if (error instanceof Error && error.message === "D1 accepted a failing batch") throw error;
    if (!(error instanceof Error) || !/CHECK constraint failed/i.test(error.message)) throw error;
  }
  const rollback = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM issues_guards WHERE workspace_id=? AND id=?",
  )
    .bind(workspaceId, id)
    .first<{ n: number }>();
  if (rollback?.n !== 0) throw new Error("D1 batch did not roll back");
  const binds = Array.from({ length: 100 }, () => "?").join("+");
  const hundred = await env.DB.prepare(`SELECT ${binds} AS n`)
    .bind(...Array(100).fill(1))
    .first<{ n: number }>();
  if (hundred?.n !== 100) throw new Error("D1 100-bind query failed");
  try {
    await createModuleStore(env.DB, "access").run("principal", Array(101).fill("x"));
    throw new Error("101 binds were accepted");
  } catch (error) {
    if (!(error instanceof Error) || !/100 binds/.test(error.message)) throw error;
  }
  const key = `smoke/${workspaceId}`;
  await env.R2.put(key, "smoke");
  if ((await (await env.R2.get(key))?.text()) !== "smoke") throw new Error("R2 read failed");
  await env.R2.delete(key);
  if (await env.R2.get(key)) throw new Error("R2 cleanup failed");
  return { rollback: true, binds: 100, r2Cleanup: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__smoke/")) return gateway.fetch(request, env);
    if (
      env.SMOKE_ENABLED !== "1" ||
      !env.SMOKE_SECRET ||
      request.headers.get("x-smoke-secret") !== env.SMOKE_SECRET
    )
      return reply({ error: "forbidden" }, 403);
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    try {
      if (path === "/__smoke/migrate") {
        await migrate(env.DB, owners);
        const rows = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM platform_schema_versions",
        ).first<{ n: number }>();
        return reply({ migrations: rows?.n });
      }
      const body: unknown = await request.json();
      if (path === "/__smoke/bootstrap") {
        const feedbackSecret = await bootstrap(env, body);
        return reply({ bootstrapped: true, feedbackSecret });
      }
      if (path === "/__smoke/probes") {
        const workspaceId = (body as { workspaceId?: unknown })?.workspaceId;
        if (!validId(workspaceId)) throw new Error("Invalid smoke workspace");
        return reply(await probes(env, workspaceId));
      }
      if (path === "/__smoke/receipt") {
        const { workspaceId, operationId } = body as {
          workspaceId?: unknown;
          operationId?: unknown;
        };
        if (
          !validId(workspaceId) ||
          typeof operationId !== "string" ||
          !/^[a-z0-9_-]{1,80}$/.test(operationId)
        )
          throw new Error("Invalid receipt query");
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM issues_receipts WHERE workspace_id=? AND operation_id=?",
        )
          .bind(workspaceId, operationId)
          .first<{ n: number }>();
        return reply({ receipts: row?.n });
      }
      return reply({ error: "not_found" }, 404);
    } catch (error) {
      return reply(
        { error: error instanceof Error ? error.message : "Unknown smoke failure" },
        500,
      );
    }
  },
};
