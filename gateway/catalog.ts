import type { AccessApi, RequestScope } from "../modules/access/public";
import type { IssuesApi } from "../modules/issues/public";
import type { ProjectsApi } from "../modules/projects/public";
import type { WikiApi } from "../modules/wiki/public";
import { PlatformError } from "../platform/public";

export interface Services {
  readonly access: AccessApi;
  readonly oauthHttp?: (request: Request) => Promise<Response>;
  readonly oauthOrigin?: string;
  readonly projects: ProjectsApi;
  readonly issues: IssuesApi;
  readonly wiki: WikiApi;
}
type Field = "string" | "number" | "optionalString" | "optionalNumber" | "nullableString";
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
const nullable = (a: Record<string, unknown>, k: string) => a[k] as string | null | undefined;
const op = (fields: Fields, write: boolean, call: Operation["call"]): Operation => ({
  fields,
  write,
  call,
});
const operationId = { operationId: "string" } as const;
const version = { ...operationId, expectedVersion: "number" } as const;
export const catalog: Readonly<Record<string, Operation>> = Object.freeze({
  "projects.create": op(
    { ...operationId, projectId: "string", key: "string", name: "string" },
    true,
    (s, c, a) =>
      s.projects.createProject(c, {
        operationId: str(a, "operationId"),
        projectId: str(a, "projectId"),
        key: str(a, "key"),
        name: str(a, "name"),
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
  "projects.list": op({ cursor: "optionalString", limit: "optionalNumber" }, false, (s, c, a) =>
    s.projects.listVisibleProjects(c, optStr(a, "cursor"), optNum(a, "limit")),
  ),
  "issues.create": op(
    {
      ...operationId,
      issueId: "string",
      projectId: "string",
      title: "string",
      description: "string",
      priority: "string",
    },
    true,
    (s, c, a) =>
      s.issues.createIssue(c, {
        operationId: str(a, "operationId"),
        issueId: str(a, "issueId"),
        projectId: str(a, "projectId"),
        title: str(a, "title"),
        description: str(a, "description"),
        priority: str(a, "priority") as "low" | "medium" | "high" | "urgent",
      }),
  ),
  "issues.edit": op(
    { ...version, issueId: "string", title: "string", description: "string", priority: "string" },
    true,
    (s, c, a) =>
      s.issues.editIssue(c, {
        operationId: str(a, "operationId"),
        expectedVersion: num(a, "expectedVersion"),
        issueId: str(a, "issueId"),
        title: str(a, "title"),
        description: str(a, "description"),
        priority: str(a, "priority") as "low" | "medium" | "high" | "urgent",
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
  "access.workspaces": op({}, false, async () => {
    throw new PlatformError("unknown", "Use workspace listing route");
  }),
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
  "access.archive": op(version, true, (s, c, a) =>
    s.access.archiveWorkspace(c, {
      operationId: str(a, "operationId"),
      expectedVersion: num(a, "expectedVersion"),
    }),
  ),
});
export const restOnly = Object.freeze(["access.credential.issue", "access.credential.revoke"]);
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
    if (val === undefined && kind.startsWith("optional")) continue;
    if (val === null && kind === "nullableString") continue;
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
      description: name.replace(".", " "),
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(entry.fields).map(([field, kind]) => [
            field,
            {
              type: kind.includes("Number") || kind === "number" ? "integer" : "string",
              ...(kind === "nullableString" ? { type: ["string", "null"] } : {}),
            },
          ]),
        ),
        required: Object.entries(entry.fields)
          .filter(([, kind]) => !kind.startsWith("optional") && kind !== "nullableString")
          .map(([field]) => field),
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: !entry.write,
        destructiveHint: entry.write && /archive|revoke|remove/.test(name),
      },
    }));
}
