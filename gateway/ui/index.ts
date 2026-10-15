import type { AuthenticatedPrincipal, RequestScope, Workspace } from "../../modules/access/public";
import type { Project } from "../../modules/projects/public";
import { PlatformError } from "../../platform/public";
import type { Services } from "../catalog";

type Authenticate = (
  request: Request,
  services: Services,
  endpoint: "rest",
) => Promise<AuthenticatedPrincipal>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const unsupported = () => json({ error: "Not implemented" }, 501);
const bad = (message: string): never => {
  throw new PlatformError("validation", message);
};
const projectResponse = (p: Project, workspaceId: string, cap: number | null) => ({
  id: p.id,
  workspaceId,
  name: p.name,
  key: p.key,
  slug: p.slug,
  description: p.description || null,
  agentWipLimit: cap,
  epicAutoClose: false,
  archivedAt: p.archived ? p.updatedAt : null,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});
async function workspaces(
  services: Services,
  principal: AuthenticatedPrincipal,
): Promise<Workspace[]> {
  const result: Workspace[] = [];
  let cursor: string | undefined;
  do {
    const page = await services.access.me(principal, cursor, 100);
    result.push(...page.workspaces);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}
async function scopeFor(
  request: Request,
  services: Services,
  principal: AuthenticatedPrincipal,
  requestId: string,
  mode: "read" | "write" = "read",
) {
  const all = await workspaces(services, principal);
  const url = new URL(request.url);
  const header = request.headers.get("x-workspace-slug");
  const label = url.hostname.split(".")[0];
  const workspaceId =
    header || (all.some((w) => w.id === label) ? label : all.length === 1 ? all[0].id : null);
  if (!workspaceId)
    throw new PlatformError(
      "validation",
      "Workspace not specified: missing X-Workspace-Slug header",
    );
  const scope = await services.access.requireMembership(principal, workspaceId, requestId, mode);
  return { scope, workspace: all.find((w) => w.id === workspaceId) };
}
async function input(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
    bad("Expected application/json");
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    bad("Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("Expected object");
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null && field === "description") return "";
  if (typeof value !== "string") bad(`Invalid ${field}`);
  return value as string;
}
async function resolveProject(
  services: Services,
  scope: RequestScope,
  param: string,
): Promise<Project> {
  try {
    return await services.projects.getProject(scope, param);
  } catch (error) {
    if (!(error instanceof PlatformError && error.code === "not_found")) throw error;
    return services.projects.getProjectBySlug(scope, param);
  }
}
async function capFor(services: Services, scope: RequestScope, id: string): Promise<number | null> {
  if (!services.coordination) return null;
  const limit = await services.coordination.getProjectLimit(scope, id);
  return limit.version === 0 ? null : limit.cap;
}
function failure(error: unknown): Response {
  if (error instanceof PlatformError) {
    const status = {
      validation: 400,
      not_found: 404,
      forbidden: 403,
      conflict: 409,
      unavailable: 503,
      unknown: 500,
    }[error.code];
    return json({ error: error.code === "conflict" ? "Conflict" : error.message }, status);
  }
  return json({ error: "Internal error" }, 500);
}
export async function handleUi(
  request: Request,
  services: Services,
  authenticate: Authenticate,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path === "/auth/login" && request.method === "GET") {
      const target = url.searchParams.get("redirect_url") ?? "/";
      const redirect =
        target.startsWith("/") && !target.startsWith("//") && !target.startsWith("/\\")
          ? new URL(target, url.origin)
          : new URL("/", url.origin);
      return Response.redirect(
        (redirect.origin === url.origin ? redirect : new URL("/", url.origin)).toString(),
        302,
      );
    }
    if (path === "/api/health" && request.method === "GET") return json({ ok: true });
    if (path === "/api/config/brand" && request.method === "GET")
      return json({ name: "Projektor", mark: "P", accent: null, onAccent: null, logoUrl: null });
    if (path === "/auth/me" && request.method === "GET") {
      const principal = await authenticate(request, services, "rest");
      await services.bootstrapDefaultWorkspace?.(principal);
      const me = await services.access.me(principal);
      const all = await workspaces(services, principal);
      return json({
        user: { id: me.principal.id, email: me.principal.email, name: me.principal.displayName },
        workspaces: all.map((w) => ({ id: w.id, name: w.name, slug: w.id, role: w.role })),
        auth:
          me.principal.kind === "human"
            ? { kind: "human", method: "access", principalKind: "user" }
            : { kind: "agent", method: "pk", principalKind: "machine" },
      });
    }
    if (path.startsWith("/auth/")) return unsupported();
    if (!path.startsWith("/api/")) return unsupported();
    const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (!workspaceMatch && path !== "/api/projects" && !projectMatch) return unsupported();
    const principal = await authenticate(request, services, "rest");
    const { scope, workspace } = await scopeFor(
      request,
      services,
      principal,
      requestId,
      request.method === "GET" ? "read" : "write",
    );
    if (workspaceMatch && request.method === "GET") {
      if (workspaceMatch[1] !== scope.workspaceId)
        throw new PlatformError("forbidden", "Access denied");
      const members = [];
      let cursor: string | undefined;
      do {
        const page = await services.access.listMembers(scope, cursor, 100);
        members.push(
          ...page.items.map((m) => ({
            id: m.principalId,
            email: m.email,
            name: m.displayName,
            avatarUrl: null,
            role: m.role,
            joinedAt: 0,
          })),
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return json({
        id: scope.workspaceId,
        name: workspace?.name ?? scope.workspaceId,
        slug: scope.workspaceId,
        members,
        currentUserRole: scope.role,
      });
    }
    if (path === "/api/projects" && request.method === "GET") {
      const projects: Project[] = [];
      let cursor: string | undefined;
      do {
        const page = await services.projects.listVisibleProjects(scope, cursor, 100);
        projects.push(...page.projects);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return json(
        projects.map((p) => ({
          id: p.id,
          name: p.name,
          key: p.key,
          slug: p.slug,
          description: p.description || null,
          workspace_id: scope.workspaceId,
          workspace_name: workspace?.name ?? scope.workspaceId,
          workspace_slug: scope.workspaceId,
          open_issue_count: 0,
          backlog_issue_count: 0,
          archived_at: null,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
        })),
      );
    }
    if (path === "/api/projects" && request.method === "POST") {
      const body = await input(request);
      if (typeof body.name !== "string" || typeof body.key !== "string")
        bad("Invalid project input");
      const created = await services.projects.createProject(scope, {
        operationId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        name: body.name as string,
        key: body.key as string,
        description: optionalString(body.description, "description"),
        slug: optionalString(body.slug, "slug"),
      });
      const p = await services.projects.getProject(scope, created.id);
      return json({ id: p.id, name: p.name, key: p.key, slug: p.slug }, 201);
    }
    if (projectMatch && request.method === "GET") {
      const p = await resolveProject(services, scope, decodeURIComponent(projectMatch[1]));
      return json(projectResponse(p, scope.workspaceId, await capFor(services, scope, p.id)));
    }
    if (projectMatch && request.method === "PATCH") {
      const body = await input(request);
      if (Object.hasOwn(body, "epic_auto_close")) return unsupported();
      if (Object.hasOwn(body, "agent_wip_limit") && !services.coordination) return unsupported();
      const p = await resolveProject(services, scope, decodeURIComponent(projectMatch[1]));
      if (Object.hasOwn(body, "agent_wip_limit")) {
        if (typeof body.agent_wip_limit !== "number") bad("Invalid agent_wip_limit");
        const limit = await services.coordination.getProjectLimit(scope, p.id);
        await services.coordination.setProjectLimit(scope, {
          operationId: crypto.randomUUID(),
          projectId: p.id,
          cap: body.agent_wip_limit as number,
          expectedVersion: limit.version,
        });
      }
      if (["name", "key", "description", "slug"].some((key) => Object.hasOwn(body, key))) {
        await services.projects.updateProject(scope, {
          operationId: crypto.randomUUID(),
          projectId: p.id,
          expectedVersion: p.version,
          name: optionalString(body.name, "name"),
          key: optionalString(body.key, "key"),
          description: optionalString(body.description, "description"),
          slug: optionalString(body.slug, "slug"),
        });
      }
      return json({ ok: true });
    }
    return unsupported();
  } catch (error) {
    return failure(error);
  }
}
