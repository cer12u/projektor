import type { RequestScope } from "../access/public";

export type IssueState = "todo" | "in_progress" | "done" | "cancelled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";
export interface Issue {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly state: IssueState;
  readonly priority: IssuePriority;
  readonly assigneeId: string | null;
  readonly version: number;
  readonly archived: boolean;
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
export interface IssueHistory {
  readonly version: number;
  readonly action: string;
  readonly actorId: string;
  readonly actorKind: "human" | "machine";
  readonly occurredAt: number;
  readonly detail: string;
}
export interface IssueEvent {
  readonly eventId: string;
  readonly source: "issues";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: "IssueCreated" | "IssueChanged" | "IssueArchived";
  readonly occurredAt: number;
  readonly payload: { readonly actorId: string; readonly actorKind: "human" | "machine" };
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
  searchIssues(
    scope: RequestScope,
    input: { readonly projectId: string; readonly text: string; readonly limit?: number },
  ): Promise<readonly Issue[]>;
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
