import type {
  AuthenticatedPrincipal,
  MemberItem,
  RequestScope,
  Workspace,
} from "../../modules/access/public";
import type { AssetLink, AssetTarget } from "../../modules/assets/public";
import type {
  Issue,
  IssueFilters,
  IssueLink,
  IssuePriority,
  TaskStatus,
  TaskType,
} from "../../modules/issues/public";
import type { Sprint } from "../../modules/planning/public";
import type { Project } from "../../modules/projects/public";
import type { WikiPage, WikiRevision } from "../../modules/wiki/public";
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
const noExpiry = Number.MAX_SAFE_INTEGER;
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
  first?: Awaited<ReturnType<Services["access"]["me"]>>,
): Promise<Workspace[]> {
  const result: Workspace[] = [...(first?.workspaces ?? [])];
  let cursor: string | undefined = first?.nextCursor ?? undefined;
  if (first && !cursor) return result;
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
const comma = (value: string | null) =>
  value === null
    ? undefined
    : value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
const flag = (value: string | null) => value === "true" || value === "1";
const epoch = (value: string | null) => (value === null ? undefined : Number(value));
const priorityValue = (value: unknown): IssuePriority => {
  if (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "urgent"
  )
    return value;
  return bad("Invalid priority");
};
async function visibleProjects(services: Services, scope: RequestScope): Promise<Project[]> {
  const all: Project[] = [];
  let cursor: string | undefined;
  do {
    const page = await services.projects.listVisibleProjects(scope, cursor, 100);
    all.push(...page.projects);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}
async function members(services: Services, scope: RequestScope): Promise<Map<string, MemberItem>> {
  const result = new Map<string, MemberItem>();
  let cursor: string | undefined;
  do {
    const page = await services.access.listMembers(scope, cursor, 100);
    for (const member of page.items) result.set(member.principalId, member);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result;
}
async function allSources(services: Services, scope: RequestScope) {
  const items: Awaited<ReturnType<Services["integrations"]["listSources"]>>["items"][number][] = [];
  let cursor: string | undefined;
  do {
    const page = await services.integrations.listSources(scope, cursor, 50);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}
async function projectFeedback(services: Services, scope: RequestScope, projectId: string) {
  await services.projects.authorizeProject(scope, projectId, "read");
  const items: Awaited<ReturnType<Services["integrations"]["listFeedback"]>>["items"][number][] =
    [];
  let cursor: string | undefined;
  do {
    const page = await services.integrations.listFeedback(scope, cursor, 50);
    items.push(...page.items.filter((item) => item.projectId === projectId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}
const sourceShape = (
  source: Awaited<ReturnType<Services["integrations"]["listSources"]>>["items"][number],
) => ({
  id: source.id,
  projectId: source.projectId,
  name: source.name,
  description: null,
  isActive: true,
  allowedOrigins: null,
  tokenPreview: null,
  createdAt: 0,
  revokedAt: null,
});
async function issueRef(services: Services, scope: RequestScope, ref: string): Promise<Issue> {
  const match = ref.match(/^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$/);
  if (!match) return services.issues.getIssue(scope, { issueId: ref });
  const project = (await visibleProjects(services, scope)).find((item) => item.key === match[1]);
  if (!project) throw new PlatformError("not_found", "Issue not found");
  return services.issues.getIssue(scope, { projectId: project.id, number: Number(match[2]) });
}
const taskStatus = (value: TaskStatus) => ({
  id: value.id,
  key: value.key,
  name: value.name,
  category: value.category,
  color: value.color,
  position: value.position,
  is_default: value.isDefault,
  is_review_step: value.isReviewStep,
});
const taskType = (value: TaskType) => ({
  id: value.id,
  key: value.key,
  name: value.name,
  color: value.color,
  icon: value.icon,
  position: value.position,
  is_default: value.isDefault,
});
function issueShape(
  issue: Issue,
  workspaceId: string,
  project: Project | undefined,
  people: Map<string, MemberItem>,
  statuses: readonly TaskStatus[],
  types: readonly TaskType[],
  body: boolean,
  sprintId: string | null = null,
) {
  const status = statuses.find((item) => item.id === issue.statusId);
  const type = types.find((item) => item.id === issue.typeId);
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return {
    id: issue.id,
    workspace_id: workspaceId,
    project_id: issue.projectId,
    number: issue.number,
    title: issue.title,
    status: issue.status,
    status_id: issue.statusId,
    status_key: status?.key ?? issue.status,
    status_name: status?.name ?? null,
    status_category: issue.statusCategory,
    priority: issue.priority,
    assignee_id: issue.assigneeId,
    assignee_name: issue.assigneeId ? (people.get(issue.assigneeId)?.displayName ?? null) : null,
    labels: JSON.stringify(issue.labels),
    parent_id: issue.parentId,
    type_id: issue.typeId,
    type_key: type?.key ?? null,
    type_name: type?.name ?? null,
    sprint_id: sprintId,
    created_by_id: issue.createdById,
    author_kind: issue.createdByKind === "machine" ? "agent" : "human",
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    completed_at: issue.completedAt,
    needs_audit: false,
    project_key: project?.key ?? null,
    project_name: project?.name ?? null,
    customFields: [],
    url: project ? `/projects/${project.key}/issues/${issue.number}/${slug}` : null,
    ...(body ? { body: issue.description } : {}),
  };
}
const linkShape = (link: IssueLink) => {
  const ref = link.otherIssue.reference.match(/^(.+)-([0-9]+)$/);
  return {
    id: link.id,
    type: link.type,
    linkedIssueId: link.otherIssue.id,
    linkedIssueTitle: link.otherIssue.title,
    linkedIssueNumber: ref ? Number(ref[2]) : 0,
    linkedIssueProjectKey: ref?.[1] ?? "",
    linkedIssueStatusCategory: link.otherIssue.statusCategory,
    createdById: "",
    createdAt: 0,
  };
};
const deferredIssueFields = ["customFields", "completionReport", "remainder", "agentSessionId"];
const sprintShape = (s: Sprint, workspaceId: string) => ({
  id: s.id,
  workspaceId,
  projectId: s.projectId,
  name: s.name,
  goal: s.goal,
  status: s.status,
  startDate: s.startDate,
  endDate: s.endDate,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});
const fileShape = (a: AssetLink) => ({
  id: a.id,
  kind: a.kind === "link" ? "url" : "file",
  filename: a.filename,
  contentType: a.contentType,
  size: a.size,
  url: a.url,
  createdAt: a.createdAt,
  wikiPage: null,
});
const wikiListShape = (p: WikiPage) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  parent_id: p.parentId,
  project_id: p.projectId,
  updated_at: p.updatedAt,
  url: `/wiki/${p.slug}`,
  type: null,
  tags: [],
  status: null,
  verified_at: null,
  verified_by: null,
  owners: [],
  verify_interval: null,
  is_template: false,
});
const wikiDetailShape = (p: WikiPage) => ({
  ...wikiListShape(p),
  content: p.body,
  revisionId: String(p.version),
  freshness: null,
});
const wikiRevisionShape = (r: WikiRevision, people: Map<string, MemberItem>) => ({
  id: String(r.version),
  title: r.title,
  summary: null,
  author_id: r.actorId,
  author_name: people.get(r.actorId)?.displayName ?? null,
  created_at: r.occurredAt,
});
function fileTarget(kind: unknown, entityId: unknown): AssetTarget {
  if (typeof entityId !== "string") bad("Invalid entityId");
  if (kind === "issue") return { kind: "issue", id: entityId as string };
  if (kind === "wiki_page") return { kind: "wiki", id: entityId as string };
  return bad("Invalid entityType");
}
async function assignSprint(
  services: Services,
  scope: RequestScope,
  issueId: string,
  next: string | null,
) {
  const old = (await services.planning.sprintsForIssues(scope, [issueId]))[issueId] ?? null;
  if (old === next) return;
  if (old) {
    const sprint = await services.planning.getSprint(scope, old);
    await services.planning.unscheduleIssue(scope, {
      operationId: crypto.randomUUID(),
      sprintId: old,
      issueId,
      expectedVersion: sprint.version,
    });
  }
  if (next) {
    const sprint = await services.planning.getSprint(scope, next);
    await services.planning.scheduleIssue(scope, {
      operationId: crypto.randomUUID(),
      sprintId: next,
      issueId,
      expectedVersion: sprint.version,
    });
  }
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
      const all = await workspaces(services, principal, me);
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
    if (
      !workspaceMatch &&
      path !== "/api/projects" &&
      !projectMatch &&
      !/^\/api\/projects\/[^/]+\/flow-metrics$/.test(path) &&
      !path.startsWith("/api/sprints") &&
      !path.startsWith("/api/files") &&
      !path.startsWith("/api/issues") &&
      !path.startsWith("/api/wiki") &&
      !path.startsWith("/api/feedback-sources") &&
      path !== "/api/task-statuses" &&
      path !== "/api/task-types" &&
      !/^\/api\/projects\/[^/]+\/feedback(?:-sources)?(?:\/|$)/.test(path) &&
      !/^\/api\/workspaces\/[^/]+\/(?:tokens|connectors|mcp-info)(?:\/|$)/.test(path)
    )
      return unsupported();
    const principal = await authenticate(request, services, "rest");
    const { scope, workspace } = await scopeFor(
      request,
      services,
      principal,
      requestId,
      request.method === "GET" ? "read" : "write",
    );
    const settings = path.match(
      /^\/api\/workspaces\/([^/]+)\/(tokens|connectors|mcp-info)(?:\/([^/]+))?$/,
    );
    if (settings) {
      if (decodeURIComponent(settings[1]) !== scope.workspaceId)
        throw new PlatformError("forbidden", "Access denied");
      const section = settings[2],
        itemId = settings[3];
      if (section === "mcp-info" && request.method === "GET" && !itemId) {
        const mcpUrl = `${url.origin}/mcp/${scope.workspaceId}`;
        return json({
          mcpUrl,
          workspaceId: scope.workspaceId,
          workspaceSlug: scope.workspaceId,
          mcpAddCommandTemplate: `claude mcp add --transport http --header "Authorization: Bearer {{TOKEN}}" --header "X-Workspace-Slug: ${scope.workspaceId}" -- projektor "${mcpUrl}"`,
          ...(services.oauthOrigin ? { oauth: { issuer: services.oauthOrigin } } : {}),
        });
      }
      if (section === "tokens") {
        if (request.method === "GET" && !itemId) {
          const items = [];
          let cursor: string | undefined;
          do {
            const page = await services.access.listCredentials(scope, cursor, 100);
            items.push(
              ...page.items
                .filter((c) => !c.revoked)
                .map((c) => ({
                  id: c.id,
                  name: c.name,
                  userId: c.principalId,
                  issuedByUserId: null,
                  workspaceId: scope.workspaceId,
                  scopes: JSON.stringify(c.scope === "write" ? ["read", "write"] : ["read"]),
                  lastUsedAt: null,
                  expiresAt: c.expiresAt === noExpiry ? null : c.expiresAt,
                  createdAt: c.createdAt,
                })),
            );
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          return json(items);
        }
        if (request.method === "POST" && !itemId) {
          const me = await services.access.meForScope(scope);
          if (me.principal.kind !== "human" || scope.clientId)
            throw new PlatformError("forbidden", "Human session required");
          const body = await input(request);
          if (typeof body.name !== "string" || !body.name.trim()) bad("Invalid name");
          if (
            body.scopes !== undefined &&
            (!Array.isArray(body.scopes) || body.scopes.some((s) => s !== "read" && s !== "write"))
          )
            bad("Invalid scopes");
          const scopes = (body.scopes ?? ["read", "write"]) as string[];
          const permission = scopes.includes("write") ? "write" : "read";
          const days = body.expiresInDays;
          if (days !== undefined && (!Number.isSafeInteger(days) || (days as number) <= 0))
            bad("Invalid expiresInDays");
          if (
            body.expiresAt !== undefined &&
            (!Number.isSafeInteger(body.expiresAt) ||
              (body.expiresAt as number) <= Date.now() / 1000)
          )
            bad("Invalid expiresAt");
          const expiresAt =
            typeof body.expiresAt === "number"
              ? body.expiresAt
              : typeof days === "number"
                ? Math.floor(Date.now() / 1000) + days * 86400
                : noExpiry;
          const principalId = crypto.randomUUID();
          const machine = await services.access.provisionMachine(scope, {
            operationId: crypto.randomUUID(),
            principalId,
            role: permission === "write" ? "member" : "viewer",
          });
          const credentialId = crypto.randomUUID();
          const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
          await services.access.issueCredential(scope, {
            operationId: crypto.randomUUID(),
            principalId: machine.id,
            credentialId,
            secret,
            scope: permission,
            expiresAt,
            name: body.name as string,
          });
          return json(
            {
              id: credentialId,
              token: `pt1.${scope.workspaceId}.${credentialId}.${secret}`,
              name: body.name,
              scopes,
              expiresAt: expiresAt === noExpiry ? null : expiresAt,
              userId: machine.id,
              issuedByUserId: scope.principalId,
              workspaceId: scope.workspaceId,
            },
            201,
          );
        }
        if (request.method === "DELETE" && itemId) {
          const me = await services.access.meForScope(scope);
          if (me.principal.kind !== "human" || scope.clientId)
            throw new PlatformError("forbidden", "Human session required");
          const credential = await services.access.getCredential(scope, itemId);
          await services.access.revokeCredential(scope, {
            operationId: crypto.randomUUID(),
            credentialId: itemId,
            expectedVersion: credential.version,
          });
          return json({ ok: true });
        }
      }
      if (section === "connectors") {
        if (request.method === "GET" && !itemId) {
          const items = [];
          let cursor: string | undefined;
          do {
            const page = await services.access.listOAuthClients(scope, cursor, 100);
            items.push(
              ...page.items
                .filter((c) => !c.revoked)
                .map((c) => ({
                  id: c.clientId,
                  client: c.name,
                  clientId: c.clientId,
                  scopes: [],
                  grantedAt: 0,
                  expiresAt: 0,
                })),
            );
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          return json(items);
        }
        if (request.method === "DELETE" && itemId) {
          const client = await services.access.getOAuthClient(scope, itemId);
          await services.access.revokeOAuthClient(scope, {
            operationId: crypto.randomUUID(),
            clientId: itemId,
            expectedVersion: client.version,
          });
          return json({ ok: true });
        }
      }
      return unsupported();
    }
    const feedbackProject = path.match(
      /^\/api\/projects\/([^/]+)\/(feedback|feedback-sources)(?:\/([^/]+)(?:\/(convert-to-issue|rotate))?)?$/,
    );
    if (feedbackProject) {
      const project = await resolveProject(services, scope, decodeURIComponent(feedbackProject[1]));
      const section = feedbackProject[2],
        itemId = feedbackProject[3],
        action = feedbackProject[4];
      if (section === "feedback-sources") {
        if (request.method === "GET" && !itemId)
          return json(
            (await allSources(services, scope))
              .filter((s) => s.projectId === project.id)
              .map(sourceShape),
          );
        if (request.method === "POST" && !itemId) {
          const body = await input(request);
          if (typeof body.name !== "string") bad("Invalid name");
          const result = await services.integrations.registerSource(scope, {
            operationId: crypto.randomUUID(),
            sourceId: crypto.randomUUID(),
            projectId: project.id,
            name: body.name as string,
          });
          return json({ id: result.id, token: result.secret }, 201);
        }
      }
      if (section === "feedback") {
        if (request.method === "GET" && !itemId) {
          const sources =
            scope.role === "owner" || scope.role === "admin"
              ? (await allSources(services, scope)).filter((s) => s.projectId === project.id)
              : [];
          const names = new Map(sources.map((s) => [s.id, s.name]));
          const sourceId = url.searchParams.get("sourceId"),
            status = url.searchParams.get("status");
          const rows = await projectFeedback(services, scope, project.id);
          return json(
            rows
              .filter(
                (f) =>
                  (!sourceId || f.sourceId === sourceId) &&
                  (!status || (f.issueId ? "actioned" : "new") === status),
              )
              .map((f) => ({
                id: f.id,
                sourceId: f.sourceId,
                sourceName: names.get(f.sourceId) ?? null,
                rating: null,
                ratingScale: null,
                body: f.body,
                submitterLabel: null,
                sourceUrl: null,
                appVersion: null,
                status: f.issueId ? "actioned" : "new",
                linkedIssueId: f.issueId,
                createdAt: f.receivedAt,
              })),
          );
        }
        if (request.method === "POST" && itemId && action === "convert-to-issue") {
          const feedback = (await projectFeedback(services, scope, project.id)).find(
            (f) => f.id === itemId,
          );
          if (!feedback) throw new PlatformError("not_found", "Feedback not found");
          const result = await services.integrations.convertFeedback(scope, {
            operationId: crypto.randomUUID(),
            feedbackId: itemId,
            expectedVersion: feedback.version,
          });
          const issue = await services.issues.getIssue(scope, { issueId: result.issueId });
          return json({ id: issue.id, number: issue.number }, 201);
        }
      }
      return unsupported();
    }
    const sourceLookup = path.match(/^\/api\/feedback-sources\/([^/]+)$/);
    if (sourceLookup && request.method === "GET") {
      const source = (await allSources(services, scope)).find((s) => s.id === sourceLookup[1]);
      if (!source) throw new PlatformError("not_found", "Feedback source not found");
      await services.projects.authorizeProject(scope, source.projectId, "read");
      return json(sourceShape(source));
    }
    if (path.startsWith("/api/feedback-sources")) return unsupported();
    if (path === "/api/wiki/search" && request.method === "GET") {
      const q = url.searchParams.get("q");
      if (!q) bad("Invalid query");
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const pages = await services.wiki.searchPages(scope, { projectId, text: q as string });
      return json(
        pages.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          project_id: p.projectId,
          excerpt: null,
          type: null,
          status: null,
          tags: [],
          owners: [],
          verified_at: null,
          verified_by: null,
          verify_interval: null,
          freshness: null,
        })),
      );
    }
    if (path === "/api/wiki" && request.method === "GET") {
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const pages: WikiPage[] = [];
      let cursor: string | undefined;
      do {
        const result = await services.wiki.listPages(scope, { projectId, limit: 100, cursor });
        pages.push(...result.pages);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      return json(pages.map(wikiListShape));
    }
    if (path === "/api/wiki" && request.method === "POST") {
      const data = await input(request);
      if (typeof data.title !== "string") bad("Invalid title");
      const title = data.title as string;
      const slug =
        typeof data.slug === "string"
          ? data.slug
          : title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
      const result = await services.wiki.createPage(scope, {
        operationId: crypto.randomUUID(),
        pageId: crypto.randomUUID(),
        projectId: optionalString(data.projectId, "projectId"),
        parentId: data.parentId === null ? null : optionalString(data.parentId, "parentId"),
        slug,
        title,
        body: optionalString(data.content, "content") ?? "",
      });
      return json(
        {
          id: result.id,
          slug,
          projectId: data.projectId ?? null,
          url: `/wiki/${slug}`,
          type: null,
          tags: [],
          status: null,
          verified_at: null,
          verified_by: null,
          owners: [],
          verify_interval: null,
          is_template: false,
        },
        201,
      );
    }
    if (
      /^\/api\/wiki\/(?:tree|templates|trash|stale-pages|watches|notifications|backlinks|export|broken-links|changes|search|backfill-links|purge-trash)(?:\/|$)/.test(
        path,
      )
    )
      return unsupported();
    const wikiMatch = path.match(/^\/api\/wiki\/([^/]+)$/);
    const wikiRevisionMatch = path.match(/^\/api\/wiki\/([^/]+)\/revisions(?:\/([^/]+))?$/);
    if (wikiMatch || wikiRevisionMatch) {
      const page = await services.wiki.getPageBySlug(
        scope,
        decodeURIComponent((wikiMatch ?? wikiRevisionMatch)?.[1] ?? ""),
      );
      if (wikiRevisionMatch && request.method === "GET") {
        if (wikiRevisionMatch[2]) {
          const number = Number(wikiRevisionMatch[2]);
          const revision = await services.wiki.getRevision(scope, page.id, number);
          return json({
            id: String(revision.version),
            title: revision.title,
            content: revision.body,
            summary: null,
            author_id: revision.actorId,
            created_at: revision.occurredAt,
          });
        }
        const revisions = await services.wiki.listRevisions(scope, page.id, undefined, 100);
        const people = await members(services, scope);
        return json(revisions.revisions.map((revision) => wikiRevisionShape(revision, people)));
      }
      if (wikiMatch && request.method === "GET") return json(wikiDetailShape(page));
      if (wikiMatch && request.method === "PUT") {
        const data = await input(request);
        const supplied = data.expectedVersion ?? data.baseVersion;
        const baseRevision = data.baseRevisionId;
        if (
          (supplied !== undefined &&
            (!Number.isSafeInteger(supplied) || supplied !== page.version)) ||
          (baseRevision !== undefined && baseRevision !== String(page.version))
        )
          throw new PlatformError("conflict", "Conflict");
        await services.wiki.editPage(scope, {
          operationId: crypto.randomUUID(),
          pageId: page.id,
          expectedVersion: supplied === undefined ? page.version : (supplied as number),
          title: optionalString(data.title, "title"),
          body: optionalString(data.content, "content"),
          parentId: data.parentId === null ? null : optionalString(data.parentId, "parentId"),
        });
        return json({ ok: true, url: `/wiki/${page.slug}` });
      }
      if (wikiMatch && request.method === "DELETE") {
        await services.wiki.archivePage(scope, {
          operationId: crypto.randomUUID(),
          pageId: page.id,
          expectedVersion: page.version,
        });
        return json({ ok: true });
      }
    }
    if (path.startsWith("/api/wiki")) return unsupported();
    const sprintMatch = path.match(/^\/api\/sprints\/([^/]+)$/);
    if (path === "/api/sprints" && request.method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) bad("Missing projectId");
      return json({
        items: (await services.planning.listSprints(scope, projectId as string)).map((s) =>
          sprintShape(s, scope.workspaceId),
        ),
      });
    }
    if (path === "/api/sprints" && request.method === "POST") {
      const body = await input(request);
      if (typeof body.projectId !== "string" || typeof body.name !== "string")
        bad("Invalid sprint");
      const result = await services.planning.createSprint(scope, {
        operationId: crypto.randomUUID(),
        sprintId: crypto.randomUUID(),
        projectId: body.projectId as string,
        name: body.name as string,
        goal: body.goal === null || typeof body.goal === "string" ? body.goal : undefined,
        startDate:
          body.startDate === null || typeof body.startDate === "number"
            ? body.startDate
            : undefined,
        endDate:
          body.endDate === null || typeof body.endDate === "number" ? body.endDate : undefined,
      });
      return json({ id: result.id }, 201);
    }
    if (sprintMatch && request.method === "GET")
      return json(
        sprintShape(await services.planning.getSprint(scope, sprintMatch[1]), scope.workspaceId),
      );
    if (sprintMatch && request.method === "PATCH") {
      const body = await input(request);
      const sprint = await services.planning.getSprint(scope, sprintMatch[1]);
      await services.planning.updateSprint(scope, {
        operationId: crypto.randomUUID(),
        sprintId: sprint.id,
        expectedVersion: sprint.version,
        name: typeof body.name === "string" ? body.name : undefined,
        goal: body.goal === null || typeof body.goal === "string" ? body.goal : undefined,
        status: typeof body.status === "string" ? (body.status as Sprint["status"]) : undefined,
        startDate:
          body.startDate === null || typeof body.startDate === "number"
            ? body.startDate
            : undefined,
        endDate:
          body.endDate === null || typeof body.endDate === "number" ? body.endDate : undefined,
      });
      return json({ ok: true });
    }
    if (path.startsWith("/api/sprints")) return unsupported();
    const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
    if (path === "/api/files" && request.method === "GET") {
      const entityType =
        url.searchParams.get("entityType") ??
        (url.searchParams.has("issueId") ? "issue" : "wiki_page");
      const entityId =
        url.searchParams.get("entityId") ??
        url.searchParams.get("issueId") ??
        url.searchParams.get("wikiPageId");
      const target = fileTarget(entityType, entityId);
      const items: AssetLink[] = [];
      let cursor = "";
      do {
        const page = await services.assets.listAssets(scope, target, cursor, 100);
        items.push(...page.items);
        cursor = page.nextCursor ?? "";
      } while (cursor);
      return json(items.map(fileShape));
    }
    if (path === "/api/files/links" && request.method === "POST") {
      const body = await input(request);
      if (body.kind !== "url" || typeof body.url !== "string") return unsupported();
      const result = await services.assets.createLinkAsset(scope, {
        operationId: crypto.randomUUID(),
        assetId: crypto.randomUUID(),
        url: body.url as string,
        title: typeof body.label === "string" ? body.label : null,
        target: fileTarget(body.entityType, body.entityId),
      });
      return json({ id: result.id, kind: "url" }, 201);
    }
    if (path === "/api/files" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("multipart/form-data"))
        bad("Expected multipart/form-data");
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new PlatformError("validation", "Missing file field");
      const target = fileTarget(form.get("entityType"), form.get("entityId"));
      if (file.size > 10 * 1024 * 1024) bad("Upload too large");
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const projectId =
        target.kind === "issue"
          ? (await services.issues.authorizeIssue(scope, target.id, "write")).projectId
          : ((await services.wiki.authorizePage(scope, target.id, "write")).projectId ??
            bad("Workspace wiki attachments are unavailable"));
      const assetId = crypto.randomUUID();
      const contentType = file.type || "application/octet-stream";
      await services.assets.beginUpload(scope, {
        operationId: crypto.randomUUID(),
        assetId,
        projectId,
        size: file.size,
        contentType,
        filename: file.name,
        sha256,
      });
      await services.assets.putUpload(scope, assetId, bytes);
      const ready = await services.assets.completeUpload(scope, {
        operationId: crypto.randomUUID(),
        assetId,
        expectedVersion: 1,
      });
      await services.assets.linkAsset(scope, {
        operationId: crypto.randomUUID(),
        assetId,
        expectedVersion: ready.version,
        linkId: assetId,
        target,
      });
      return json({ id: assetId, filename: file.name, contentType, size: file.size }, 201);
    }
    if (fileMatch && request.method === "GET") {
      const link = await services.assets.getLink(scope, fileMatch[1]);
      const asset = await services.assets.downloadAsset(scope, link.assetId);
      if (asset.metadata.kind === "link" && asset.metadata.url)
        return Response.redirect(asset.metadata.url, 302);
      if (!asset.body) throw new PlatformError("not_found", "Object missing");
      const reader = asset.body;
      const inline = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        asset.metadata.contentType,
      );
      const filename = asset.metadata.filename.replace(/[\r\n"\\]/g, "_");
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const part = await reader.read();
          if (part === null) controller.close();
          else controller.enqueue(new Uint8Array(part));
        },
        async cancel() {
          await reader.cancel();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": inline ? asset.metadata.contentType : "application/octet-stream",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      });
    }
    if (fileMatch && request.method === "DELETE") {
      const link = await services.assets.getLink(scope, fileMatch[1]);
      const asset = await services.assets.getMetadata(scope, link.assetId);
      await services.assets.unlinkAsset(scope, {
        operationId: crypto.randomUUID(),
        assetId: asset.id,
        linkId: link.id,
        expectedVersion: asset.version,
      });
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/api/files")) return unsupported();
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
      const projects = await visibleProjects(services, scope);
      const counts = new Map<string, { open: number; backlog: number }>();
      for (let i = 0; i < projects.length; i += 100) {
        for (const item of await services.issues.countIssuesByProject(
          scope,
          projects.slice(i, i + 100).map((p) => p.id),
        ))
          counts.set(item.projectId, item);
      }
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
          open_issue_count: counts.get(p.id)?.open ?? 0,
          backlog_issue_count: counts.get(p.id)?.backlog ?? 0,
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
    const flowMatch = path.match(/^\/api\/projects\/([^/]+)\/flow-metrics$/);
    if (flowMatch && request.method === "GET") {
      const project = await resolveProject(services, scope, decodeURIComponent(flowMatch[1]));
      const since = url.searchParams.get("since"),
        until = url.searchParams.get("until");
      const granularity = url.searchParams.get("granularity");
      return json(
        await services.insights.getFlowMetrics(scope, {
          projectId: project.id,
          since: since ? Number(since) : undefined,
          until: until ? Number(until) : undefined,
          granularity: granularity === null ? undefined : (granularity as "day" | "week"),
        }),
      );
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
      return json({ ok: true });
    }
    if (path === "/api/task-statuses" && request.method === "GET")
      return json((await services.issues.listTaskStatuses(scope)).map(taskStatus));
    if (path === "/api/task-types" && request.method === "GET")
      return json((await services.issues.listTaskTypes(scope)).map(taskType));
    if (path === "/api/issues/search" && request.method === "GET") {
      const query = url.searchParams.get("q");
      if (!query) return bad("Invalid query");
      const limit = Number(url.searchParams.get("limit") ?? 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) bad("Invalid limit");
      const projects = await visibleProjects(services, scope);
      const requested = url.searchParams.get("projectId");
      const selected = requested
        ? projects.filter((p) => p.id === requested || p.key === requested || p.slug === requested)
        : projects;
      if (requested && !selected.length) throw new PlatformError("not_found", "Project not found");
      const labels = url.searchParams
        .getAll("labels")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
      const labelsMode = url.searchParams.get("labelsMode");
      if (labelsMode !== null && labelsMode !== "all" && labelsMode !== "any")
        bad("Invalid labels mode");
      const hits = (
        await Promise.all(
          selected.map((p) =>
            services.issues.searchIssues(scope, {
              projectId: p.id,
              text: query,
              limit,
              labels: labels.length ? labels : undefined,
              labelsMode: labelsMode === "any" ? "any" : "all",
            }),
          ),
        )
      )
        .flat()
        .slice(0, limit);
      return json(
        hits.map((issue) => {
          const p = projects.find((item) => item.id === issue.projectId);
          return {
            id: issue.id,
            number: issue.number,
            title: issue.title,
            status: issue.status,
            priority: issue.priority,
            project_id: issue.projectId,
            project_key: p?.key ?? null,
            project_name: p?.name ?? null,
          };
        }),
      );
    }
    if (path === "/api/issues" && request.method === "GET") {
      const q = url.searchParams;
      if (q.has("cfKey") || q.has("cfOp") || q.has("cfValue") || flag(q.get("needsAudit")))
        return unsupported();
      if (q.has("sprintId")) {
        if (
          [...q.keys()].some((key) => !["sprintId", "limit", "cursor", "includeBody"].includes(key))
        )
          return unsupported();
        const sprintId = q.get("sprintId");
        if (!sprintId) bad("Invalid sprintId");
        const page = await services.planning.getSprintItems(scope, sprintId as string, {
          cursor: q.get("cursor") ?? undefined,
          limit: Number(q.get("limit") ?? 30),
        });
        const projects = await visibleProjects(services, scope);
        const people = await members(services, scope);
        const statuses = await services.issues.listTaskStatuses(scope);
        const types = await services.issues.listTaskTypes(scope);
        return json({
          items: page.items
            .filter((item) => item.issue !== null)
            .map((item) =>
              issueShape(
                item.issue as Issue,
                scope.workspaceId,
                projects.find((p) => p.id === item.issue?.projectId),
                people,
                statuses,
                types,
                flag(q.get("includeBody")),
                page.sprint.id,
              ),
            ),
          nextCursor: page.nextCursor,
          total: null,
        });
      }
      const statuses = await services.issues.listTaskStatuses(scope);
      const statusIds =
        comma(q.get("statusIds")) ??
        (q.get("statusId")
          ? [q.get("statusId") as string]
          : q.get("status")
            ? statuses.filter((item) => item.key === q.get("status")).map((item) => item.id)
            : undefined);
      const projects = await visibleProjects(services, scope);
      const projectParam = q.get("project");
      const project = projectParam
        ? projects.find(
            (p) => p.id === projectParam || p.key === projectParam || p.slug === projectParam,
          )
        : undefined;
      if (projectParam && !project) throw new PlatformError("not_found", "Project not found");
      const filters: IssueFilters = {
        projectId: project?.id,
        statusIds,
        category: (q.get("category") as IssueFilters["category"]) || undefined,
        priorities: (
          comma(q.get("priorities")) ??
          (q.get("priority") ? [q.get("priority") as string] : undefined)
        )?.map(priorityValue),
        assigneeId:
          q.get("assignee") === "me" ? scope.principalId : (q.get("assignee") ?? undefined),
        parentId: q.get("parentId")
          ? (await issueRef(services, scope, q.get("parentId") as string)).id
          : undefined,
        noParent: flag(q.get("noParent")),
        typeId: q.get("typeId") ?? undefined,
        excludeTypeIds: comma(q.get("excludeTypeIds")),
        labels: q
          .getAll("labels")
          .flatMap((item) => item.split(","))
          .filter(Boolean),
        labelsMode: q.get("labelsMode") === "any" ? "any" : "all",
        completedAfter: epoch(q.get("completedAfter")),
        completedBefore: epoch(q.get("completedBefore")),
        updatedAfter: epoch(q.get("updatedAfter")),
        updatedBefore: epoch(q.get("updatedBefore")),
        cursor: q.get("cursor") ?? undefined,
        limit: Number(q.get("limit") ?? 30),
      };
      const page = await services.issues.queryIssues(scope, filters);
      const total = q.has("cursor") ? null : await services.issues.countIssues(scope, filters);
      const people = await members(services, scope);
      const types = await services.issues.listTaskTypes(scope);
      const sprintIds = await services.planning.sprintsForIssues(
        scope,
        page.issues.map((issue) => issue.id),
      );
      const rollups = flag(q.get("includeRollups"))
        ? await services.issues.childRollups(
            scope,
            page.issues.map((issue) => issue.id),
          )
        : null;
      return json({
        items: page.issues.map((issue) => ({
          ...issueShape(
            issue,
            scope.workspaceId,
            projects.find((p) => p.id === issue.projectId),
            people,
            statuses,
            types,
            flag(q.get("includeBody")),
            sprintIds[issue.id] ?? null,
          ),
          ...(rollups ? { rollup: rollups[issue.id] } : {}),
        })),
        nextCursor: page.nextCursor,
        total,
      });
    }
    if (path === "/api/issues" && request.method === "POST") {
      const body = await input(request);
      if (deferredIssueFields.some((field) => Object.hasOwn(body, field))) return unsupported();
      const allowed = new Set([
        "projectId",
        "title",
        "body",
        "status",
        "statusId",
        "priority",
        "assigneeId",
        "labels",
        "parentId",
        "typeId",
        "sprintId",
      ]);
      if (Object.keys(body).some((field) => !allowed.has(field))) bad("Invalid issue input");
      if (typeof body.projectId !== "string" || typeof body.title !== "string")
        bad("Invalid issue input");
      const statuses = await services.issues.listTaskStatuses(scope);
      const statusId =
        typeof body.statusId === "string"
          ? body.statusId
          : typeof body.status === "string"
            ? statuses.find((s) => s.key === body.status)?.id
            : undefined;
      if (body.status && !statusId) bad("Invalid status");
      const created = await services.issues.createIssue(scope, {
        operationId: crypto.randomUUID(),
        issueId: crypto.randomUUID(),
        projectId: body.projectId as string,
        title: body.title as string,
        description: typeof body.body === "string" ? body.body : "",
        priority: body.priority === undefined ? "none" : priorityValue(body.priority),
        statusId,
        typeId: typeof body.typeId === "string" ? body.typeId : undefined,
        labels: Array.isArray(body.labels) ? (body.labels as string[]) : undefined,
        parentId: typeof body.parentId === "string" ? body.parentId : undefined,
        assigneeId: typeof body.assigneeId === "string" ? body.assigneeId : undefined,
      });
      if (body.sprintId !== undefined) {
        if (typeof body.sprintId !== "string") bad("Invalid sprintId");
        await assignSprint(services, scope, created.id, body.sprintId as string);
      }
      return json({ id: created.id, number: created.number }, 201);
    }
    const issueMatch = path.match(/^\/api\/issues\/([^/]+)(?:\/(comments|links)(?:\/([^/]+))?)?$/);
    if (issueMatch) {
      const current = await issueRef(services, scope, decodeURIComponent(issueMatch[1]));
      const section = issueMatch[2],
        childId = issueMatch[3];
      if (!section && request.method === "GET") {
        const projects = await visibleProjects(services, scope);
        const people = await members(services, scope);
        const statuses = await services.issues.listTaskStatuses(scope),
          types = await services.issues.listTaskTypes(scope);
        const sprintIds = await services.planning.sprintsForIssues(scope, [current.id]);
        const rollup = await services.issues.childRollups(scope, [current.id]);
        const links = (await services.issues.listIssueLinks(scope, current.id)).map(linkShape);
        return json({
          ...issueShape(
            current,
            scope.workspaceId,
            projects.find((p) => p.id === current.projectId),
            people,
            statuses,
            types,
            true,
            sprintIds[current.id] ?? null,
          ),
          rollup: rollup[current.id],
          links,
          ready_at: current.readyAt,
          claimed_at: current.claimedAt,
          done_at: current.doneAt,
          in_review_at: current.inReviewAt,
          review_bounce_count: current.reviewBounceCount,
          dor_ready: false,
          dor_missing: [],
          resolution_history: [],
          resolution_history_has_more: false,
          last_completed_at: null,
          completed_at_source: null,
        });
      }
      if (!section && request.method === "PATCH") {
        const body = await input(request);
        if (deferredIssueFields.some((field) => Object.hasOwn(body, field))) return unsupported();
        const allowed = new Set([
          "title",
          "body",
          "status",
          "statusId",
          "priority",
          "assigneeId",
          "labels",
          "parentId",
          "typeId",
          "sprintId",
        ]);
        if (Object.keys(body).some((field) => !allowed.has(field))) return unsupported();
        const statuses = await services.issues.listTaskStatuses(scope);
        const statusId =
          typeof body.statusId === "string"
            ? body.statusId
            : typeof body.status === "string"
              ? statuses.find((s) => s.key === body.status)?.id
              : undefined;
        if (body.status && !statusId) bad("Invalid status");
        if (Object.keys(body).some((key) => key !== "sprintId"))
          await services.issues.updateIssue(scope, {
            operationId: crypto.randomUUID(),
            issueId: current.id,
            expectedVersion: current.version,
            title: typeof body.title === "string" ? body.title : undefined,
            description: typeof body.body === "string" ? body.body : undefined,
            statusId,
            priority: body.priority === undefined ? undefined : priorityValue(body.priority),
            assigneeId:
              body.assigneeId === null || typeof body.assigneeId === "string"
                ? body.assigneeId
                : undefined,
            labels: Array.isArray(body.labels) ? (body.labels as string[]) : undefined,
            parentId:
              body.parentId === null || typeof body.parentId === "string"
                ? body.parentId
                : undefined,
            typeId:
              body.typeId === null || typeof body.typeId === "string" ? body.typeId : undefined,
          });
        if (Object.hasOwn(body, "sprintId")) {
          if (body.sprintId !== null && typeof body.sprintId !== "string") bad("Invalid sprintId");
          await assignSprint(services, scope, current.id, body.sprintId as string | null);
        }
        return json({ ok: true });
      }
      if (section === "comments") {
        if (request.method === "GET" && !childId) {
          const people = await members(services, scope);
          return json(
            (await services.issues.listComments(scope, current.id)).map((comment) => ({
              id: comment.id,
              body: comment.body,
              author_id: comment.authorId,
              author_name: people.get(comment.authorId)?.displayName ?? "",
              author_email: people.get(comment.authorId)?.email ?? "",
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              author_kind: comment.authorKind === "machine" ? "agent" : "human",
            })),
          );
        }
        if (request.method === "POST" && !childId) {
          const body = await input(request);
          if (typeof body.body !== "string") bad("Invalid body");
          const commentId = crypto.randomUUID();
          await services.issues.addComment(scope, {
            operationId: crypto.randomUUID(),
            issueId: current.id,
            expectedVersion: current.version,
            commentId,
            body: body.body as string,
          });
          return json({ id: commentId }, 201);
        }
        if (childId && request.method === "PATCH") {
          const body = await input(request);
          if (typeof body.body !== "string") bad("Invalid body");
          await services.issues.editComment(scope, {
            operationId: crypto.randomUUID(),
            issueId: current.id,
            expectedVersion: current.version,
            commentId: childId,
            body: body.body as string,
          });
          return json({ ok: true });
        }
        if (childId && request.method === "DELETE") {
          await services.issues.deleteComment(scope, {
            operationId: crypto.randomUUID(),
            issueId: current.id,
            expectedVersion: current.version,
            commentId: childId,
          });
          return json({ ok: true });
        }
      }
      if (section === "links") {
        if (request.method === "GET" && !childId)
          return json((await services.issues.listIssueLinks(scope, current.id)).map(linkShape));
        if (request.method === "POST" && !childId) {
          const body = await input(request);
          if (typeof body.targetIssueId !== "string" || typeof body.type !== "string")
            bad("Invalid link");
          const linkId = crypto.randomUUID();
          await services.issues.createIssueLink(scope, {
            operationId: crypto.randomUUID(),
            sourceIssueId: current.id,
            targetIssueId: body.targetIssueId as string,
            linkId,
            type: body.type as Parameters<Services["issues"]["createIssueLink"]>[1]["type"],
            expectedVersion: current.version,
          });
          return json({ id: linkId }, 201);
        }
        if (childId && request.method === "DELETE") {
          await services.issues.deleteIssueLink(scope, {
            operationId: crypto.randomUUID(),
            sourceIssueId: current.id,
            linkId: childId,
            expectedVersion: current.version,
          });
          return json({ ok: true });
        }
      }
    }
    return unsupported();
  } catch (error) {
    return failure(error);
  }
}
