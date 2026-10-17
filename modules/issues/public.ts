import type { RequestScope } from "../access/public";

export type IssueState = "todo" | "in_progress" | "done" | "cancelled";
export type IssuePriority = "none" | "low" | "medium" | "high" | "urgent";
export interface Issue {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly state: IssueState;
  readonly status: string;
  readonly statusId: string;
  readonly statusCategory: IssueState;
  readonly typeId: string | null;
  readonly labels: readonly string[];
  readonly parentId: string | null;
  readonly createdById: string;
  readonly createdByKind: "human" | "machine";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly doneAt: number | null;
  readonly readyAt: number | null;
  readonly claimedAt: number | null;
  readonly inReviewAt: number | null;
  readonly reviewBounceCount: number;
  readonly priority: IssuePriority;
  readonly assigneeId: string | null;
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly version: number;
  readonly archived: boolean;
}
export interface FlowIssueRow {
  readonly id: string;
  readonly createdAt: number;
  readonly readyAt: number | null;
  readonly claimedAt: number | null;
  readonly doneAt: number | null;
  readonly inReviewAt: number | null;
  readonly reviewBounceCount: number;
  readonly status: string;
  readonly typeKey: string | null;
}
export interface IssueResult {
  readonly id: string;
  readonly number: number;
  readonly version: number;
}
export interface IssuePage {
  readonly issues: readonly Issue[];
  readonly nextCursor: string | null;
}
export interface TaskStatus {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly category: IssueState;
  readonly color: string | null;
  readonly position: number;
  readonly isDefault: boolean;
  readonly isReviewStep: boolean;
  readonly version: number;
}
export interface TaskType {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly color: string | null;
  readonly icon: string | null;
  readonly position: number;
  readonly isDefault: boolean;
  readonly version: number;
}
export interface IssueComment {
  readonly id: string;
  readonly body: string;
  readonly authorId: string;
  readonly authorKind: "human" | "machine";
  readonly clientId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface IssueLink {
  readonly id: string;
  readonly type:
    | "blocks"
    | "blocked_by"
    | "relates_to"
    | "duplicates"
    | "follows_from"
    | "followed_by";
  readonly direction: "outbound" | "inbound";
  readonly otherIssue: {
    readonly id: string;
    readonly reference: string;
    readonly title: string;
    readonly status: string;
    readonly statusCategory: IssueState;
  };
}
export interface ChildRollup {
  readonly total: number;
  readonly byStatus: { readonly [status: string]: number };
  readonly done: number;
  readonly remaining: number;
}
export interface IssueFilters {
  /** Omits description from the storage projection for list responses without body. */
  readonly summary?: boolean;
  readonly projectId?: string;
  readonly statusIds?: readonly string[];
  readonly category?: IssueState;
  readonly priorities?: readonly IssuePriority[];
  readonly assigneeId?: string | null;
  readonly parentId?: string;
  readonly noParent?: boolean;
  readonly typeId?: string;
  readonly excludeTypeIds?: readonly string[];
  readonly labels?: readonly string[];
  readonly labelsMode?: "all" | "any";
  readonly completedAfter?: number;
  readonly completedBefore?: number;
  readonly updatedAfter?: number;
  readonly updatedBefore?: number;
  readonly dueBefore?: string;
  readonly dueAfter?: string;
  readonly overdue?: boolean;
  readonly today?: string;
  readonly hasDueDate?: boolean;
  readonly sort?: "due_date";
  readonly issueIds?: readonly string[];
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface IssueHistory {
  readonly version: number;
  readonly action: string;
  readonly actorId: string;
  readonly actorKind: "human" | "machine";
  readonly clientId: string | null;
  readonly occurredAt: number;
  readonly detail: string;
}
export interface IssueEvent {
  readonly eventId: string;
  readonly source: "issues";
  readonly projectId: string | null;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type:
    | "IssueCreated"
    | "IssueChanged"
    | "IssueArchived"
    | "TaskStatusChanged"
    | "TaskTypeChanged";
  readonly occurredAt: number;
  readonly payload: {
    readonly actorId: string;
    readonly actorKind: "human" | "machine";
    readonly clientId: string | null;
  };
  readonly cursor: number;
}
declare const readerBrand: unique symbol;
export interface IssueEventReader {
  readonly [readerBrand]: true;
}
export interface IssuesApi {
  createIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly projectId: string;
      readonly title: string;
      readonly description: string;
      readonly priority: IssuePriority;
      readonly statusId?: string;
      readonly typeId?: string | null;
      readonly labels?: readonly string[];
      readonly parentId?: string | null;
      readonly assigneeId?: string | null;
      readonly estimate?: number | null;
      readonly dueDate?: string | null;
    },
  ): Promise<IssueResult>;
  editIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly title: string;
      readonly description: string;
      readonly priority: IssuePriority;
      readonly estimate?: number | null;
      readonly dueDate?: string | null;
    },
  ): Promise<IssueResult>;
  updateIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly title?: string;
      readonly description?: string;
      readonly priority?: IssuePriority;
      readonly statusId?: string;
      readonly typeId?: string | null;
      readonly labels?: readonly string[];
      readonly parentId?: string | null;
      readonly assigneeId?: string | null;
      readonly estimate?: number | null;
      readonly dueDate?: string | null;
    },
  ): Promise<IssueResult>;
  transitionIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly state: IssueState;
    },
  ): Promise<IssueResult>;
  assignIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly assigneeId: string | null;
    },
  ): Promise<IssueResult>;
  addComment(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly commentId: string;
      readonly body: string;
    },
  ): Promise<IssueResult>;
  archiveIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
    },
  ): Promise<IssueResult>;
  getIssue(
    scope: RequestScope,
    input:
      | { readonly issueId: string }
      | { readonly projectId: string; readonly number: number }
      | { readonly reference: string; readonly projectId: string },
  ): Promise<Issue>;
  /** Authorized historical read for planning; archived issues remain read-only. */
  getIssueIncludingArchived(scope: RequestScope, issueId: string): Promise<Issue>;
  listIssues(
    scope: RequestScope,
    input: {
      readonly projectId: string;
      readonly state?: IssueState;
      readonly assigneeId?: string | null;
      readonly priority?: IssuePriority;
      readonly cursor?: string;
      readonly limit?: number;
    },
  ): Promise<IssuePage>;
  queryIssues(scope: RequestScope, filters: IssueFilters): Promise<IssuePage>;
  countIssues(scope: RequestScope, filters: IssueFilters): Promise<number>;
  countIssuesByProject(
    scope: RequestScope,
    projectIds: readonly string[],
  ): Promise<readonly { projectId: string; open: number; backlog: number }[]>;
  getIssuesByIds(
    scope: RequestScope,
    ids: readonly string[],
    includeArchived?: boolean,
  ): Promise<readonly Issue[]>;
  authorizeIssuesByIds(
    scope: RequestScope,
    ids: readonly string[],
    includeArchived?: boolean,
  ): Promise<void>;
  childRollups(
    scope: RequestScope,
    parentIds: readonly string[],
  ): Promise<{ readonly [parentId: string]: ChildRollup }>;
  listTaskStatuses(scope: RequestScope): Promise<readonly TaskStatus[]>;
  listTaskTypes(scope: RequestScope): Promise<readonly TaskType[]>;
  createTaskStatus(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly id: string;
      readonly key: string;
      readonly name: string;
      readonly category: IssueState;
      readonly color?: string | null;
      readonly position?: number;
      readonly isDefault?: boolean;
      readonly isReviewStep?: boolean;
    },
  ): Promise<TaskStatus>;
  updateTaskStatus(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly category?: IssueState;
      readonly color?: string | null;
      readonly position?: number;
      readonly isDefault?: boolean;
      readonly isReviewStep?: boolean;
    },
  ): Promise<TaskStatus>;
  deleteTaskStatus(
    scope: RequestScope,
    input: { readonly operationId: string; readonly id: string; readonly expectedVersion: number },
  ): Promise<{ readonly id: string; readonly version: number }>;
  createTaskType(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly id: string;
      readonly key: string;
      readonly name: string;
      readonly color?: string | null;
      readonly icon?: string | null;
      readonly position?: number;
      readonly isDefault?: boolean;
    },
  ): Promise<TaskType>;
  updateTaskType(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly id: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly color?: string | null;
      readonly icon?: string | null;
      readonly position?: number;
      readonly isDefault?: boolean;
    },
  ): Promise<TaskType>;
  deleteTaskType(
    scope: RequestScope,
    input: { readonly operationId: string; readonly id: string; readonly expectedVersion: number },
  ): Promise<{ readonly id: string; readonly version: number }>;
  listComments(scope: RequestScope, issueId: string): Promise<readonly IssueComment[]>;
  editComment(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly commentId: string;
      readonly body: string;
    },
  ): Promise<IssueResult>;
  deleteComment(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
      readonly commentId: string;
    },
  ): Promise<IssueResult>;
  createIssueLink(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly linkId: string;
      readonly sourceIssueId: string;
      readonly targetIssueId: string;
      readonly type: IssueLink["type"];
      readonly expectedVersion: number;
    },
  ): Promise<IssueResult>;
  deleteIssueLink(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly linkId: string;
      readonly sourceIssueId: string;
      readonly expectedVersion: number;
    },
  ): Promise<IssueResult>;
  listIssueLinks(scope: RequestScope, issueId: string): Promise<readonly IssueLink[]>;
  searchIssues(
    scope: RequestScope,
    input: {
      readonly projectId: string;
      readonly text: string;
      readonly limit?: number;
      readonly labels?: readonly string[];
      readonly labelsMode?: "all" | "any";
    },
  ): Promise<readonly Issue[]>;
  searchVisibleIssues(
    scope: RequestScope,
    input: {
      readonly text: string;
      readonly projectIds?: readonly string[];
      readonly limit: number;
      readonly labels?: readonly string[];
      readonly labelsMode?: "all" | "any";
    },
  ): Promise<readonly Issue[]>;
  flowIssueRows(
    scope: RequestScope,
    projectId: string,
    createdUntil: number,
    doneBefore: number | null,
  ): Promise<readonly FlowIssueRow[]>;
  countDoneBefore(
    scope: RequestScope,
    projectId: string,
    createdUntil: number,
    doneBefore: number,
  ): Promise<number>;
  humanCommentCounts(
    scope: RequestScope,
    projectId: string,
    issueIds: readonly string[],
  ): Promise<{ readonly [issueId: string]: number }>;
  getHistory(scope: RequestScope, issueId: string): Promise<readonly IssueHistory[]>;
  authorizeIssue(
    scope: RequestScope,
    issueId: string,
    permission?: "read" | "write",
  ): Promise<Issue>;
  readOperation(scope: RequestScope, operationId: string): Promise<IssueResult | null>;
  readEvents(
    reader: IssueEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly IssueEvent[]>;
}

/** Composition-only maintenance capability. */
export interface IssuesMaintenance {
  freezeScope(scope: { readonly workspaceId: string; readonly projectId?: string }): Promise<{
    readonly state: "frozen" | "purging" | "purged";
    readonly remaining: number;
    readonly pending: number;
  }>;
  purgeScope(scope: { readonly workspaceId: string; readonly projectId?: string }): Promise<{
    readonly state: "frozen" | "purging" | "purged";
    readonly remaining: number;
    readonly pending: number;
  } | null>;
  purgeStatus(scope: { readonly workspaceId: string; readonly projectId?: string }): Promise<{
    readonly state: "frozen" | "purging" | "purged";
    readonly remaining: number;
    readonly pending: number;
  } | null>;
}
