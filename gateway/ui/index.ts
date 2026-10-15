import type {
  AuthenticatedPrincipal,
  MemberItem,
  RequestScope,
  Workspace,
} from "../../modules/access/public";
import type {
  Issue,
  IssueFilters,
  IssueLink,
  IssuePriority,
  TaskStatus,
  TaskType,
} from "../../modules/issues/public";
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
    sprint_id: null,
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
const deferredIssueFields = [
  "sprintId",
  "customFields",
  "completionReport",
  "remainder",
  "agentSessionId",
];
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
      !path.startsWith("/api/issues") &&
      path !== "/api/task-statuses" &&
      path !== "/api/task-types"
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
      if (
        q.has("sprintId") ||
        q.has("cfKey") ||
        q.has("cfOp") ||
        q.has("cfValue") ||
        flag(q.get("needsAudit"))
      )
        return unsupported();
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
          ),
          rollup: rollup[current.id],
          links,
          ready_at: null,
          claimed_at: null,
          done_at: null,
          in_review_at: null,
          review_bounce_count: 0,
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
            body.parentId === null || typeof body.parentId === "string" ? body.parentId : undefined,
          typeId: body.typeId === null || typeof body.typeId === "string" ? body.typeId : undefined,
        });
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
