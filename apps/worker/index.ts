import { createOAuthHttp, handleHttp } from "../../gateway/public";
import { createAccess } from "../../modules/access/internal/factory";
import { createAssets } from "../../modules/assets/internal/factory";
import { createCoordination } from "../../modules/coordination/internal/factory";
import { createInsights } from "../../modules/insights/internal/factory";
import {
  createIntegrations,
  createIntegrationsMaintenance,
} from "../../modules/integrations/internal/factory";
import type { IntegrationsApi } from "../../modules/integrations/public";
import { createIssues } from "../../modules/issues/internal/factory";
import { createLifecycle } from "../../modules/lifecycle/internal/factory";
import { createPlanning } from "../../modules/planning/internal/factory";
import { createProjects } from "../../modules/projects/internal/factory";
import { createWiki } from "../../modules/wiki/internal/factory";
import {
  createModuleStore,
  createRateLimiter,
  createScopedBucket,
  createScopedKV,
  createSecretVault,
} from "../../platform/adapters";
import { randomIds, systemClock } from "../../platform/primitives";
import { PlatformError, type SecretVault } from "../../platform/public";

// Retain the deployed namespaces and their data without restoring the retired
// implementation. These classes have no application bindings or storage access.
export class WorkspaceHub {
  async fetch(): Promise<Response> {
    return new Response("Legacy realtime service is retired", { status: 503 });
  }
}

export class RateLimiter {
  async fetch(): Promise<Response> {
    return new Response("Legacy rate limiter is retired", { status: 503 });
  }
}

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
  readonly INTEGRATIONS_KEY?: string;
  readonly FEEDBACK_LIMIT: RateLimit;
  readonly ADMIN_EMAILS?: string;
  readonly DEFAULT_WORKSPACE_SLUG?: string;
  readonly DEFAULT_WORKSPACE_NAME?: string;
}
function integrationVault(key: string | undefined): SecretVault | undefined {
  try {
    return createSecretVault(key ?? "");
  } catch (error) {
    if (error instanceof PlatformError && error.code === "validation") return undefined;
    throw error;
  }
}
async function integrationsUnavailable(): Promise<never> {
  throw new PlatformError("unavailable", "Integrations unavailable: invalid or missing server key");
}
const unavailableIntegrations: IntegrationsApi = {
  linkExternalRef: integrationsUnavailable,
  unlinkExternalRef: integrationsUnavailable,
  listExternalRefs: integrationsUnavailable,
  registerSource: integrationsUnavailable,
  registerWebhook: integrationsUnavailable,
  listSources: integrationsUnavailable,
  receiveFeedback: integrationsUnavailable,
  convertFeedback: integrationsUnavailable,
  listFeedback: integrationsUnavailable,
  deliverWebhook: integrationsUnavailable,
  getDeliveryStatus: integrationsUnavailable,
};
function compose(env: Env) {
  const adminEmails = new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  const defaultWorkspaceSlug = env.DEFAULT_WORKSPACE_SLUG ?? "projektor";
  const defaultWorkspaceName = env.DEFAULT_WORKSPACE_NAME ?? "Projektor";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(defaultWorkspaceSlug))
    throw new Error("Invalid default workspace slug");
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
    enableBootstrap: adminEmails.size > 0,
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
    access,
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
  const vault = integrationVault(env.INTEGRATIONS_KEY);
  const integrationsModule = vault
    ? createIntegrations({
        store: createModuleStore(env.DB, "integrations"),
        access,
        projects,
        issues,
        wiki,
        clock: systemClock,
        ids: randomIds,
        vault,
        limiter: createRateLimiter(env.FEEDBACK_LIMIT),
        // Native Worker fetch rejects the dependency object as its receiver.
        send: (url, init) => fetch(url, init),
      })
    : {
        api: unavailableIntegrations,
        background: { drain: async () => 0 },
        maintenance: createIntegrationsMaintenance(createModuleStore(env.DB, "integrations")),
      };
  const lifecycleModule = createLifecycle({
    store: createModuleStore(env.DB, "lifecycle"),
    access,
    projects,
    clock: systemClock,
    ids: randomIds,
    owners: {
      access: accessModule.maintenance,
      projects: projectModule.maintenance,
      issues: issueModule.maintenance,
      wiki: wikiModule.maintenance,
      coordination: coordinationModule.maintenance,
      assets: assetModule.maintenance,
      planning: planningModule.maintenance,
      insights: insightsModule.maintenance,
      integrations: integrationsModule.maintenance,
    },
  });
  return {
    background: {
      lifecycle: lifecycleModule.background,
      access: accessModule.background,
      insights: insightsModule.background,
      integrations: integrationsModule.background,
    },
    gateway: {
      lifecycle: lifecycleModule.api,
      access,
      ...(accessModule.operator
        ? {
            bootstrapDefaultWorkspace: async (
              principal: import("../../modules/access/public").AuthenticatedPrincipal,
            ) => {
              const me = await access.me(principal, undefined, 1);
              if (
                me.principal.kind !== "human" ||
                !me.principal.email ||
                !adminEmails.has(me.principal.email.toLowerCase()) ||
                me.workspaces.length
              )
                return;
              try {
                await access.bootstrap(accessModule.operator!, principal, {
                  operationId: crypto.randomUUID(),
                  workspaceId: defaultWorkspaceSlug,
                  name: defaultWorkspaceName,
                });
              } catch (error) {
                if (!(error instanceof PlatformError && error.code === "conflict")) throw error;
              }
            },
          }
        : {}),
      projects,
      issues,
      wiki,
      coordination,
      assets,
      planning,
      insights,
      integrations: integrationsModule.api,
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
    const path = new URL(request.url).pathname;
    if (
      ["/api/", "/mcp/", "/oauth/", "/.well-known/", "/integrations/", "/auth/"].some((prefix) =>
        path.startsWith(prefix),
      ) ||
      path === "/health"
    )
      return handleHttp(request, services.gateway);
    return env.ASSETS.fetch(new Request(new URL(spaFallbackPath(path), request.url)));
  },
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    services ??= compose(env);
    await services.background.lifecycle.tick();
    if (event.cron === "* * * * *") return;
    await services.gateway.assets.drainGc();
    await services.background.integrations.drain();
    await consumeActiveWorkspaces(services.background.access, services.background.insights);
  },
};

export function spaFallbackPath(path: string): string {
  if (/^\/projects\/[^/]+\/issues\/\d+\//.test(path)) return "/issues/view/index.html";
  if (/^\/projects\/view\/[^/]+/.test(path)) return "/projects/view/index.html";
  if (/^\/share\//.test(path)) return "/share/view/index.html";
  if (/^\/feedback\/[^/]+/.test(path)) return "/feedback/view/index.html";
  if (/^\/wiki\/[^/]+\/?$/.test(path)) return "/wiki/view/index.html";
  return "/index.html";
}
