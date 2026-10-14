import {
  type Call,
  type Clock,
  type IdGenerator,
  type ModuleStore,
  PlatformError,
  type Row,
} from "../../../platform/public";
import type { AccessApi, RequestScope } from "../../access/public";
import type { ProjectsApi } from "../../projects/public";
import type {
  Issue,
  IssueEvent,
  IssueEventReader,
  IssueHistory,
  IssuePriority,
  IssueResult,
  IssueState,
  IssuesApi,
  IssuesMaintenance,
} from "../public";
import type { queries } from "../storage/queries";
import { createMaintenance } from "./maintenance";
import { canTransition, searchExpression, searchPattern, searchTerms } from "./rules";

type Name = keyof typeof queries;
type Statement = Call<Name>;
interface Dependencies {
  readonly store: ModuleStore<"issues", Name>;
  readonly projects: Pick<
    ProjectsApi,
    "authorizeProject" | "getProject" | "getProjectIncludingArchived" | "authorizeProjectPrincipal"
  >;
  readonly access: Pick<AccessApi, "authorize" | "getPrincipalSummary">;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly eventConsumer?: string;
}
function fail(
  code: "validation" | "not_found" | "forbidden" | "conflict" | "unknown",
  message: string,
): never {
  throw new PlatformError(code, message);
}
function object(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("validation", "Invalid Issues input");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    fail("validation", "Invalid ID");
  return value;
}
function body(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()))
    fail("validation", "Invalid text");
  return value;
}
function version(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    fail("validation", "Invalid version");
  return value;
}
function priority(value: unknown): IssuePriority {
  if (value !== "low" && value !== "medium" && value !== "high" && value !== "urgent")
    fail("validation", "Invalid priority");
  return value;
}
function state(value: unknown): IssueState {
  if (value !== "todo" && value !== "in_progress" && value !== "done" && value !== "cancelled")
    fail("validation", "Invalid state");
  return value;
}
function string(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") fail("unknown", `Invalid ${field}`);
  return value;
}
function number(row: Row, field: string): number {
  const value = row[field];
  if (typeof value !== "number") fail("unknown", `Invalid ${field}`);
  return value;
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function createIssues(deps: Dependencies): {
  api: IssuesApi;
  maintenance: IssuesMaintenance;
  eventReader?: IssueEventReader;
} {
  const { store, projects, access, clock, ids } = deps;
  if (store.owner !== "issues") fail("forbidden", "Wrong Issues store");
  const eventReader = deps.eventConsumer ? (Object.freeze({}) as IssueEventReader) : undefined;
  const one = async (name: Name, values: Statement["values"]): Promise<Row | undefined> =>
    (await store.run(name, values)).rows[0];
  const w = (scope: RequestScope) => id(scope.workspaceId);
  const actor = (scope: RequestScope) => id(scope.principalId);
  const kind = (scope: RequestScope) => (scope.kind === "machine" ? "machine" : "human");
  const fromRow = (row: Row, projectKey: string): Issue => ({
    id: string(row, "id"),
    projectId: string(row, "project_id"),
    number: number(row, "number"),
    reference: `${projectKey}-${number(row, "number")}`,
    title: string(row, "title"),
    description: string(row, "description"),
    priority: priority(row.priority),
    state: state(row.state),
    assigneeId: row.assignee_id === null ? null : string(row, "assignee_id"),
    version: number(row, "version"),
    archived: row.archived === 1,
  });
  async function issue(
    scope: RequestScope,
    issueId: string,
    permission: "read" | "write" = "read",
    allowArchived = false,
    allowArchivedProject = false,
  ): Promise<Issue> {
    const row = await one("issue", [w(scope), id(issueId)]);
    if (!row) fail("not_found", "Issue not found");
    const project =
      allowArchivedProject && permission === "read"
        ? await projects.getProjectIncludingArchived(scope, string(row, "project_id"))
        : await projects.authorizeProject(scope, string(row, "project_id"), permission);
    if (!allowArchived && row.archived === 1) fail("not_found", "Issue not found");
    return fromRow(row, project.key);
  }
  async function replay(
    scope: RequestScope,
    operationId: string,
    fingerprint: string,
  ): Promise<IssueResult | null> {
    const row = await one("readReceipt", [w(scope), actor(scope), id(operationId)]);
    if (!row) return null;
    await issue(scope, string(row, "result_id"), "read", true);
    if (row.fingerprint !== fingerprint)
      fail("conflict", "Operation ID reused with different input");
    return {
      id: string(row, "result_id"),
      number: number(row, "result_number"),
      version: number(row, "result_version"),
    };
  }
  async function commit(
    scope: RequestScope,
    operationId: string,
    fingerprint: string,
    issueId: string,
    nextVersion: number,
    action: string,
    detail: string,
    calls: readonly Statement[],
  ): Promise<IssueResult> {
    const workspaceId = w(scope);
    const at = clock.now();
    const eventType =
      action === "create"
        ? "IssueCreated"
        : action === "archive"
          ? "IssueArchived"
          : "IssueChanged";
    try {
      await store.batch([
        ...calls,
        { name: "deleteSearch", values: [workspaceId, issueId] },
        { name: "upsertSearch", values: [workspaceId, issueId] },
        {
          name: "history",
          values: [
            workspaceId,
            issueId,
            nextVersion,
            action,
            actor(scope),
            kind(scope),
            at,
            detail,
            scope.clientId ?? null,
          ],
        },
        {
          name: "receipt",
          values: [workspaceId, actor(scope), operationId, fingerprint, workspaceId, issueId],
        },
        {
          name: "event",
          values: [
            workspaceId,
            workspaceId,
            ids.next(),
            issueId,
            nextVersion,
            eventType,
            at,
            actor(scope),
            kind(scope),
            scope.clientId ?? null,
            workspaceId,
            issueId,
          ],
        },
      ]);
    } catch (error) {
      try {
        const saved = await replay(scope, operationId, fingerprint);
        if (saved) return saved;
      } catch (recovery) {
        if (recovery instanceof PlatformError) throw recovery;
        fail("unknown", "Operation outcome unknown; retry same operation ID");
      }
      if (error instanceof Error && /scope frozen/i.test(error.message))
        fail("conflict", "Scope frozen");
      if (
        error instanceof Error &&
        /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(error.message)
      )
        fail("conflict", "Version or invariant conflict");
      fail("unknown", "Operation outcome unknown; retry same operation ID");
    }
    const saved = await replay(scope, operationId, fingerprint);
    if (!saved) fail("unknown", "Operation outcome unknown; retry same operation ID");
    return saved;
  }
  function guarded(scope: RequestScope, change: Statement): readonly Statement[] {
    const guardId = ids.next();
    return [
      change,
      { name: "guard", values: [w(scope), guardId] },
      { name: "clearGuard", values: [w(scope), guardId] },
    ];
  }
  async function fingerprint(
    action: string,
    operationId: unknown,
    values: readonly unknown[],
  ): Promise<string> {
    id(operationId);
    return digest(JSON.stringify([action, ...values]));
  }
  const api: IssuesApi = {
    async createIssue(scope, input) {
      object(input);
      const projectId = id(input.projectId),
        issueId = id(input.issueId);
      const title = body(input.title, 512).trim(),
        description = body(input.description, 100000, true),
        level = priority(input.priority);
      await projects.authorizeProject(scope, projectId, "write");
      const fp = await fingerprint("create", input.operationId, [
        projectId,
        issueId,
        title,
        description,
        level,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      return commit(
        scope,
        input.operationId,
        fp,
        issueId,
        1,
        "create",
        JSON.stringify({ title, description, priority: level }),
        [
          { name: "allocate", values: [w(scope), projectId] },
          ...guarded(scope, {
            name: "create",
            values: [w(scope), issueId, projectId, title, description, level, w(scope), projectId],
          }),
        ],
      );
    },
    async editIssue(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true);
      const expected = version(input.expectedVersion);
      const title = body(input.title, 512).trim(),
        description = body(input.description, 100000, true),
        level = priority(input.priority);
      const fp = await fingerprint("edit", input.operationId, [
        current.id,
        expected,
        title,
        description,
        level,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "edit",
        JSON.stringify({ title, description, priority: level }),
        guarded(scope, {
          name: "edit",
          values: [title, description, level, w(scope), current.id, expected],
        }),
      );
    },
    async transitionIssue(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true);
      const expected = version(input.expectedVersion),
        target = state(input.state);
      const fp = await fingerprint("transition", input.operationId, [current.id, expected, target]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      if (!canTransition(current.state, target)) fail("conflict", "Transition not allowed");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "transition",
        JSON.stringify({ from: current.state, to: target }),
        guarded(scope, { name: "transition", values: [target, w(scope), current.id, expected] }),
      );
    },
    async assignIssue(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true);
      const expected = version(input.expectedVersion),
        assigneeId = input.assigneeId === null ? null : id(input.assigneeId);
      const fp = await fingerprint("assign", input.operationId, [current.id, expected, assigneeId]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      if (assigneeId !== null) {
        await access.getPrincipalSummary(scope, assigneeId);
        await projects.authorizeProjectPrincipal(scope, current.projectId, assigneeId);
      }
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "assign",
        JSON.stringify({ assigneeId }),
        guarded(scope, { name: "assign", values: [assigneeId, w(scope), current.id, expected] }),
      );
    },
    async addComment(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true);
      const expected = version(input.expectedVersion),
        commentId = id(input.commentId),
        text = body(input.body, 100000);
      const fp = await fingerprint("comment", input.operationId, [
        current.id,
        expected,
        commentId,
        text,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "comment",
        JSON.stringify({ commentId, body: text }),
        [
          ...guarded(scope, { name: "bump", values: [w(scope), current.id, expected] }),
          {
            name: "comment",
            values: [
              w(scope),
              commentId,
              current.id,
              text,
              actor(scope),
              kind(scope),
              clock.now(),
              scope.clientId ?? null,
            ],
          },
        ],
      );
    },
    async archiveIssue(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true);
      const expected = version(input.expectedVersion);
      const fp = await fingerprint("archive", input.operationId, [current.id, expected]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "archive",
        "{}",
        guarded(scope, { name: "archive", values: [w(scope), current.id, expected] }),
      );
    },
    async getIssue(scope, input) {
      object(input);
      if ("issueId" in input) return issue(scope, input.issueId);
      const projectId = id(input.projectId);
      const project =
        "reference" in input
          ? await projects.getProject(scope, projectId)
          : await projects.authorizeProject(scope, projectId);
      let issueNumber: number;
      if ("reference" in input) {
        if (typeof input.reference !== "string") fail("validation", "Invalid reference");
        const prefix = `${project.key}-`;
        if (
          !input.reference.startsWith(prefix) ||
          !/^[1-9][0-9]*$/.test(input.reference.slice(prefix.length))
        )
          fail("not_found", "Issue not found");
        issueNumber = Number(input.reference.slice(prefix.length));
      } else issueNumber = input.number;
      version(issueNumber);
      const row = await one("byNumber", [w(scope), projectId, issueNumber]);
      if (!row || row.archived === 1) fail("not_found", "Issue not found");
      return fromRow(row, project.key);
    },
    getIssueIncludingArchived: (scope, issueId) => issue(scope, issueId, "read", true, true),
    async listIssues(scope, input) {
      object(input);
      const projectId = id(input.projectId);
      const project = await projects.authorizeProject(scope, projectId);
      const limit = input.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      if (
        input.cursor !== undefined &&
        (typeof input.cursor !== "string" || !/^[1-9][0-9]*$/.test(input.cursor))
      )
        fail("validation", "Invalid cursor");
      const cursor =
        input.cursor === undefined ? Number.MAX_SAFE_INTEGER : version(Number(input.cursor));
      const filterState = input.state === undefined ? null : state(input.state);
      const filterPriority = input.priority === undefined ? null : priority(input.priority);
      const assigneeMode = input.assigneeId === undefined ? 0 : input.assigneeId === null ? 1 : 2;
      const assignee =
        input.assigneeId === undefined || input.assigneeId === null ? null : id(input.assigneeId);
      const rows = (
        await store.run("list", [
          w(scope),
          projectId,
          cursor,
          filterState,
          filterState,
          filterPriority,
          filterPriority,
          assigneeMode,
          assigneeMode,
          assigneeMode,
          assignee,
          limit + 1,
        ])
      ).rows;
      const selected = rows.slice(0, limit);
      return {
        issues: selected.map((row) => fromRow(row, project.key)),
        nextCursor:
          rows.length > limit ? String(number(selected[selected.length - 1], "number")) : null,
      };
    },
    async searchIssues(scope, input) {
      object(input);
      const projectId = id(input.projectId);
      const project = await projects.authorizeProject(scope, projectId);
      const text = body(input.text, 256);
      const terms = searchTerms(text);
      if (!terms.length || terms.length > 12) fail("validation", "Expected 1–12 search terms");
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      return (
        await (terms.some((term) => Array.from(term).length < 3)
          ? store.run("searchShort", [
              ...Array.from({ length: 12 }, (_, index) =>
                terms[index] === undefined ? null : searchPattern(terms[index]),
              ),
              w(scope),
              projectId,
              limit,
            ])
          : store.run("search", [
              searchExpression(terms),
              w(scope),
              projectId,
              w(scope),
              projectId,
              limit,
            ]))
      ).rows.map((row) => fromRow(row, project.key));
    },
    async getHistory(scope, issueId) {
      await issue(scope, issueId);
      return (await store.run("getHistory", [w(scope), issueId])).rows.map(
        (row): IssueHistory => ({
          version: number(row, "version"),
          action: string(row, "action"),
          actorId: string(row, "actor_id"),
          actorKind: row.actor_kind === "machine" ? "machine" : "human",
          clientId: row.client_id === null ? null : string(row, "client_id"),
          occurredAt: number(row, "occurred_at"),
          detail: string(row, "detail"),
        }),
      );
    },
    authorizeIssue: issue,
    async readOperation(scope, operationId) {
      id(operationId);
      await access.authorize(scope, "read");
      const row = await one("readReceipt", [w(scope), actor(scope), operationId]);
      if (!row) return null;
      await issue(scope, string(row, "result_id"), "read", true);
      return {
        id: string(row, "result_id"),
        number: number(row, "result_number"),
        version: number(row, "result_version"),
      };
    },
    async readEvents(reader, workspaceId, cursor, limit) {
      if (!eventReader || reader !== eventReader) fail("forbidden", "Event reader denied");
      id(workspaceId);
      if (
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("validation", "Invalid cursor");
      return (await store.run("events", [workspaceId, cursor, limit])).rows.map(
        (row): IssueEvent => ({
          eventId: string(row, "event_id"),
          source: "issues",
          schemaVersion: 1,
          workspaceId,
          projectId: row.project_id === null ? null : string(row, "project_id"),
          aggregateId: string(row, "aggregate_id"),
          aggregateVersion: number(row, "aggregate_version"),
          type:
            row.type === "IssueCreated"
              ? "IssueCreated"
              : row.type === "IssueArchived"
                ? "IssueArchived"
                : "IssueChanged",
          occurredAt: number(row, "occurred_at"),
          payload: {
            actorId: string(row, "actor_id"),
            actorKind: row.actor_kind === "machine" ? "machine" : "human",
            clientId: row.client_id === null ? null : string(row, "client_id"),
          },
          cursor: number(row, "sequence"),
        }),
      );
    },
  };
  return { api: Object.freeze(api), eventReader, maintenance: createMaintenance(store) };
}
