import { createOAuthHttp, handleHttp } from "../../gateway/public";
import { createAccess } from "../../modules/access/internal/factory";
import { createAssets } from "../../modules/assets/internal/factory";
import { createCoordination } from "../../modules/coordination/internal/factory";
import { createInsights } from "../../modules/insights/internal/factory";
import { createIssues } from "../../modules/issues/internal/factory";
import { createPlanning } from "../../modules/planning/internal/factory";
import { createProjects } from "../../modules/projects/internal/factory";
import { createWiki } from "../../modules/wiki/internal/factory";
import {
  createModuleStore,
  createRateLimiter,
  createScopedBucket,
  createScopedKV,
} from "../../platform/adapters";
import { randomIds, systemClock } from "../../platform/primitives";

export interface Env {
  readonly DB: D1Database;
  readonly R2: R2Bucket;
  readonly KV: KVNamespace;
  readonly ASSETS: Fetcher;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUDIENCE: string;
  readonly OAUTH_ISSUER?: string;
  readonly OAUTH_RESOURCE?: string;
  readonly OAUTH_FORM_SECRET?: string;
  readonly OAUTH_REGISTER_LIMIT?: RateLimit;
  readonly OAUTH_TOKEN_LIMIT?: RateLimit;
}
function compose(env: Env) {
  const configured = !!(env.OAUTH_ISSUER || env.OAUTH_RESOURCE || env.OAUTH_FORM_SECRET);
  if (
    configured &&
    (!env.OAUTH_ISSUER ||
      env.OAUTH_RESOURCE !== `${env.OAUTH_ISSUER}/mcp` ||
      !env.OAUTH_FORM_SECRET ||
      !env.OAUTH_REGISTER_LIMIT ||
      !env.OAUTH_TOKEN_LIMIT)
  )
    throw new Error("Incomplete OAuth configuration");
  const accessModule = createAccess({
    store: createModuleStore(env.DB, "access"),
    kv: createScopedKV(env.KV, "access"),
    clock: systemClock,
    ids: randomIds,
    config: { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUDIENCE },
    ...(env.OAUTH_ISSUER && env.OAUTH_RESOURCE
      ? { oauth: { issuer: env.OAUTH_ISSUER, resource: env.OAUTH_RESOURCE } }
      : {}),
  });
  const access = accessModule.api;
  const projectModule = createProjects({
    store: createModuleStore(env.DB, "projects"),
    access,
    clock: systemClock,
    ids: randomIds,
    eventConsumer: "insights",
  });
  const projects = projectModule.api;
  const issueModule = createIssues({
    store: createModuleStore(env.DB, "issues"),
    access,
    projects,
    clock: systemClock,
    ids: randomIds,
    eventConsumer: "insights",
  });
  const issues = issueModule.api;
  const wikiModule = createWiki({
    store: createModuleStore(env.DB, "wiki"),
    projects,
    clock: systemClock,
    ids: randomIds,
    eventConsumer: "insights",
  });
  const wiki = wikiModule.api;
  const coordinationModule = createCoordination({
    store: createModuleStore(env.DB, "coordination"),
    access,
    issues,
    projects,
    clock: systemClock,
    ids: randomIds,
    eventConsumer: "insights",
  });
  const coordination = coordinationModule.api;
  const assetModule = createAssets({
    store: createModuleStore(env.DB, "assets"),
    bucketFor: (workspaceId) => createScopedBucket(env.R2, "assets", workspaceId),
    access,
    projects,
    issues,
    wiki,
    clock: systemClock,
    ids: randomIds,
    eventConsumer: "insights",
  });
  const assets = assetModule.api;
  const planningModule = createPlanning({
    store: createModuleStore(env.DB, "planning"),
    access,
    projects,
    issues,
    clock: systemClock,
    ids: randomIds,
    eventConsumer: "insights",
  });
  const planning = planningModule.api;
  if (
    !projectModule.eventReader ||
    !issueModule.eventReader ||
    !wikiModule.eventReader ||
    !coordinationModule.eventReader ||
    !assetModule.eventReader ||
    !planningModule.eventReader
  )
    throw new Error("Insights event capabilities unavailable");
  const insightsModule = createInsights({
    store: createModuleStore(env.DB, "insights"),
    access,
    projects,
    issues,
    wiki,
    coordination,
    planning,
    assets,
    readers: {
      projects: { api: projects, cap: projectModule.eventReader },
      issues: { api: issues, cap: issueModule.eventReader },
      wiki: { api: wiki, cap: wikiModule.eventReader },
      coordination: { api: coordination, cap: coordinationModule.eventReader },
      planning: { api: planning, cap: planningModule.eventReader },
      assets: { api: assets, cap: assetModule.eventReader },
    },
    clock: systemClock,
    ids: randomIds,
  });
  const insights = insightsModule.api;
  const oauthHttp =
    env.OAUTH_ISSUER &&
    env.OAUTH_RESOURCE &&
    env.OAUTH_FORM_SECRET &&
    env.OAUTH_REGISTER_LIMIT &&
    env.OAUTH_TOKEN_LIMIT
      ? createOAuthHttp(
          {
            issuer: env.OAUTH_ISSUER,
            resource: env.OAUTH_RESOURCE,
            formSecret: env.OAUTH_FORM_SECRET,
            clock: systemClock,
            registerLimit: createRateLimiter(env.OAUTH_REGISTER_LIMIT),
            tokenLimit: createRateLimiter(env.OAUTH_TOKEN_LIMIT),
          },
          access,
        )
      : undefined;
  return {
    background: { access: accessModule.background, insights: insightsModule.background },
    gateway: {
      access,
      projects,
      issues,
      wiki,
      coordination,
      assets,
      planning,
      insights,
      oauthHttp,
      oauthOrigin: env.OAUTH_ISSUER,
    },
  };
}

export async function consumeActiveWorkspaces(
  discovery: ReturnType<typeof createAccess>["background"],
  consumer: ReturnType<typeof createInsights>["background"],
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await discovery.listActiveWorkspaceIds(cursor, 100);
    for (const workspaceId of page.workspaceIds) await consumer.consumeEvents(workspaceId, 100);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

// One composition per isolate keeps the verifier’s bounded trusted JWKS cache.
let services: ReturnType<typeof compose> | undefined;
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    services ??= compose(env);
    return handleHttp(request, services.gateway);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    services ??= compose(env);
    await services.gateway.assets.drainGc();
    await consumeActiveWorkspaces(services.background.access, services.background.insights);
  },
};
