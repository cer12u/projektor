import type { AccessApi, RequestScope } from "../modules/access/public";
import type { AssetsApi } from "../modules/assets/public";
import type { CoordinationApi } from "../modules/coordination/public";
import type { InsightsApi } from "../modules/insights/public";
import type { IntegrationsApi } from "../modules/integrations/public";
import type { IssuesApi } from "../modules/issues/public";
import type { LifecycleApi } from "../modules/lifecycle/public";
import type { PlanningApi } from "../modules/planning/public";
import type { ProjectsApi } from "../modules/projects/public";
import type { WikiApi } from "../modules/wiki/public";
import { PlatformError } from "../platform/public";

export interface Services {
  readonly access: AccessApi;
  readonly bootstrapDefaultWorkspace?: (
    principal: import("../modules/access/public").AuthenticatedPrincipal,
  ) => Promise<void>;
  readonly oauthHttp?: (request: Request) => Promise<Response>;
  readonly oauthOrigin?: string;
  readonly projects: ProjectsApi;
  readonly issues: IssuesApi;
  readonly insights: InsightsApi;
  readonly integrations: IntegrationsApi;
  readonly wiki: WikiApi;
  readonly coordination: CoordinationApi;
  readonly assets: AssetsApi;
  readonly planning: PlanningApi;
  readonly lifecycle?: LifecycleApi;
}
type Field =
  | "string"
  | "number"
  | "optionalString"
  | "optionalNumber"
  | "nullableReal"
  | "nullableString"
  | "stringArray"
  | "optionalStringArray"
  | "optionalBoolean";
