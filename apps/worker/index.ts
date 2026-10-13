import { handleHttp } from "../../gateway/public";
import { createAccess } from "../../modules/access/internal/factory";
import { createIssues } from "../../modules/issues/internal/factory";
import { createProjects } from "../../modules/projects/internal/factory";
import { createWiki } from "../../modules/wiki/internal/factory";
import { createModuleStore, createScopedKV } from "../../platform/adapters";
import { randomIds, systemClock } from "../../platform/primitives";

export interface Env {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly ASSETS: Fetcher;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUDIENCE: string;
  readonly OAUTH_ISSUER?: string;
  readonly OAUTH_RESOURCE?: string;
}
function compose(env: Env) {
  const access = createAccess({
    store: createModuleStore(env.DB, "access"),
    kv: createScopedKV(env.KV, "access"),
    clock: systemClock,
    ids: randomIds,
    config: { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUDIENCE },
    ...(env.OAUTH_ISSUER && env.OAUTH_RESOURCE
      ? { oauth: { issuer: env.OAUTH_ISSUER, resource: env.OAUTH_RESOURCE } }
      : {}),
  }).api;
  const projects = createProjects({
    store: createModuleStore(env.DB, "projects"),
    access,
    clock: systemClock,
    ids: randomIds,
  }).api;
  const issues = createIssues({
    store: createModuleStore(env.DB, "issues"),
    access,
    projects,
    clock: systemClock,
    ids: randomIds,
  }).api;
  const wiki = createWiki({
    store: createModuleStore(env.DB, "wiki"),
    projects,
    clock: systemClock,
    ids: randomIds,
  }).api;
  return { access, projects, issues, wiki };
}

// One composition per isolate keeps the verifier’s bounded trusted JWKS cache.
let services: ReturnType<typeof compose> | undefined;
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    services ??= compose(env);
    return handleHttp(request, services);
  },
};
