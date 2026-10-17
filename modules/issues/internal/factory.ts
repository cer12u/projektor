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
  ChildRollup,
  Issue,
  IssueComment,
  IssueEvent,
  IssueEventReader,
  IssueFilters,
  IssueHistory,
  IssueLink,
  IssuePriority,
  IssueResult,
  IssueState,
  IssuesApi,
  IssuesMaintenance,
  TaskStatus,
  TaskType,
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
    | "authorizeProject"
    | "getProject"
    | "getProjectIncludingArchived"
    | "authorizeProjectPrincipal"
    | "listVisibleProjects"
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
function definitionKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(value))
    fail("validation", "Invalid definition key");
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
  if (
    value !== "none" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "urgent"
  )
    fail("validation", "Invalid priority");
  return value;
}
function estimateValue(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000)
    fail("validation", "Invalid estimate");
  return value;
}
function calendarDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail("validation", "Invalid due date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    fail("validation", "Invalid due date");
  return value;
}
function state(value: unknown): IssueState {
  if (value !== "todo" && value !== "in_progress" && value !== "done" && value !== "cancelled")
    fail("validation", "Invalid state");
  return value;
}
function validateLabels(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((label) => typeof label === "string" && label.length <= 128)
  )
    fail("validation", "Invalid labels");
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
  const legacyPriority = (value: IssuePriority) => (value === "none" ? "low" : value);
  const builtInStatuses: readonly TaskStatus[] = [
    {
      id: "status_backlog",
      key: "backlog",
      name: "Backlog",
      category: "todo",
      color: null,
      position: 1,
      isDefault: true,
      isReviewStep: false,
      version: 1,
    },
    {
      id: "status_todo",
      key: "todo",
      name: "Todo",
      category: "todo",
      color: null,
      position: 2,
      isDefault: false,
      isReviewStep: false,
      version: 1,
    },
    {
      id: "status_in_progress",
      key: "in_progress",
      name: "In Progress",
      category: "in_progress",
      color: null,
      position: 3,
      isDefault: false,
      isReviewStep: false,
      version: 1,
    },
    {
      id: "status_in_review",
      key: "in_review",
      name: "In Review",
      category: "in_progress",
      color: null,
      position: 4,
      isDefault: false,
      isReviewStep: true,
      version: 1,
    },
    {
      id: "status_done",
      key: "done",
      name: "Done",
      category: "done",
      color: null,
      position: 5,
      isDefault: false,
      isReviewStep: false,
      version: 1,
    },
    {
      id: "status_cancelled",
      key: "cancelled",
      name: "Cancelled",
      category: "cancelled",
      color: null,
      position: 6,
      isDefault: false,
      isReviewStep: false,
      version: 1,
    },
  ];
  const builtInTypes: readonly TaskType[] = [
    {
      id: "type_epic",
      key: "epic",
      name: "Epic",
      color: null,
      icon: null,
      position: 1,
      isDefault: false,
      version: 1,
    },
    {
      id: "type_story",
      key: "story",
      name: "Story",
      color: null,
      icon: null,
      position: 2,
      isDefault: false,
      version: 1,
    },
    {
      id: "type_task",
      key: "task",
      name: "Task",
      color: null,
      icon: null,
      position: 3,
      isDefault: true,
      version: 1,
    },
    {
      id: "type_bug",
      key: "bug",
      name: "Bug",
      color: null,
      icon: null,
      position: 4,
      isDefault: false,
      version: 1,
    },
  ];
  const fromStatus = (row: Row): TaskStatus => ({
    id: string(row, "id"),
    key: string(row, "key"),
    name: string(row, "name"),
    category: state(row.category),
    color: row.color === null ? null : string(row, "color"),
    position: number(row, "position"),
    isDefault: row.is_default === 1,
    isReviewStep: row.is_review_step === 1,
    version: number(row, "version"),
  });
  const fromType = (row: Row): TaskType => ({
    id: string(row, "id"),
    key: string(row, "key"),
    name: string(row, "name"),
    color: row.color === null ? null : string(row, "color"),
    icon: row.icon === null ? null : string(row, "icon"),
    position: number(row, "position"),
    isDefault: row.is_default === 1,
    version: number(row, "version"),
  });
  async function statuses(scope: RequestScope): Promise<readonly TaskStatus[]> {
    await access.authorize(scope, "read");
    const rows = (await store.run("statusRows", [w(scope)])).rows;
    return rows.length ? rows.map(fromStatus) : builtInStatuses;
  }
  async function types(scope: RequestScope): Promise<readonly TaskType[]> {
    await access.authorize(scope, "read");
    const rows = (await store.run("typeRows", [w(scope)])).rows;
    return rows.length ? rows.map(fromType) : builtInTypes;
  }
  async function requiredStatus(scope: RequestScope, statusId: string): Promise<TaskStatus> {
    const found = (await statuses(scope)).find((item) => item.id === statusId);
    if (!found) fail("validation", "Unknown status");
    return found;
  }
  async function requiredType(scope: RequestScope, typeId: string): Promise<TaskType> {
    const found = (await types(scope)).find((item) => item.id === typeId);
    if (!found) fail("validation", "Unknown type");
    return found;
  }
  async function seedCalls(scope: RequestScope): Promise<Statement[]> {
    const ws = w(scope);
    const calls: Statement[] = [];
    const presence = await one("seedPresence", [ws, ws]);
    if (presence?.statuses !== 1) calls.push({ name: "seedStatuses", values: Array(6).fill(ws) });
    if (presence?.types !== 1) calls.push({ name: "seedTypes", values: Array(4).fill(ws) });
    return calls;
  }
  const fromRow = (row: Row, projectKey: string): Issue => ({
    id: string(row, "id"),
    projectId: string(row, "project_id"),
    number: number(row, "number"),
    reference: `${projectKey}-${number(row, "number")}`,
    title: string(row, "title"),
    description: string(row, "description"),
    priority: priority(row.priority_level),
    state: state(row.state),
    status: string(row, "status"),
    statusId: string(row, "status_id"),
    statusCategory: state(row.state),
    typeId: row.type_id === null ? null : string(row, "type_id"),
    parentId: row.parent_id === null ? null : string(row, "parent_id"),
    labels: JSON.parse(string(row, "labels")) as string[],
    createdById: string(row, "created_by_id"),
    createdByKind: row.created_by_kind === "machine" ? "machine" : "human",
    createdAt: number(row, "created_at"),
    updatedAt: number(row, "updated_at"),
    completedAt: row.completed_at === null ? null : number(row, "completed_at"),
    doneAt: row.done_at === null ? null : number(row, "done_at"),
    readyAt: row.ready_at === null ? null : number(row, "ready_at"),
    claimedAt: row.claimed_at === null ? null : number(row, "claimed_at"),
    inReviewAt: row.in_review_at === null ? null : number(row, "in_review_at"),
    reviewBounceCount: number(row, "review_bounce_count"),
    assigneeId: row.assignee_id === null ? null : string(row, "assignee_id"),
    estimate: row.estimate === null ? null : number(row, "estimate"),
    dueDate: row.due_date === null ? null : string(row, "due_date"),
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
  async function authorizeIssuesByIds(
    scope: RequestScope,
    ids: readonly string[],
    includeArchived = false,
  ): Promise<void> {
    if (!Array.isArray(ids) || ids.length > 100) fail("validation", "Invalid IDs");
    await access.authorize(scope, "read");
    const checked = ids.map(id);
    const rows = (await store.run("parentsByIds", [JSON.stringify(checked), w(scope)])).rows;
    const found = new Map(rows.map((row) => [string(row, "id"), row]));
    if (checked.some((value) => !found.has(value))) fail("not_found", "Issue not found");
    const projectIds = [...new Set(rows.map((row) => string(row, "project_id")))];
    for (const projectId of projectIds) {
      if (includeArchived) await projects.getProjectIncludingArchived(scope, projectId);
      else await projects.authorizeProject(scope, projectId);
    }
    if (!includeArchived && rows.some((row) => row.archived === 1))
      fail("not_found", "Issue not found");
  }
  function defaultIssueList(filters: IssueFilters): boolean {
    return (
      filters.sort === undefined &&
      filters.statusIds === undefined &&
      filters.category === undefined &&
      filters.priorities === undefined &&
      filters.assigneeId === undefined &&
      filters.parentId === undefined &&
      !filters.noParent &&
      filters.typeId === undefined &&
      filters.excludeTypeIds === undefined &&
      (!filters.labels || filters.labels.length === 0) &&
      filters.completedAfter === undefined &&
      filters.completedBefore === undefined &&
      filters.updatedAfter === undefined &&
      filters.updatedBefore === undefined &&
      filters.dueBefore === undefined &&
      filters.dueAfter === undefined &&
      !filters.overdue &&
      filters.hasDueDate === undefined &&
      filters.issueIds === undefined &&
      !filters.includeArchived
    );
  }
  async function validateParent(
    scope: RequestScope,
    parentId: string,
    issueId: string | null,
  ): Promise<void> {
    if (parentId === issueId) fail("validation", "An issue cannot be its own parent");
    const chain = (await store.run("parentChain", [w(scope), parentId, w(scope)])).rows;
    if (!chain.length) fail("not_found", "Parent issue not found");
    await projects.authorizeProject(scope, string(chain[0], "project_id"));
    let count = 0;
    for (const row of chain.slice(1)) {
      if (string(row, "id") === issueId)
        fail("validation", "Setting this parent would create a cycle");
      count++;
      if (count >= 5) fail("validation", "Maximum nesting depth (5) exceeded");
    }
  }
  async function replay(
    scope: RequestScope,
    operationId: string,
    fingerprint: string,
  ): Promise<IssueResult | null> {
    const row = await one("readReceipt", [w(scope), actor(scope), id(operationId)]);
    if (!row) {
      if (await one("readDefinitionReceipt", [w(scope), actor(scope), operationId]))
        fail("conflict", "Operation ID reused with different input");
      return null;
    }
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
    const seeds = await seedCalls(scope);
    const eventType =
      action === "create"
        ? "IssueCreated"
        : action === "archive"
          ? "IssueArchived"
          : "IssueChanged";
    try {
      await store.batch([
        ...seeds,
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
  async function manageDefinitions(scope: RequestScope): Promise<void> {
    const live = await access.authorize(scope, "write");
    if (live.kind !== "human" || live.clientId || (live.role !== "owner" && live.role !== "admin"))
      fail("forbidden", "Workspace admin required");
  }
  async function replayDefinition<T>(
    scope: RequestScope,
    operationId: string,
    fp: string,
  ): Promise<T | null> {
    const row = await one("readDefinitionReceipt", [w(scope), actor(scope), id(operationId)]);
    if (!row) {
      if (await one("readReceipt", [w(scope), actor(scope), operationId]))
        fail("conflict", "Operation ID reused with different input");
      return null;
    }
    if (row.fingerprint !== fp) fail("conflict", "Operation ID reused with different input");
    const result: unknown = JSON.parse(string(row, "result_json"));
    return result as T;
  }
  async function commitDefinition<T>(
    scope: RequestScope,
    operationId: string,
    fp: string,
    definitionKind: "status" | "type",
    definitionId: string,
    resultVersion: number,
    action: string,
    result: T,
    calls: readonly Statement[],
  ): Promise<T> {
    const ws = w(scope),
      at = clock.now();
    const seeds = await seedCalls(scope);
    try {
      await store.batch([
        ...seeds,
        ...calls,
        {
          name: "definitionHistory",
          values: [
            ws,
            definitionKind,
            definitionId,
            resultVersion,
            action,
            actor(scope),
            kind(scope),
            at,
            JSON.stringify(result),
          ],
        },
        {
          name: "definitionReceipt",
          values: [
            ws,
            actor(scope),
            operationId,
            fp,
            definitionKind,
            definitionId,
            resultVersion,
            JSON.stringify(result),
          ],
        },
        {
          name: "definitionEvent",
          values: [
            ws,
            ws,
            ids.next(),
            definitionId,
            resultVersion,
            definitionKind === "status" ? "TaskStatusChanged" : "TaskTypeChanged",
            at,
            actor(scope),
            kind(scope),
            scope.clientId ?? null,
          ],
        },
      ]);
    } catch (error) {
      const saved = await replayDefinition<T>(scope, operationId, fp);
      if (saved) return saved;
      if (error instanceof Error && /scope frozen/i.test(error.message))
        fail("conflict", "Scope frozen");
      if (
        error instanceof Error &&
        /(?:CHECK|UNIQUE|FOREIGN KEY) constraint failed/i.test(error.message)
      )
        fail("conflict", "Version or invariant conflict");
      fail("unknown", "Operation outcome unknown; retry same operation ID");
    }
    const saved = await replayDefinition<T>(scope, operationId, fp);
    if (!saved) fail("unknown", "Operation outcome unknown; retry same operation ID");
    return saved;
  }
  function position(value: number | undefined, fallback = 0): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 0) fail("validation", "Invalid position");
    return result;
  }
  function flag(value: boolean | undefined, fallback = false): boolean {
    if (value !== undefined && typeof value !== "boolean") fail("validation", "Invalid flag");
    return value ?? fallback;
  }
  function optionalText(
    value: string | null | undefined,
    fallback: string | null = null,
  ): string | null {
    if (value === undefined) return fallback;
    if (value === null) return null;
    return body(value, 128, true);
  }
  function flowValues(
    current: Pick<
      Issue,
      "status" | "statusCategory" | "readyAt" | "claimedAt" | "inReviewAt" | "reviewBounceCount"
    > | null,
    next: { key: string; category: IssueState; review: boolean },
    at: number,
    wasReview = current?.status === "in_review",
  ) {
    const ready =
      next.key !== "backlog" && next.category !== "done" && next.category !== "cancelled";
    const claimed = next.category === "in_progress" || next.review;
    const enteringReview = next.review && !wasReview;
    const leavingReview = wasReview && !next.review && next.category !== "done";
    return {
      readyAt: current?.readyAt ?? (ready ? at : null),
      claimedAt:
        current?.claimedAt ??
        (claimed && (current === null || current.statusCategory !== "in_progress") ? at : null),
      inReviewAt: current?.inReviewAt ?? (enteringReview ? at : null),
      reviewBounceCount: (current?.reviewBounceCount ?? 0) + (leavingReview ? 1 : 0),
    };
  }
  async function statusSync(
    scope: RequestScope,
    statusId: string,
    category: IssueState,
  ): Promise<Statement[]> {
    const rows = (await store.run("issuesByStatus", [w(scope), statusId])).rows;
    const calls: Statement[] = [];
    for (const row of rows) {
      const issueId = string(row, "id"),
        oldCategory = state(row.state),
        nextVersion = number(row, "version") + 1,
        at = clock.now();
      if (oldCategory === category) continue;
      const completedAt = category === "done" ? at : null;
      const doneAt =
        category === "done" ? (row.done_at === null ? at : number(row, "done_at")) : null;
      const flow = flowValues(
        {
          status: string(row, "status"),
          statusCategory: oldCategory,
          readyAt: row.ready_at === null ? null : number(row, "ready_at"),
          claimedAt: row.claimed_at === null ? null : number(row, "claimed_at"),
          inReviewAt: row.in_review_at === null ? null : number(row, "in_review_at"),
          reviewBounceCount: number(row, "review_bounce_count"),
        },
        { key: string(row, "status"), category, review: string(row, "status") === "in_review" },
        at,
      );
      calls.push(
        ...guarded(scope, {
          name: "syncStatusCategory",
          values: [
            category,
            completedAt,
            doneAt,
            flow.readyAt,
            flow.claimedAt,
            flow.inReviewAt,
            flow.reviewBounceCount,
            at,
            w(scope),
            issueId,
            nextVersion - 1,
          ],
        }),
      );
      calls.push({
        name: "history",
        values: [
          w(scope),
          issueId,
          nextVersion,
          "status_category_changed",
          actor(scope),
          kind(scope),
          at,
          JSON.stringify({ from: oldCategory, to: category, statusId }),
          scope.clientId ?? null,
        ],
      });
      calls.push({
        name: "event",
        values: [
          w(scope),
          w(scope),
          ids.next(),
          issueId,
          nextVersion,
          "IssueChanged",
          at,
          actor(scope),
          kind(scope),
          scope.clientId ?? null,
          w(scope),
          issueId,
        ],
      });
    }
    return calls;
  }
  const api: IssuesApi = {
    listTaskStatuses: statuses,
    listTaskTypes: types,
    async createTaskStatus(scope, input) {
      object(input);
      await manageDefinitions(scope);
      const definitionId = id(input.id),
        key = definitionKey(input.key),
        name = body(input.name, 128).trim(),
        category = state(input.category),
        color = optionalText(input.color),
        at = position(input.position),
        isDefault = flag(input.isDefault),
        isReviewStep = flag(input.isReviewStep);
      const result: TaskStatus = {
        id: definitionId,
        key,
        name,
        category,
        color,
        position: at,
        isDefault,
        isReviewStep,
        version: 1,
      };
      const fp = await fingerprint("status.create", input.operationId, [result]);
      const saved = await replayDefinition<TaskStatus>(scope, input.operationId, fp);
      if (saved) return saved;
      if ((await statuses(scope)).some((item) => item.key === key || item.id === definitionId))
        fail("conflict", "Status already exists");
      return commitDefinition(
        scope,
        input.operationId,
        fp,
        "status",
        definitionId,
        1,
        "create",
        result,
        [
          ...(isDefault
            ? [{ name: "clearDefaultStatus" as const, values: [w(scope), definitionId] }]
            : []),
          ...guarded(scope, {
            name: "createStatus",
            values: [
              w(scope),
              definitionId,
              key,
              name,
              category,
              color,
              at,
              isDefault ? 1 : 0,
              isReviewStep ? 1 : 0,
            ],
          }),
        ],
      );
    },
    async updateTaskStatus(scope, input) {
      object(input);
      await manageDefinitions(scope);
      const definitionId = id(input.id),
        expected = version(input.expectedVersion);
      const current = (await statuses(scope)).find((item) => item.id === definitionId);
      const fp = await fingerprint("status.update", input.operationId, [
        definitionId,
        expected,
        input,
      ]);
      const saved = await replayDefinition<TaskStatus>(scope, input.operationId, fp);
      if (saved) return saved;
      if (!current) fail("not_found", "Status not found");
      const result: TaskStatus = {
        ...current,
        name: input.name === undefined ? current.name : body(input.name, 128).trim(),
        category: input.category === undefined ? current.category : state(input.category),
        color: optionalText(input.color, current.color),
        position: position(input.position, current.position),
        isDefault: flag(input.isDefault, current.isDefault),
        isReviewStep: flag(input.isReviewStep, current.isReviewStep),
        version: expected + 1,
      };
      const sync =
        result.category !== current.category
          ? await statusSync(scope, definitionId, result.category)
          : [];
      return commitDefinition(
        scope,
        input.operationId,
        fp,
        "status",
        definitionId,
        expected + 1,
        "update",
        result,
        [
          ...(result.isDefault
            ? [{ name: "clearDefaultStatus" as const, values: [w(scope), definitionId] }]
            : []),
          ...guarded(scope, {
            name: "updateStatus",
            values: [
              result.name,
              result.category,
              result.color,
              result.position,
              result.isDefault ? 1 : 0,
              result.isReviewStep ? 1 : 0,
              w(scope),
              definitionId,
              expected,
            ],
          }),
          ...sync,
        ],
      );
    },
    async deleteTaskStatus(scope, input) {
      object(input);
      await manageDefinitions(scope);
      const definitionId = id(input.id),
        expected = version(input.expectedVersion);
      const fp = await fingerprint("status.delete", input.operationId, [definitionId, expected]);
      const saved = await replayDefinition<{ id: string; version: number }>(
        scope,
        input.operationId,
        fp,
      );
      if (saved) return saved;
      const current = (await statuses(scope)).find((item) => item.id === definitionId);
      if (!current) fail("not_found", "Status not found");
      if (current.isDefault) fail("conflict", "Cannot delete the default task status");
      if (await one("statusInUse", [w(scope), definitionId]))
        fail("conflict", "Task status is in use");
      return commitDefinition(
        scope,
        input.operationId,
        fp,
        "status",
        definitionId,
        expected + 1,
        "delete",
        { id: definitionId, version: expected + 1 },
        guarded(scope, {
          name: "deleteStatus",
          values: [w(scope), definitionId, expected, w(scope), definitionId],
        }),
      );
    },
    async createTaskType(scope, input) {
      object(input);
      await manageDefinitions(scope);
      const definitionId = id(input.id),
        key = definitionKey(input.key),
        name = body(input.name, 128).trim(),
        color = optionalText(input.color),
        icon = optionalText(input.icon),
        at = position(input.position),
        isDefault = flag(input.isDefault);
      const result: TaskType = {
        id: definitionId,
        key,
        name,
        color,
        icon,
        position: at,
        isDefault,
        version: 1,
      };
      const fp = await fingerprint("type.create", input.operationId, [result]);
      const saved = await replayDefinition<TaskType>(scope, input.operationId, fp);
      if (saved) return saved;
      if ((await types(scope)).some((item) => item.key === key || item.id === definitionId))
        fail("conflict", "Type already exists");
      return commitDefinition(
        scope,
        input.operationId,
        fp,
        "type",
        definitionId,
        1,
        "create",
        result,
        [
          ...(isDefault
            ? [{ name: "clearDefaultType" as const, values: [w(scope), definitionId] }]
            : []),
          ...guarded(scope, {
            name: "createType",
            values: [w(scope), definitionId, key, name, color, icon, at, isDefault ? 1 : 0],
          }),
        ],
      );
    },
    async updateTaskType(scope, input) {
      object(input);
      await manageDefinitions(scope);
      const definitionId = id(input.id),
        expected = version(input.expectedVersion);
      const fp = await fingerprint("type.update", input.operationId, [
        definitionId,
        expected,
        input,
      ]);
      const saved = await replayDefinition<TaskType>(scope, input.operationId, fp);
      if (saved) return saved;
      const current = (await types(scope)).find((item) => item.id === definitionId);
      if (!current) fail("not_found", "Type not found");
      const result: TaskType = {
        ...current,
        name: input.name === undefined ? current.name : body(input.name, 128).trim(),
        color: optionalText(input.color, current.color),
        icon: optionalText(input.icon, current.icon),
        position: position(input.position, current.position),
        isDefault: flag(input.isDefault, current.isDefault),
        version: expected + 1,
      };
      return commitDefinition(
        scope,
        input.operationId,
        fp,
        "type",
        definitionId,
        expected + 1,
        "update",
        result,
        [
          ...(result.isDefault
            ? [{ name: "clearDefaultType" as const, values: [w(scope), definitionId] }]
            : []),
          ...guarded(scope, {
            name: "updateType",
            values: [
              result.name,
              result.color,
              result.icon,
              result.position,
              result.isDefault ? 1 : 0,
              w(scope),
              definitionId,
              expected,
            ],
          }),
        ],
      );
    },
    async deleteTaskType(scope, input) {
      object(input);
      await manageDefinitions(scope);
      const definitionId = id(input.id),
        expected = version(input.expectedVersion);
      const fp = await fingerprint("type.delete", input.operationId, [definitionId, expected]);
      const saved = await replayDefinition<{ id: string; version: number }>(
        scope,
        input.operationId,
        fp,
      );
      if (saved) return saved;
      if (!(await types(scope)).some((item) => item.id === definitionId))
        fail("not_found", "Type not found");
      if (await one("typeInUse", [w(scope), definitionId])) fail("conflict", "Task type is in use");
      return commitDefinition(
        scope,
        input.operationId,
        fp,
        "type",
        definitionId,
        expected + 1,
        "delete",
        { id: definitionId, version: expected + 1 },
        guarded(scope, {
          name: "deleteType",
          values: [w(scope), definitionId, expected, w(scope), definitionId],
        }),
      );
    },
    async createIssue(scope, input) {
      object(input);
      const projectId = id(input.projectId),
        issueId = id(input.issueId);
      const title = body(input.title, 512).trim(),
        description = body(input.description, 100000, true),
        level = priority(input.priority);
      await projects.authorizeProject(scope, projectId, "write");
      const definition =
        input.statusId === undefined
          ? ((await statuses(scope)).find((item) => item.isDefault) ?? builtInStatuses[0])
          : await requiredStatus(scope, id(input.statusId));
      const statusId = definition.id,
        statusKey = definition.key,
        category = definition.category;
      const typeId = input.typeId === undefined || input.typeId === null ? null : id(input.typeId);
      if (typeId) await requiredType(scope, typeId);
      const parentId =
        input.parentId === undefined || input.parentId === null ? null : id(input.parentId);
      if (parentId) await validateParent(scope, parentId, null);
      const labels = validateLabels(input.labels ?? []);
      const estimate = estimateValue(input.estimate ?? null);
      const dueDate = calendarDate(input.dueDate ?? null);
      const assigneeId =
        input.assigneeId === undefined || input.assigneeId === null ? null : id(input.assigneeId);
      if (assigneeId) await projects.authorizeProjectPrincipal(scope, projectId, assigneeId);
      const fp = await fingerprint("create", input.operationId, [
        projectId,
        issueId,
        title,
        description,
        level,
        statusId,
        typeId,
        parentId,
        labels,
        assigneeId,
        estimate,
        dueDate,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      const createdAt = clock.now();
      const flow = flowValues(
        null,
        { key: statusKey, category, review: definition.isReviewStep },
        createdAt,
      );
      return commit(
        scope,
        input.operationId,
        fp,
        issueId,
        1,
        "create",
        JSON.stringify({
          title,
          description,
          priority: level,
          statusId,
          typeId,
          parentId,
          labels,
          assigneeId,
          estimate,
          dueDate,
        }),
        [
          { name: "allocate", values: [w(scope), projectId] },
          ...guarded(scope, {
            name: "create",
            values: [
              w(scope),
              issueId,
              projectId,
              title,
              description,
              legacyPriority(level),
              level,
              category,
              statusKey,
              statusId,
              typeId,
              parentId,
              JSON.stringify(labels),
              actor(scope),
              kind(scope),
              createdAt,
              createdAt,
              assigneeId,
              category === "done" ? createdAt : null,
              category === "done" ? createdAt : null,
              flow.readyAt,
              flow.claimedAt,
              flow.inReviewAt,
              flow.reviewBounceCount,
              estimate,
              dueDate,
              w(scope),
              projectId,
            ],
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
      const estimate =
        input.estimate === undefined ? current.estimate : estimateValue(input.estimate);
      const dueDate = input.dueDate === undefined ? current.dueDate : calendarDate(input.dueDate);
      const fp = await fingerprint("edit", input.operationId, [
        current.id,
        expected,
        title,
        description,
        level,
        estimate,
        dueDate,
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
        JSON.stringify({ title, description, priority: level, estimate, dueDate }),
        guarded(scope, {
          name: "edit",
          values: [
            title,
            description,
            legacyPriority(level),
            level,
            estimate,
            dueDate,
            clock.now(),
            w(scope),
            current.id,
            expected,
          ],
        }),
      );
    },
    async updateIssue(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true);
      const expected = version(input.expectedVersion);
      const title = input.title === undefined ? current.title : body(input.title, 512).trim();
      const description =
        input.description === undefined
          ? current.description
          : body(input.description, 100000, true);
      const level = input.priority === undefined ? current.priority : priority(input.priority);
      const definition =
        input.statusId === undefined
          ? await requiredStatus(scope, current.statusId)
          : await requiredStatus(scope, id(input.statusId));
      const typeId =
        input.typeId === undefined
          ? current.typeId
          : input.typeId === null
            ? null
            : id(input.typeId);
      if (typeId) await requiredType(scope, typeId);
      const parentId =
        input.parentId === undefined
          ? current.parentId
          : input.parentId === null
            ? null
            : id(input.parentId);
      if (parentId && parentId !== current.parentId)
        await validateParent(scope, parentId, current.id);
      const labels = input.labels === undefined ? current.labels : validateLabels(input.labels);
      const estimate =
        input.estimate === undefined ? current.estimate : estimateValue(input.estimate);
      const dueDate = input.dueDate === undefined ? current.dueDate : calendarDate(input.dueDate);
      const assigneeId =
        input.assigneeId === undefined
          ? current.assigneeId
          : input.assigneeId === null
            ? null
            : id(input.assigneeId);
      if (assigneeId && assigneeId !== current.assigneeId) {
        await access.getPrincipalSummary(scope, assigneeId);
        await projects.authorizeProjectPrincipal(scope, current.projectId, assigneeId);
      }
      const changed: string[] = [];
      for (const key of [
        "title",
        "description",
        "priority",
        "statusId",
        "typeId",
        "parentId",
        "labels",
        "assigneeId",
        "estimate",
        "dueDate",
      ] as const)
        if (key in input) changed.push(key);
      const now = clock.now();
      const currentStatus = await requiredStatus(scope, current.statusId);
      const flow = flowValues(
        current,
        { key: definition.key, category: definition.category, review: definition.isReviewStep },
        now,
        currentStatus.isReviewStep,
      );
      const completedAt =
        definition.category === "done"
          ? current.state === "done"
            ? current.completedAt
            : now
          : null;
      const fp = await fingerprint("update", input.operationId, [
        current.id,
        expected,
        title,
        description,
        level,
        definition.id,
        typeId,
        parentId,
        labels,
        assigneeId,
        estimate,
        dueDate,
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
        "update",
        JSON.stringify(
          input.statusId === undefined
            ? { changed, estimate, dueDate }
            : { changed, statusId: definition.id, estimate, dueDate },
        ),
        guarded(scope, {
          name: "updateIssue",
          values: [
            title,
            description,
            level,
            legacyPriority(level),
            definition.key,
            definition.id,
            definition.category,
            typeId,
            parentId,
            JSON.stringify(labels),
            assigneeId,
            completedAt,
            current.doneAt === null && definition.category === "done" ? now : null,
            flow.readyAt,
            flow.claimedAt,
            flow.inReviewAt,
            flow.reviewBounceCount,
            estimate,
            dueDate,
            now,
            w(scope),
            current.id,
            expected,
          ],
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
      const now = clock.now();
      const flow = flowValues(current, { key: target, category: target, review: false }, now);
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "transition",
        JSON.stringify({ from: current.state, to: target }),
        guarded(scope, {
          name: "transition",
          values: [
            target,
            target,
            `status_${target}`,
            target === "done" ? (current.completedAt ?? now) : null,
            current.doneAt === null && target === "done" ? now : null,
            flow.readyAt,
            flow.claimedAt,
            flow.inReviewAt,
            flow.reviewBounceCount,
            now,
            w(scope),
            current.id,
            expected,
          ],
        }),
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
        guarded(scope, {
          name: "assign",
          values: [assigneeId, clock.now(), w(scope), current.id, expected],
        }),
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
      const now = clock.now();
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "comment",
        JSON.stringify({ commentId, body: text }),
        [
          ...guarded(scope, {
            name: "bump",
            values: [now, w(scope), current.id, expected],
          }),
          {
            name: "comment",
            values: [
              w(scope),
              commentId,
              current.id,
              text,
              actor(scope),
              kind(scope),
              now,
              now,
              scope.clientId ?? null,
            ],
          },
        ],
      );
    },
    async listComments(scope, issueId) {
      await issue(scope, issueId);
      return (await store.run("listComments", [w(scope), id(issueId)])).rows.map(
        (row): IssueComment => ({
          id: string(row, "id"),
          body: string(row, "body"),
          authorId: string(row, "actor_id"),
          authorKind: row.actor_kind === "machine" ? "machine" : "human",
          clientId: row.client_id === null ? null : string(row, "client_id"),
          createdAt: number(row, "created_at"),
          updatedAt: number(row, "updated_at"),
        }),
      );
    },
    async editComment(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true),
        expected = version(input.expectedVersion),
        commentId = id(input.commentId),
        text = body(input.body, 100000);
      const fp = await fingerprint("comment_edited", input.operationId, [
        current.id,
        expected,
        commentId,
        text,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      const row = await one("getComment", [w(scope), current.id, commentId]);
      if (!row) fail("not_found", "Comment not found");
      if (string(row, "actor_id") !== actor(scope)) fail("forbidden", "Comment author required");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "comment_edited",
        JSON.stringify({ commentId }),
        [
          ...guarded(scope, {
            name: "bump",
            values: [clock.now(), w(scope), current.id, expected],
          }),
          { name: "editComment", values: [text, clock.now(), w(scope), current.id, commentId] },
        ],
      );
    },
    async deleteComment(scope, input) {
      object(input);
      const current = await issue(scope, input.issueId, "write", true),
        expected = version(input.expectedVersion),
        commentId = id(input.commentId);
      const fp = await fingerprint("comment_deleted", input.operationId, [
        current.id,
        expected,
        commentId,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (current.archived) fail("not_found", "Issue not found");
      const row = await one("getComment", [w(scope), current.id, commentId]);
      if (!row) fail("not_found", "Comment not found");
      const live = await access.authorize(scope, "write");
      if (
        string(row, "actor_id") !== actor(scope) &&
        live.role !== "owner" &&
        live.role !== "admin"
      )
        fail("forbidden", "Comment author or admin required");
      return commit(
        scope,
        input.operationId,
        fp,
        current.id,
        expected + 1,
        "comment_deleted",
        JSON.stringify({ commentId }),
        [
          ...guarded(scope, {
            name: "bump",
            values: [clock.now(), w(scope), current.id, expected],
          }),
          { name: "deleteComment", values: [w(scope), current.id, commentId] },
        ],
      );
    },
    async createIssueLink(scope, input) {
      object(input);
      const source = await issue(scope, input.sourceIssueId, "write", true),
        target = await issue(scope, input.targetIssueId, "write", true);
      const expected = version(input.expectedVersion),
        linkId = id(input.linkId);
      if (source.archived || target.archived) fail("not_found", "Issue not found");
      if (source.id === target.id) fail("validation", "An issue cannot link to itself");
      let type = input.type;
      if (
        ![
          "blocks",
          "blocked_by",
          "relates_to",
          "duplicates",
          "follows_from",
          "followed_by",
        ].includes(type)
      )
        fail("validation", "Invalid link type");
      let from = source.id,
        to = target.id;
      if (type === "blocked_by") {
        from = target.id;
        to = source.id;
        type = "blocks";
      }
      if (type === "followed_by") {
        from = target.id;
        to = source.id;
        type = "follows_from";
      }
      if ((type === "relates_to" || type === "duplicates") && from > to) [from, to] = [to, from];
      const fp = await fingerprint("link_created", input.operationId, [
        source.id,
        expected,
        linkId,
        from,
        to,
        type,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (await one("findLink", [w(scope), from, to, type]))
        fail("conflict", "Link already exists");
      return commit(
        scope,
        input.operationId,
        fp,
        source.id,
        expected + 1,
        "link_created",
        JSON.stringify({ linkId, from, to, type }),
        [
          ...guarded(scope, { name: "bump", values: [clock.now(), w(scope), source.id, expected] }),
          {
            name: "createLink",
            values: [w(scope), linkId, from, to, type, actor(scope), clock.now()],
          },
        ],
      );
    },
    async deleteIssueLink(scope, input) {
      object(input);
      const source = await issue(scope, input.sourceIssueId, "write", true),
        expected = version(input.expectedVersion),
        linkId = id(input.linkId);
      const fp = await fingerprint("link_deleted", input.operationId, [
        source.id,
        expected,
        linkId,
      ]);
      const saved = await replay(scope, input.operationId, fp);
      if (saved) return saved;
      if (source.archived) fail("not_found", "Issue not found");
      const link = await one("getLink", [w(scope), linkId]);
      if (!link) fail("not_found", "Link not found");
      if (
        string(link, "source_issue_id") !== source.id &&
        string(link, "target_issue_id") !== source.id
      )
        fail("not_found", "Link not found");
      await issue(scope, string(link, "source_issue_id"), "write");
      await issue(scope, string(link, "target_issue_id"), "write");
      return commit(
        scope,
        input.operationId,
        fp,
        source.id,
        expected + 1,
        "link_deleted",
        JSON.stringify({ linkId }),
        [
          ...guarded(scope, { name: "bump", values: [clock.now(), w(scope), source.id, expected] }),
          { name: "deleteLink", values: [w(scope), linkId, string(link, "source_issue_id")] },
        ],
      );
    },
    async listIssueLinks(scope, issueId) {
      const source = await issue(scope, issueId);
      const rows = (await store.run("listLinks", [source.id, w(scope), source.id, source.id])).rows;
      const result: IssueLink[] = [];
      const visible = new Map<string, Awaited<ReturnType<ProjectsApi["authorizeProject"]>>>();
      for (const projectId of new Set(rows.map((row) => string(row, "other_project_id"))))
        visible.set(projectId, await projects.authorizeProject(scope, projectId));
      for (const row of rows) {
        const project = visible.get(string(row, "other_project_id"));
        if (!project) fail("unknown", "Missing authorized project");
        const outbound = string(row, "source_issue_id") === source.id;
        const stored = string(row, "type");
        const type = outbound
          ? stored
          : stored === "blocks"
            ? "blocked_by"
            : stored === "follows_from"
              ? "followed_by"
              : stored;
        if (
          type !== "blocks" &&
          type !== "blocked_by" &&
          type !== "relates_to" &&
          type !== "duplicates" &&
          type !== "follows_from" &&
          type !== "followed_by"
        )
          fail("unknown", "Invalid link type");
        result.push({
          id: string(row, "id"),
          type,
          direction: outbound ? "outbound" : "inbound",
          otherIssue: {
            id: string(row, "other_id"),
            reference: `${project.key}-${number(row, "other_number")}`,
            title: string(row, "other_title"),
            status: string(row, "other_status"),
            statusCategory: state(row.other_state),
          },
        });
      }
      return result;
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
        guarded(scope, { name: "archive", values: [clock.now(), w(scope), current.id, expected] }),
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
    async queryIssues(scope, filters) {
      object(filters);
      const limit = filters.limit ?? 30;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const array = (values: readonly string[] | undefined, max = 100): string | null => {
        if (values === undefined) return null;
        if (!Array.isArray(values) || values.length > max)
          fail("validation", "Invalid filter list");
        return JSON.stringify(values.map(id));
      };
      let visible: string[] = [];
      if (filters.projectId !== undefined) {
        visible = [id(filters.projectId)];
        await projects.authorizeProject(scope, visible[0]);
      } else {
        let cursor = "";
        do {
          const page = await projects.listVisibleProjects(scope, cursor, 100);
          visible.push(...page.projects.map((p) => p.id));
          cursor = page.nextCursor ?? "";
        } while (cursor);
      }
      const statusIds = array(filters.statusIds),
        priorities =
          filters.priorities === undefined
            ? null
            : JSON.stringify(filters.priorities.map(priority));
      const exclusions = array(filters.excludeTypeIds),
        labels =
          filters.labels === undefined ? null : JSON.stringify(validateLabels(filters.labels));
      const issueIds = array(filters.issueIds);
      const category = filters.category === undefined ? null : state(filters.category);
      const assigneeMode =
        filters.assigneeId === undefined ? 0 : filters.assigneeId === null ? 1 : 2;
      const assigneeId = typeof filters.assigneeId === "string" ? id(filters.assigneeId) : null;
      const parentId = filters.parentId === undefined ? null : id(filters.parentId);
      const typeId = filters.typeId === undefined ? null : id(filters.typeId);
      const range = (value: number | undefined): number | null => {
        if (value === undefined) return null;
        if (!Number.isSafeInteger(value) || value < 0) fail("validation", "Invalid timestamp");
        return value;
      };
      const completedAfter = range(filters.completedAfter),
        completedBefore = range(filters.completedBefore),
        updatedAfter = range(filters.updatedAfter),
        updatedBefore = range(filters.updatedBefore);
      const dueBefore = filters.dueBefore === undefined ? null : calendarDate(filters.dueBefore);
      const dueAfter = filters.dueAfter === undefined ? null : calendarDate(filters.dueAfter);
      const today = filters.overdue
        ? calendarDate(filters.today ?? new Date(clock.now()).toISOString().slice(0, 10))
        : null;
      if (filters.sort !== undefined && filters.sort !== "due_date")
        fail("validation", "Invalid sort");
      let cursorAt: number | null = null,
        cursorId: string | null = null,
        cursorDate: string | null = null,
        cursorNull = 0;
      if (filters.cursor !== undefined) {
        if (typeof filters.cursor !== "string") fail("validation", "Invalid cursor");
        const match =
          filters.sort === "due_date"
            ? filters.cursor.match(/^d:(\d{4}-\d{2}-\d{2}|~):([0-9]+):([A-Za-z0-9_-]{1,128})$/)
            : filters.cursor.match(/^([0-9]+):([A-Za-z0-9_-]{1,128})$/);
        if (!match) fail("validation", "Invalid cursor");
        if (filters.sort === "due_date") {
          cursorDate = match[1] === "~" ? null : calendarDate(match[1]);
          cursorNull = cursorDate === null ? 1 : 0;
          cursorAt = range(Number(match[2]));
          cursorId = id(match[3]);
        } else {
          cursorAt = range(Number(match[1]));
          cursorId = id(match[2]);
        }
      }
      const projectId = filters.projectId ?? null;
      const dueCursor = [
        cursorAt,
        cursorNull,
        cursorNull,
        cursorNull,
        cursorAt,
        cursorAt,
        cursorId,
        cursorNull,
        cursorDate,
        cursorDate,
        cursorAt,
        cursorAt,
        cursorId,
      ];
      const rows = defaultIssueList(filters)
        ? (
            await store.run(
              filters.projectId === undefined
                ? filters.summary
                  ? "queryIssuesWorkspaceDefaultSummary"
                  : "queryIssuesWorkspaceDefault"
                : filters.summary
                  ? "queryIssuesProjectDefaultSummary"
                  : "queryIssuesProjectDefault",
              filters.projectId === undefined
                ? [
                    w(scope),
                    JSON.stringify(visible),
                    cursorAt,
                    cursorAt,
                    cursorAt,
                    cursorId,
                    limit + 1,
                  ]
                : [w(scope), projectId, cursorAt, cursorAt, cursorAt, cursorId, limit + 1],
            )
          ).rows
        : (
            await store.run(
              filters.sort === "due_date"
                ? filters.summary
                  ? "queryIssuesDueDateSummary"
                  : "queryIssuesDueDate"
                : filters.summary
                  ? "queryIssuesSummary"
                  : "queryIssues",
              [
                w(scope),
                JSON.stringify(visible),
                projectId,
                projectId,
                statusIds,
                statusIds,
                category,
                category,
                priorities,
                priorities,
                assigneeMode,
                assigneeMode,
                assigneeMode,
                assigneeId,
                parentId,
                parentId,
                filters.noParent === true ? 1 : 0,
                typeId,
                typeId,
                exclusions,
                exclusions,
                labels,
                filters.labelsMode ?? "all",
                labels,
                labels,
                labels,
                labels,
                completedAfter,
                completedAfter,
                completedBefore,
                completedBefore,
                updatedAfter,
                updatedAfter,
                updatedBefore,
                updatedBefore,
                issueIds,
                issueIds,
                filters.includeArchived === true ? 1 : 0,
                dueBefore,
                dueBefore,
                dueAfter,
                dueAfter,
                filters.overdue === true ? 1 : 0,
                today,
                filters.hasDueDate === undefined ? null : filters.hasDueDate ? 1 : 0,
                filters.hasDueDate === true ? 1 : 0,
                ...(filters.sort === "due_date"
                  ? dueCursor
                  : [cursorAt, cursorAt, cursorAt, cursorId]),
                limit + 1,
              ],
            )
          ).rows;
      const selected = rows.slice(0, limit);
      const keys = new Map<string, string>();
      for (const row of selected) {
        const projectId = string(row, "project_id");
        if (!keys.has(projectId))
          keys.set(projectId, (await projects.getProject(scope, projectId)).key);
      }
      return {
        issues: selected.map((row) => fromRow(row, keys.get(string(row, "project_id")) ?? "")),
        nextCursor:
          rows.length > limit
            ? filters.sort === "due_date"
              ? `d:${selected[selected.length - 1].due_date ?? "~"}:${number(selected[selected.length - 1], "created_at")}:${string(selected[selected.length - 1], "id")}`
              : `${number(selected[selected.length - 1], "created_at")}:${string(selected[selected.length - 1], "id")}`
            : null,
      };
    },
    async countIssues(scope, filters) {
      object(filters);
      const limit = filters.limit ?? 30;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("validation", "Invalid limit");
      const array = (values: readonly string[] | undefined, max = 100): string | null => {
        if (values === undefined) return null;
        if (!Array.isArray(values) || values.length > max)
          fail("validation", "Invalid filter list");
        return JSON.stringify(values.map(id));
      };
      let visible: string[] = [];
      if (filters.projectId !== undefined) {
        visible = [id(filters.projectId)];
        await projects.authorizeProject(scope, visible[0]);
      } else {
        let cursor = "";
        do {
          const page = await projects.listVisibleProjects(scope, cursor, 100);
          visible.push(...page.projects.map((p) => p.id));
          cursor = page.nextCursor ?? "";
        } while (cursor);
      }
      const statusIds = array(filters.statusIds),
        priorities =
          filters.priorities === undefined
            ? null
            : JSON.stringify(filters.priorities.map(priority));
      const exclusions = array(filters.excludeTypeIds),
        labels =
          filters.labels === undefined ? null : JSON.stringify(validateLabels(filters.labels));
      const issueIds = array(filters.issueIds);
      const category = filters.category === undefined ? null : state(filters.category);
      const assigneeMode =
        filters.assigneeId === undefined ? 0 : filters.assigneeId === null ? 1 : 2;
      const assigneeId = typeof filters.assigneeId === "string" ? id(filters.assigneeId) : null;
      const parentId = filters.parentId === undefined ? null : id(filters.parentId);
      const typeId = filters.typeId === undefined ? null : id(filters.typeId);
      const range = (value: number | undefined): number | null => {
        if (value === undefined) return null;
        if (!Number.isSafeInteger(value) || value < 0) fail("validation", "Invalid timestamp");
        return value;
      };
      const completedAfter = range(filters.completedAfter),
        completedBefore = range(filters.completedBefore),
        updatedAfter = range(filters.updatedAfter),
        updatedBefore = range(filters.updatedBefore);
      const dueBefore = filters.dueBefore === undefined ? null : calendarDate(filters.dueBefore);
      const dueAfter = filters.dueAfter === undefined ? null : calendarDate(filters.dueAfter);
      const today = filters.overdue
        ? calendarDate(filters.today ?? new Date(clock.now()).toISOString().slice(0, 10))
        : null;
      const projectId = filters.projectId ?? null;
      if (defaultIssueList(filters)) {
        const rows = (
          await store.run(
            filters.projectId === undefined
              ? "countIssuesWorkspaceDefault"
              : "countIssuesProjectDefault",
            [w(scope), filters.projectId === undefined ? JSON.stringify(visible) : projectId],
          )
        ).rows;
        return number(rows[0], "n");
      }
      const rows = (
        await store.run("countIssues", [
          w(scope),
          JSON.stringify(visible),
          projectId,
          projectId,
          statusIds,
          statusIds,
          category,
          category,
          priorities,
          priorities,
          assigneeMode,
          assigneeMode,
          assigneeMode,
          assigneeId,
          parentId,
          parentId,
          filters.noParent === true ? 1 : 0,
          typeId,
          typeId,
          exclusions,
          exclusions,
          labels,
          filters.labelsMode ?? "all",
          labels,
          labels,
          labels,
          labels,
          completedAfter,
          completedAfter,
          completedBefore,
          completedBefore,
          updatedAfter,
          updatedAfter,
          updatedBefore,
          updatedBefore,
          issueIds,
          issueIds,
          filters.includeArchived === true ? 1 : 0,
          dueBefore,
          dueBefore,
          dueAfter,
          dueAfter,
          filters.overdue === true ? 1 : 0,
          today,
          filters.hasDueDate === undefined ? null : filters.hasDueDate ? 1 : 0,
          filters.hasDueDate === true ? 1 : 0,
        ])
      ).rows;
      return number(rows[0], "n");
    },
    async countIssuesByProject(scope, projectIds) {
      if (!Array.isArray(projectIds) || projectIds.length > 100)
        fail("validation", "Invalid project IDs");
      const checked = projectIds.map(id);
      for (const projectId of checked) await projects.authorizeProject(scope, projectId);
      const rows = (await store.run("countIssuesByProject", [w(scope), JSON.stringify(checked)]))
        .rows;
      return rows.map((row) => ({
        projectId: string(row, "project_id"),
        open: number(row, "open_count"),
        backlog: number(row, "backlog_count"),
      }));
    },
    async getIssuesByIds(scope, ids, includeArchived = false) {
      if (!Array.isArray(ids) || ids.length > 100) fail("validation", "Invalid IDs");
      await access.authorize(scope, "read");
      const checked = ids.map(id);
      const rows = (await store.run("getByIds", [w(scope), JSON.stringify(checked)])).rows;
      const found = new Map<string, Issue>();
      const visible = new Map<
        string,
        Awaited<ReturnType<ProjectsApi["authorizeProject"]>> | null
      >();
      for (const row of rows) {
        const projectId = string(row, "project_id");
        if (!visible.has(projectId)) {
          try {
            visible.set(
              projectId,
              includeArchived
                ? await projects.getProjectIncludingArchived(scope, projectId)
                : await projects.authorizeProject(scope, projectId),
            );
          } catch (error) {
            if (!includeArchived || !(error instanceof PlatformError && error.code === "not_found"))
              throw error;
            visible.set(projectId, null);
          }
        }
        const project = visible.get(projectId);
        if (!project) continue;
        found.set(string(row, "id"), fromRow(row, project.key));
      }
      return checked.flatMap((value) => {
        const item = found.get(value);
        return item ? [item] : [];
      });
    },
    authorizeIssuesByIds,
    async childRollups(scope, parentIds) {
      if (!Array.isArray(parentIds) || parentIds.length > 100)
        fail("validation", "Invalid parent IDs");
      const checked = parentIds.map(id);
      await authorizeIssuesByIds(scope, checked);
      const rows = (await store.run("childCounts", [w(scope), JSON.stringify(checked)])).rows;
      const result: Record<string, ChildRollup> = {};
      for (const parentId of checked)
        result[parentId] = { total: 0, byStatus: {}, done: 0, remaining: 0 };
      for (const row of rows) {
        const parentId = string(row, "parent_id"),
          category = string(row, "state"),
          count = number(row, "n");
        const previous = result[parentId];
        if (!previous) continue;
        const byStatus = { ...previous.byStatus, [category]: count };
        const total = previous.total + count,
          done = (byStatus.done ?? 0) + (byStatus.cancelled ?? 0);
        result[parentId] = { total, byStatus, done, remaining: total - done };
      }
      return result;
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
      const labels =
        input.labels === undefined ? null : JSON.stringify(validateLabels(input.labels));
      if (
        input.labelsMode !== undefined &&
        input.labelsMode !== "all" &&
        input.labelsMode !== "any"
      )
        fail("validation", "Invalid labels mode");
      const labelParams = [labels, input.labelsMode ?? "all", labels, labels, labels, labels];
      return (
        await (terms.some((term) => Array.from(term).length < 3)
          ? store.run("searchShort", [
              ...Array.from({ length: 12 }, (_, index) =>
                terms[index] === undefined ? null : searchPattern(terms[index]),
              ),
              w(scope),
              projectId,
              ...labelParams,
              limit,
            ])
          : store.run("search", [
              searchExpression(terms),
              w(scope),
              projectId,
              w(scope),
              projectId,
              ...labelParams,
              limit,
            ]))
      ).rows.map((row) => fromRow(row, project.key));
    },
    async searchVisibleIssues(scope, input) {
      object(input);
      const text = body(input.text, 256);
      const terms = searchTerms(text);
      if (!terms.length || terms.length > 12) fail("validation", "Expected 1–12 search terms");
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
        fail("validation", "Invalid limit");
      if (
        input.labelsMode !== undefined &&
        input.labelsMode !== "all" &&
        input.labelsMode !== "any"
      )
        fail("validation", "Invalid labels mode");
      let selected: string[] = [];
      if (input.projectIds === undefined) {
        let cursor = "";
        do {
          const page = await projects.listVisibleProjects(scope, cursor, 100);
          selected.push(...page.projects.map((project) => project.id));
          cursor = page.nextCursor ?? "";
        } while (cursor);
      } else {
        if (!Array.isArray(input.projectIds) || input.projectIds.length > 100)
          fail("validation", "Invalid project IDs");
        selected = input.projectIds.map(id);
      }
      const keys = new Map<string, string>();
      for (const projectId of new Set(selected))
        keys.set(projectId, (await projects.authorizeProject(scope, projectId)).key);
      if (!selected.length) return [];
      const labels =
        input.labels === undefined ? null : JSON.stringify(validateLabels(input.labels));
      const labelParams = [labels, input.labelsMode ?? "all", labels, labels, labels, labels];
      const projectJson = JSON.stringify(selected);
      const rows = terms.some((term) => Array.from(term).length < 3)
        ? (
            await store.run("searchVisibleShort", [
              ...Array.from({ length: 12 }, (_, index) =>
                terms[index] === undefined ? null : searchPattern(terms[index]),
              ),
              w(scope),
              projectJson,
              ...labelParams,
              input.limit,
            ])
          ).rows
        : (
            await store.run("searchVisible", [
              searchExpression(terms),
              w(scope),
              projectJson,
              w(scope),
              projectJson,
              ...labelParams,
              input.limit,
            ])
          ).rows;
      return rows.map((row) => fromRow(row, keys.get(string(row, "project_id")) ?? ""));
    },
    async flowIssueRows(scope, projectId, createdUntil, doneBefore) {
      await projects.authorizeProject(scope, id(projectId));
      return (
        await store.run("flowIssueRows", [
          w(scope),
          projectId,
          createdUntil,
          doneBefore,
          doneBefore,
        ])
      ).rows.map((row) => ({
        id: string(row, "id"),
        createdAt: number(row, "created_at"),
        readyAt: row.ready_at === null ? null : number(row, "ready_at"),
        claimedAt: row.claimed_at === null ? null : number(row, "claimed_at"),
        doneAt: row.done_at === null ? null : number(row, "done_at"),
        inReviewAt: row.in_review_at === null ? null : number(row, "in_review_at"),
        reviewBounceCount: number(row, "review_bounce_count"),
        status: string(row, "status"),
        typeKey: row.type_key === null ? null : string(row, "type_key"),
      }));
    },
    async countDoneBefore(scope, projectId, createdUntil, doneBefore) {
      await projects.authorizeProject(scope, id(projectId));
      const row = await one("countDoneBefore", [w(scope), projectId, createdUntil, doneBefore]);
      return row ? number(row, "n") : 0;
    },
    async humanCommentCounts(scope, projectId, issueIds) {
      await projects.authorizeProject(scope, id(projectId));
      const result: Record<string, number> = {};
      for (let start = 0; start < issueIds.length; start += 100) {
        const page = issueIds.slice(start, start + 100).map(id);
        for (const row of (
          await store.run("humanCommentCounts", [w(scope), projectId, JSON.stringify(page)])
        ).rows)
          result[string(row, "issue_id")] = number(row, "n");
      }
      return result;
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
                : row.type === "TaskStatusChanged"
                  ? "TaskStatusChanged"
                  : row.type === "TaskTypeChanged"
                    ? "TaskTypeChanged"
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