type Fields = Readonly<Record<string, Field>>;
type Operation = Readonly<{
  fields: Fields;
  write: boolean;
  call: (s: Services, scope: RequestScope, a: Record<string, unknown>) => Promise<unknown>;
}>;
const str = (a: Record<string, unknown>, k: string) => a[k] as string;
const num = (a: Record<string, unknown>, k: string) => a[k] as number;
const optStr = (a: Record<string, unknown>, k: string) => a[k] as string | undefined;
const optNum = (a: Record<string, unknown>, k: string) => a[k] as number | undefined;
const arr = (a: Record<string, unknown>, k: string) => a[k] as string[];
const optArr = (a: Record<string, unknown>, k: string) => a[k] as string[] | undefined;
const optBool = (a: Record<string, unknown>, k: string) => a[k] as boolean | undefined;
const nullable = (a: Record<string, unknown>, k: string) => a[k] as string | null | undefined;
const nullableReal = (a: Record<string, unknown>, k: string) => a[k] as number | null | undefined;
const op = (fields: Fields, write: boolean, call: Operation["call"]): Operation => ({
  fields,
  write,
  call,
});
const operationId = { operationId: "string" } as const;
const version = { ...operationId, expectedVersion: "number" } as const;
const lifecycleRoute = async () => {
  throw new PlatformError("not_found", "Lifecycle is REST only");
};
export const catalog: Readonly<Record<string, Operation>> = Object.freeze({
  "lifecycle.requestPurge": op(
    { ...version, projectId: "optionalString", confirmation: "string" },
    true,
    lifecycleRoute,
  ),
  "lifecycle.resumePurge": op({ ...version, jobId: "string" }, true, lifecycleRoute),
  "lifecycle.getPurgeStatus": op({ projectId: "optionalString" }, false, lifecycleRoute),
  "integrations.links": op(
    { targetKind: "string", targetId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.integrations.listExternalRefs(
        c,
        { kind: str(a, "targetKind") as "issue" | "wiki", id: str(a, "targetId") },
        optStr(a, "cursor"),
        optNum(a, "limit"),
      ),
  ),
  "integrations.link": op(
    {
      ...operationId,
      refId: "string",
      targetKind: "string",
      targetId: "string",
      kind: "string",
      url: "string",
    },
    true,
    (s, c, a) =>
      s.integrations.linkExternalRef(c, {
        operationId: str(a, "operationId"),
        refId: str(a, "refId"),
        target: { kind: str(a, "targetKind") as "issue" | "wiki", id: str(a, "targetId") },
        kind: str(a, "kind") as import("../modules/integrations/public").ExternalKind,
        url: str(a, "url"),
      }),
  ),
  "integrations.unlink": op({ ...version, refId: "string" }, true, (s, c, a) =>
    s.integrations.unlinkExternalRef(c, {
      operationId: str(a, "operationId"),
      refId: str(a, "refId"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
  "integrations.feedback": op(
    { cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) => s.integrations.listFeedback(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "integrations.convert": op({ ...version, feedbackId: "string" }, true, (s, c, a) =>
    s.integrations.convertFeedback(c, {
      operationId: str(a, "operationId"),
      feedbackId: str(a, "feedbackId"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
  "integrations.deliveries": op(
    { cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) => s.integrations.getDeliveryStatus(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "integrations.sources": op(
    { cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) => s.integrations.listSources(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "integrations.source.register": op(
    { ...operationId, sourceId: "string", projectId: "string", name: "string" },
    true,
    (s, c, a) =>
      s.integrations.registerSource(c, {
        operationId: str(a, "operationId"),
        sourceId: str(a, "sourceId"),
        projectId: str(a, "projectId"),
        name: str(a, "name"),
      }),
  ),
  "integrations.webhook.register": op(
    { ...operationId, sourceId: "string", url: "string", eventTypes: "stringArray" },
    true,
    (s, c, a) =>
      s.integrations.registerWebhook(c, {
        operationId: str(a, "operationId"),
        sourceId: str(a, "sourceId"),
        url: str(a, "url"),
        eventTypes: arr(a, "eventTypes"),
      }),
  ),
  "insights.subscription": op({ issueId: "string" }, false, (s, c, a) =>
    s.insights.getSubscription(c, str(a, "issueId")),
  ),
  "insights.activity": op(
    {
      projectId: "optionalString",
      principalId: "optionalString",
      clientId: "optionalString",
      cursor: "optionalString",
      limit: "optionalNumber",
    },
    false,
    (s, c, a) =>
      s.insights.getActivity(c, {
        projectId: optStr(a, "projectId"),
        principalId: optStr(a, "principalId"),
        clientId: optStr(a, "clientId"),
        cursor: optStr(a, "cursor"),
        limit: optNum(a, "limit"),
      }),
  ),
  "insights.metrics": op({ projectId: "string" }, false, (s, c, a) =>
    s.insights.getMetrics(c, str(a, "projectId")),
  ),
  "insights.notifications": op(
    { cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) => s.insights.listNotifications(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "insights.subscribe": op({ ...version, issueId: "string" }, true, (s, c, a) =>
    s.insights.subscribe(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      issueId: str(a, "issueId"),
    }),
  ),
  "insights.unsubscribe": op({ ...version, issueId: "string" }, true, (s, c, a) =>
    s.insights.unsubscribe(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      issueId: str(a, "issueId"),
    }),
  ),
  "insights.markRead": op({ ...version, notificationId: "string" }, true, (s, c, a) =>
    s.insights.markRead(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      notificationId: str(a, "notificationId"),
    }),
  ),
  "planning.create": op(
    { ...operationId, sprintId: "string", projectId: "string", name: "string" },
    true,
    (s, c, a) =>
      s.planning.createSprint(c, {
        operationId: str(a, "operationId"),
        sprintId: str(a, "sprintId"),
        projectId: str(a, "projectId"),
        name: str(a, "name"),
      }),
  ),
  "planning.schedule": op({ ...version, sprintId: "string", issueId: "string" }, true, (s, c, a) =>
    s.planning.scheduleIssue(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      sprintId: str(a, "sprintId"),
      issueId: str(a, "issueId"),
    }),
  ),
  "planning.unschedule": op(
    { ...version, sprintId: "string", issueId: "string" },
    true,
    (s, c, a) =>
      s.planning.unscheduleIssue(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        sprintId: str(a, "sprintId"),
        issueId: str(a, "issueId"),
      }),
  ),
  "planning.close": op({ ...version, sprintId: "string" }, true, (s, c, a) =>
    s.planning.closeSprint(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      sprintId: str(a, "sprintId"),
    }),
  ),
  "planning.list": op({ projectId: "string" }, false, (s, c, a) =>
    s.planning.listSprints(c, str(a, "projectId")),
  ),
  "planning.items": op(
    { sprintId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.planning.getSprintItems(c, str(a, "sprintId"), {
        cursor: optStr(a, "cursor"),
        limit: optNum(a, "limit"),
      }),
  ),
  "planning.readOperation": op({ operationId: "string" }, false, (s, c, a) =>
    s.planning.readOperation(c, str(a, "operationId")),
  ),
  "projects.create": op(
    {
      ...operationId,
      projectId: "string",
      key: "string",
      name: "string",
      description: "optionalString",
      slug: "optionalString",
    },
    true,
    (s, c, a) =>
      s.projects.createProject(c, {
        operationId: str(a, "operationId"),
        projectId: str(a, "projectId"),
        key: str(a, "key"),
        name: str(a, "name"),
        description: optStr(a, "description"),
        slug: optStr(a, "slug"),
      }),
  ),
  "projects.rename": op(
    { ...version, projectId: "string", key: "optionalString", name: "string" },
    true,
    (s, c, a) =>
      s.projects.renameProject(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        projectId: str(a, "projectId"),
        key: optStr(a, "key"),
        name: str(a, "name"),
      }),
  ),
  "projects.update": op(
    {
      ...version,
      projectId: "string",
      key: "optionalString",
      name: "optionalString",
      description: "optionalString",
      slug: "optionalString",
    },
    true,
    (s, c, a) =>
      s.projects.updateProject(c, {
        operationId: str(a, "operationId"),
        projectId: str(a, "projectId"),
        expectedVersion: num(a, "expectedVersion"),
        key: optStr(a, "key"),
        name: optStr(a, "name"),
        description: optStr(a, "description"),
        slug: optStr(a, "slug"),
      }),
  ),
  "projects.grant": op(
    { ...version, projectId: "string", principalId: "string", role: "string" },
    true,
    (s, c, a) =>
      s.projects.grantProjectRole(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        projectId: str(a, "projectId"),
        principalId: str(a, "principalId"),
        role: str(a, "role") as "manager" | "editor" | "viewer",
      }),
  ),
  "projects.revoke": op(
    { ...version, projectId: "string", principalId: "string" },
    true,
    (s, c, a) =>
      s.projects.revokeProjectRole(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        projectId: str(a, "projectId"),
        principalId: str(a, "principalId"),
      }),
  ),
  "projects.archive": op({ ...version, projectId: "string" }, true, (s, c, a) =>
    s.projects.archiveProject(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      projectId: str(a, "projectId"),
    }),
  ),
  "projects.get": op({ projectId: "string" }, false, (s, c, a) =>
    s.projects.getProject(c, str(a, "projectId")),
  ),
  "projects.getBySlug": op({ slug: "string" }, false, (s, c, a) =>
    s.projects.getProjectBySlug(c, str(a, "slug")),
  ),
  "projects.list": op({ cursor: "optionalString", limit: "optionalNumber" }, false, (s, c, a) =>
    s.projects.listVisibleProjects(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "issues.statuses": op({}, false, (s, c) => s.issues.listTaskStatuses(c)),
  "issues.status.create": op(
    {
      ...operationId,
      id: "string",
      key: "string",
      name: "string",
      category: "string",
      color: "nullableString",
      position: "optionalNumber",
      isDefault: "optionalBoolean",
      isReviewStep: "optionalBoolean",
    },
    true,
    (s, c, a) =>
      s.issues.createTaskStatus(c, {
        operationId: str(a, "operationId"),
        id: str(a, "id"),
        key: str(a, "key"),
        name: str(a, "name"),
        category: str(a, "category") as "todo" | "in_progress" | "done" | "cancelled",
        color: nullable(a, "color"),
        position: optNum(a, "position"),
        isDefault: optBool(a, "isDefault"),
        isReviewStep: optBool(a, "isReviewStep"),
      }),
  ),
  "issues.status.update": op(
    {
      ...version,
      id: "string",
      name: "optionalString",
      category: "optionalString",
      color: "nullableString",
      position: "optionalNumber",
      isDefault: "optionalBoolean",
      isReviewStep: "optionalBoolean",
    },
    true,
    (s, c, a) =>
      s.issues.updateTaskStatus(c, {
        operationId: str(a, "operationId"),
        id: str(a, "id"),
        expectedVersion: num(a, "expectedVersion"),
        name: optStr(a, "name"),
        category: optStr(a, "category") as
          | "todo"
          | "in_progress"
          | "done"
          | "cancelled"
          | undefined,
        color: nullable(a, "color"),
        position: optNum(a, "position"),
        isDefault: optBool(a, "isDefault"),
        isReviewStep: optBool(a, "isReviewStep"),
      }),
  ),
  "issues.status.delete": op({ ...version, id: "string" }, true, (s, c, a) =>
    s.issues.deleteTaskStatus(c, {
      operationId: str(a, "operationId"),
      id: str(a, "id"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
  "issues.types": op({}, false, (s, c) => s.issues.listTaskTypes(c)),
  "issues.type.create": op(
    {
      ...operationId,
      id: "string",
      key: "string",
      name: "string",
      color: "nullableString",
      icon: "nullableString",
      position: "optionalNumber",
      isDefault: "optionalBoolean",
    },
    true,
    (s, c, a) =>
      s.issues.createTaskType(c, {
        operationId: str(a, "operationId"),
        id: str(a, "id"),
        key: str(a, "key"),
        name: str(a, "name"),
        color: nullable(a, "color"),
        icon: nullable(a, "icon"),
        position: optNum(a, "position"),
        isDefault: optBool(a, "isDefault"),
      }),
  ),
  "issues.type.update": op(
    {
      ...version,
      id: "string",
      name: "optionalString",
      color: "nullableString",
      icon: "nullableString",
      position: "optionalNumber",
      isDefault: "optionalBoolean",
    },
    true,
    (s, c, a) =>
      s.issues.updateTaskType(c, {
        operationId: str(a, "operationId"),
        id: str(a, "id"),
        expectedVersion: num(a, "expectedVersion"),
        name: optStr(a, "name"),
        color: nullable(a, "color"),
        icon: nullable(a, "icon"),
        position: optNum(a, "position"),
        isDefault: optBool(a, "isDefault"),
      }),
  ),
  "issues.type.delete": op({ ...version, id: "string" }, true, (s, c, a) =>
    s.issues.deleteTaskType(c, {
      operationId: str(a, "operationId"),
      id: str(a, "id"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
  "issues.create": op(
    {
      ...operationId,
      issueId: "string",
      projectId: "string",
      title: "string",
      description: "string",
      priority: "string",
      statusId: "optionalString",
      typeId: "nullableString",
      labels: "optionalStringArray",
      parentId: "nullableString",
      estimate: "nullableReal",
      dueDate: "nullableString",
    },
    true,
    (s, c, a) =>
      s.issues.createIssue(c, {
        operationId: str(a, "operationId"),
        issueId: str(a, "issueId"),
        projectId: str(a, "projectId"),
        title: str(a, "title"),
        description: str(a, "description"),
        priority: str(a, "priority") as "none" | "low" | "medium" | "high" | "urgent",
        statusId: optStr(a, "statusId"),
        typeId: nullable(a, "typeId"),
        labels: optArr(a, "labels"),
        parentId: nullable(a, "parentId"),
        estimate: nullableReal(a, "estimate"),
        dueDate: nullable(a, "dueDate"),
      }),
  ),
  "issues.edit": op(
    {
      ...version,
      issueId: "string",
      title: "string",
      description: "string",
      priority: "string",
      estimate: "nullableReal",
      dueDate: "nullableString",
    },
    true,
    (s, c, a) =>
      s.issues.editIssue(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        issueId: str(a, "issueId"),
        title: str(a, "title"),
        description: str(a, "description"),
        priority: str(a, "priority") as "none" | "low" | "medium" | "high" | "urgent",
        estimate: nullableReal(a, "estimate"),
        dueDate: nullable(a, "dueDate"),
      }),
  ),
  "issues.transition": op({ ...version, issueId: "string", state: "string" }, true, (s, c, a) =>
    s.issues.transitionIssue(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      issueId: str(a, "issueId"),
      state: str(a, "state") as "todo" | "in_progress" | "done" | "cancelled",
    }),
  ),
  "issues.assign": op(
    { ...version, issueId: "string", assigneeId: "nullableString" },
    true,
    (s, c, a) =>
      s.issues.assignIssue(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        issueId: str(a, "issueId"),
        assigneeId: nullable(a, "assigneeId") ?? null,
      }),
  ),
  "issues.comment": op(
    { ...version, issueId: "string", commentId: "string", body: "string" },
    true,
    (s, c, a) =>
      s.issues.addComment(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        issueId: str(a, "issueId"),
        commentId: str(a, "commentId"),
        body: str(a, "body"),
      }),
  ),
  "issues.archive": op({ ...version, issueId: "string" }, true, (s, c, a) =>
    s.issues.archiveIssue(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      issueId: str(a, "issueId"),
    }),
  ),
  "issues.get": op({ issueId: "string" }, false, (s, c, a) =>
    s.issues.getIssue(c, { issueId: str(a, "issueId") }),
  ),
  "issues.list": op(
    {
      projectId: "string",
      state: "optionalString",
      assigneeId: "nullableString",
      priority: "optionalString",
      cursor: "optionalString",
      limit: "optionalNumber",
    },
    false,
    (s, c, a) =>
      s.issues.listIssues(c, {
        projectId: str(a, "projectId"),
        state: optStr(a, "state") as "todo" | "in_progress" | "done" | "cancelled" | undefined,
        assigneeId: nullable(a, "assigneeId"),
        priority: optStr(a, "priority") as "low" | "medium" | "high" | "urgent" | undefined,
        cursor: optStr(a, "cursor"),
        limit: optNum(a, "limit"),
      }),
  ),
  "issues.search": op(
    { projectId: "string", text: "string", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.issues.searchIssues(c, {
        projectId: str(a, "projectId"),
        text: str(a, "text"),
        limit: optNum(a, "limit"),
      }),
  ),
  "issues.history": op({ issueId: "string" }, false, (s, c, a) =>
    s.issues.getHistory(c, str(a, "issueId")),
  ),
  "wiki.create": op(
    {
      ...operationId,
      pageId: "string",
      projectId: "string",
      slug: "string",
      title: "string",
      body: "string",
    },
    true,
    (s, c, a) =>
      s.wiki.createPage(c, {
        operationId: str(a, "operationId"),
        pageId: str(a, "pageId"),
        projectId: str(a, "projectId"),
        slug: str(a, "slug"),
        title: str(a, "title"),
        body: str(a, "body"),
      }),
  ),
  "wiki.edit": op(
    { ...version, pageId: "string", title: "string", body: "string" },
    true,
    (s, c, a) =>
      s.wiki.editPage(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        pageId: str(a, "pageId"),
        title: str(a, "title"),
        body: str(a, "body"),
      }),
  ),
  "wiki.archive": op({ ...version, pageId: "string" }, true, (s, c, a) =>
    s.wiki.archivePage(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      pageId: str(a, "pageId"),
    }),
  ),
  "wiki.get": op({ pageId: "string" }, false, (s, c, a) =>
    s.wiki.getPage(c, { pageId: str(a, "pageId") }),
  ),
  "wiki.list": op(
    { projectId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.wiki.listPages(c, {
        projectId: str(a, "projectId"),
        cursor: optStr(a, "cursor"),
        limit: optNum(a, "limit"),
      }),
  ),
  "wiki.search": op(
    { projectId: "string", text: "string", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.wiki.searchPages(c, {
        projectId: str(a, "projectId"),
        text: str(a, "text"),
        limit: optNum(a, "limit"),
      }),
  ),
  "wiki.revision": op({ pageId: "string", version: "number" }, false, (s, c, a) =>
    s.wiki.getRevision(c, str(a, "pageId"), num(a, "version")),
  ),
  "wiki.revisions": op(
    { pageId: "string", cursor: "optionalNumber", limit: "optionalNumber" },
    false,
    (s, c, a) => s.wiki.listRevisions(c, str(a, "pageId"), optNum(a, "cursor"), optNum(a, "limit")),
  ),
  "coordination.start": op(
    {
      ...operationId,
      sessionId: "string",
      agentLabel: "string",
      clientKind: "string",
      repo: "optionalString",
      ttlSeconds: "optionalNumber",
    },
    true,
    (s, c, a) =>
      s.coordination.startSession(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        agentLabel: str(a, "agentLabel"),
        clientKind: str(a, "clientKind"),
        repo: optStr(a, "repo"),
        ttlSeconds: optNum(a, "ttlSeconds"),
      }),
  ),
  "coordination.heartbeat": op({ ...operationId, sessionId: "string" }, true, (s, c, a) =>
    s.coordination.heartbeat(c, {
      operationId: str(a, "operationId"),
      sessionId: str(a, "sessionId"),
    }),
  ),
  "coordination.end": op({ ...operationId, sessionId: "string" }, true, (s, c, a) =>
    s.coordination.endSession(c, {
      operationId: str(a, "operationId"),
      sessionId: str(a, "sessionId"),
    }),
  ),
  "coordination.acquire": op(
    { ...operationId, sessionId: "string", issueId: "string" },
    true,
    (s, c, a) =>
      s.coordination.acquireLease(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        issueId: str(a, "issueId"),
      }),
  ),
  "coordination.renew": op(
    { ...operationId, sessionId: "string", issueId: "string", fencingToken: "number" },
    true,
    (s, c, a) =>
      s.coordination.renewLease(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        issueId: str(a, "issueId"),
        fencingToken: num(a, "fencingToken"),
      }),
  ),
  "coordination.release": op(
    { ...operationId, sessionId: "string", issueId: "string", fencingToken: "number" },
    true,
    (s, c, a) =>
      s.coordination.releaseLease(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        issueId: str(a, "issueId"),
        fencingToken: num(a, "fencingToken"),
      }),
  ),
  "coordination.limit": op(
    { ...operationId, projectId: "string", cap: "number", expectedVersion: "number" },
    true,
    (s, c, a) =>
      s.coordination.setProjectLimit(c, {
        operationId: str(a, "operationId"),
        projectId: str(a, "projectId"),
        cap: num(a, "cap"),
        expectedVersion: num(a, "expectedVersion"),
      }),
  ),
  "coordination.claim": op(
    {
      ...operationId,
      sessionId: "string",
      repo: "string",
      paths: "stringArray",
      leaseIssueId: "optionalString",
      fencingToken: "optionalNumber",
      force: "optionalBoolean",
    },
    true,
    (s, c, a) =>
      s.coordination.claimFiles(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        repo: str(a, "repo"),
        paths: arr(a, "paths"),
        leaseIssueId: optStr(a, "leaseIssueId"),
        fencingToken: optNum(a, "fencingToken"),
        force: optBool(a, "force"),
      }),
  ),
  "coordination.releaseFiles": op(
    { ...operationId, sessionId: "string", repo: "string", paths: "stringArray" },
    true,
    (s, c, a) =>
      s.coordination.releaseFiles(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        repo: str(a, "repo"),
        paths: arr(a, "paths"),
      }),
  ),
  "coordination.report": op(
    {
      ...operationId,
      sessionId: "string",
      issueId: "string",
      fencingToken: "number",
      text: "string",
      status: "string",
    },
    true,
    (s, c, a) =>
      s.coordination.reportProgress(c, {
        operationId: str(a, "operationId"),
        sessionId: str(a, "sessionId"),
        issueId: str(a, "issueId"),
        fencingToken: num(a, "fencingToken"),
        text: str(a, "text"),
        status: str(a, "status"),
      }),
  ),
  "coordination.getLease": op({ issueId: "string" }, false, (s, c, a) =>
    s.coordination.getLease(c, str(a, "issueId")),
  ),
  "coordination.listLeases": op({ projectId: "string" }, false, (s, c, a) =>
    s.coordination.listLeases(c, str(a, "projectId")),
  ),
  "coordination.listClaims": op({ repo: "string", sessionId: "string" }, false, (s, c, a) =>
    s.coordination.listClaims(c, str(a, "repo"), str(a, "sessionId")),
  ),
  "coordination.listProgress": op(
    { issueId: "string", cursor: "optionalNumber", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.coordination.listProgress(c, str(a, "issueId"), {
        cursor: optNum(a, "cursor"),
        limit: optNum(a, "limit"),
      }),
  ),
  "coordination.getProgress": op({ issueId: "string" }, false, (s, c, a) =>
    s.coordination.getProgress(c, str(a, "issueId")),
  ),
  "coordination.listSessions": op({}, false, (s, c) => s.coordination.listSessions(c)),
  "coordination.projectSessions": op(
    { projectId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.coordination.projectSessions(
        c,
        str(a, "projectId"),
        optStr(a, "cursor"),
        optNum(a, "limit"),
      ),
  ),
  "coordination.projectLeases": op(
    { projectId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.coordination.projectLeases(c, str(a, "projectId"), optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "coordination.projectProgress": op(
    { projectId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.coordination.projectProgress(
        c,
        str(a, "projectId"),
        optStr(a, "cursor"),
        optNum(a, "limit"),
      ),
  ),
  "coordination.projectClaims": op(
    { projectId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.coordination.projectClaims(c, str(a, "projectId"), optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "coordination.wipCap": op({ projectId: "string" }, false, (s, c, a) =>
    s.coordination.getProjectLimit(c, str(a, "projectId")),
  ),
  "coordination.wipCap.set": op(
    { ...version, projectId: "string", cap: "number" },
    true,
    (s, c, a) =>
      s.coordination.setProjectLimit(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        projectId: str(a, "projectId"),
        cap: num(a, "cap"),
      }),
  ),
  "coordination.readEvents": op({ cursor: "number", limit: "optionalNumber" }, false, (s, c, a) =>
    s.coordination.readAgentEvents(c, num(a, "cursor"), optNum(a, "limit") ?? 50),
  ),
  "coordination.readOperation": op({ operationId: "string" }, false, (s, c, a) =>
    s.coordination.readOperation(c, str(a, "operationId")),
  ),
  "access.workspaces": op({}, false, async () => {
    throw new PlatformError("unknown", "Use workspace listing route");
  }),
  "access.me": op({ cursor: "optionalString", limit: "optionalNumber" }, false, (s, c, a) =>
    s.access.meForScope(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "access.members.list": op(
    { cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) => s.access.listMembers(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "access.oauthClients.list": op(
    { cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) => s.access.listOAuthClients(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "access.oauthClients.revoke": op({ ...version, clientId: "string" }, true, (s, c, a) =>
    s.access.revokeOAuthClient(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      clientId: str(a, "clientId"),
    }),
  ),
  "access.membership": op({ principalId: "string" }, false, (s, c, a) =>
    s.access.getMembership(c, str(a, "principalId")),
  ),
  "access.principal": op({ principalId: "string" }, false, (s, c, a) =>
    s.access.getPrincipalSummary(c, str(a, "principalId")),
  ),
  "access.credential": op({ credentialId: "string" }, false, (s, c, a) =>
    s.access.getCredential(c, str(a, "credentialId")),
  ),
  "access.invite": op(
    { ...version, issuer: "string", subject: "string", role: "string" },
    true,
    (s, c, a) =>
      s.access.inviteMember(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        issuer: str(a, "issuer"),
        subject: str(a, "subject"),
        role: str(a, "role") as "owner" | "admin" | "member" | "viewer",
      }),
  ),
  "access.role": op({ ...version, principalId: "string", role: "string" }, true, (s, c, a) =>
    s.access.changeRole(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      principalId: str(a, "principalId"),
      role: str(a, "role") as "owner" | "admin" | "member" | "viewer",
    }),
  ),
  "access.remove": op({ ...version, principalId: "string" }, true, (s, c, a) =>
    s.access.removeMember(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
      principalId: str(a, "principalId"),
    }),
  ),
  "access.machine": op({ ...operationId, principalId: "string", role: "string" }, true, (s, c, a) =>
    s.access.provisionMachine(c, {
      operationId: str(a, "operationId"),
      principalId: str(a, "principalId"),
      role: str(a, "role") as "member" | "viewer",
    }),
  ),
  "assets.begin": op(
    {
      ...operationId,
      assetId: "string",
      projectId: "string",
      size: "number",
      contentType: "string",
      filename: "string",
      sha256: "string",
    },
    true,
    (s, c, a) =>
      s.assets.beginUpload(c, {
        operationId: str(a, "operationId"),
        assetId: str(a, "assetId"),
        projectId: str(a, "projectId"),
        size: num(a, "size"),
        contentType: str(a, "contentType"),
        filename: str(a, "filename"),
        sha256: str(a, "sha256"),
      }),
  ),
  "assets.complete": op({ ...version, assetId: "string" }, true, (s, c, a) =>
    s.assets.completeUpload(c, {
      operationId: str(a, "operationId"),
      assetId: str(a, "assetId"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
  "assets.link": op(
    { ...version, assetId: "string", linkId: "string", targetKind: "string", targetId: "string" },
    true,
    (s, c, a) =>
      s.assets.linkAsset(c, {
        operationId: str(a, "operationId"),
        assetId: str(a, "assetId"),
        expectedVersion: num(a, "expectedVersion"),
        linkId: str(a, "linkId"),
        target: { kind: str(a, "targetKind") as "issue" | "wiki", id: str(a, "targetId") },
      }),
  ),
  "assets.unlink": op({ ...version, assetId: "string", linkId: "string" }, true, (s, c, a) =>
    s.assets.unlinkAsset(c, {
      operationId: str(a, "operationId"),
      assetId: str(a, "assetId"),
      expectedVersion: num(a, "expectedVersion"),
      linkId: str(a, "linkId"),
    }),
  ),
  "assets.get": op({ assetId: "string" }, false, (s, c, a) =>
    s.assets.getMetadata(c, str(a, "assetId")),
  ),
  "assets.list": op(
    { targetKind: "string", targetId: "string", cursor: "optionalString", limit: "optionalNumber" },
    false,
    (s, c, a) =>
      s.assets.listAssets(
        c,
        { kind: str(a, "targetKind") as "issue" | "wiki", id: str(a, "targetId") },
        optStr(a, "cursor"),
        optNum(a, "limit"),
      ),
  ),
  "assets.downloadUrl": op({ assetId: "string" }, false, async (s, c, a) => {
    const assetId = str(a, "assetId");
    await s.assets.getMetadata(c, assetId);
    return {
      url: `/api/w/${encodeURIComponent(c.workspaceId)}/assets/download/${encodeURIComponent(assetId)}`,
    };
  }),
  "assets.readOperation": op({ operationId: "string" }, false, (s, c, a) =>
    s.assets.readOperation(c, str(a, "operationId")),
  ),
  "access.archive": op(version, true, (s, c, a) =>
    s.access.archiveWorkspace(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
});
export const restOnly = Object.freeze([
  "lifecycle.requestPurge",
  "lifecycle.resumePurge",
  "lifecycle.getPurgeStatus",
  "integrations.deliveries",
  "integrations.sources",
  "integrations.source.register",
  "integrations.webhook.register",
  "access.credential.issue",
  "access.credential.revoke",
  "access.oauthClients.list",
  "access.oauthClients.revoke",
  "issues.statuses",
  "issues.status.create",
  "issues.status.update",
  "issues.status.delete",
  "issues.types",
  "issues.type.create",
  "issues.type.update",
  "issues.type.delete",
]);
export function inputFor(name: string, value: unknown): Record<string, unknown> {
  const entry = catalog[name];
  if (!entry) throw new PlatformError("not_found", "Unknown operation");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PlatformError("validation", "Expected object");
  const a = value as Record<string, unknown>;
  for (const key of Object.keys(a))
    if (!(key in entry.fields) || key === "workspaceId")
      throw new PlatformError("validation", `Unknown field: ${key}`);
  for (const [key, kind] of Object.entries(entry.fields)) {
    const val = a[key];
    if (val === undefined && (kind.startsWith("optional") || kind.startsWith("nullable"))) continue;
    if (val === null && kind.startsWith("nullable")) continue;
    if (kind === "nullableReal") {
      if (typeof val === "number" && Number.isFinite(val)) continue;
      throw new PlatformError("validation", `Invalid field: ${key}`);
    }
    if (kind === "stringArray" || kind === "optionalStringArray") {
      if (val === undefined && kind === "optionalStringArray") continue;
      if (!Array.isArray(val) || !val.every((x) => typeof x === "string"))
        throw new PlatformError("validation", `Invalid field: ${key}`);
      continue;
    }
    if (kind === "optionalBoolean") {
      if (val === undefined || typeof val === "boolean") continue;
      throw new PlatformError("validation", `Invalid field: ${key}`);
    }
    if (
      kind.endsWith("String") || kind === "string"
        ? typeof val !== "string"
        : typeof val !== "number" || !Number.isSafeInteger(val)
    )
      throw new PlatformError("validation", `Invalid field: ${key}`);
  }
  return a;
}
export function toolCatalog() {
  return Object.entries(catalog)
    .filter(([name]) => name !== "access.workspaces" && !restOnly.includes(name))
    .map(([name, entry]) => ({
      name,
      description: name.startsWith("coordination.")
        ? "Agent workflow: start session → acquire issue lease → claim exact repo paths → work → report progress → release files and lease. " +
          name.replace(".", " ")
        : name.replace(".", " "),
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(entry.fields).map(([field, kind]) => [
            field,
            {
              type:
                kind === "stringArray"
                  ? "array"
                  : kind === "optionalBoolean"
                    ? "boolean"
                    : kind === "nullableReal"
                      ? "number"
                      : kind.includes("Number") || kind === "number"
                        ? "integer"
                        : "string",
              ...(kind === "stringArray" ? { items: { type: "string" } } : {}),
              ...(kind === "nullableString" ? { type: ["string", "null"] } : {}),
              ...(kind === "nullableReal" ? { type: ["number", "null"] } : {}),
            },
          ]),
        ),
        required: Object.entries(entry.fields)
          .filter(([, kind]) => !kind.startsWith("optional") && !kind.startsWith("nullable"))
          .map(([field]) => field),
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: !entry.write,
        destructiveHint: entry.write && /archive|revoke|remove/.test(name),
      },
    }));
}
