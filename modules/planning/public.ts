import type { RequestScope } from "../access/public";
import type { Issue } from "../issues/public";

export interface Sprint {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly version: number;
  readonly closed: boolean;
  readonly archived: boolean;
}
export interface SprintItem {
  readonly issueId: string;
  readonly issue: Issue | null;
  readonly archived: boolean;
}
export interface PlanningResult {
  readonly id: string;
  readonly version: number;
}
export interface PlanningEvent {
  readonly eventId: string;
  readonly source: "planning";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: "SprintChanged" | "IssueScheduled";
  readonly issueId: string | null;
  readonly actorId: string;
  readonly occurredAt: number;
  readonly cursor: number;
}
declare const readerBrand: unique symbol;
export interface PlanningEventReader {
  readonly [readerBrand]: true;
}
export interface PlanningApi {
  createSprint(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sprintId: string;
      readonly projectId: string;
      readonly name: string;
    },
  ): Promise<PlanningResult>;
  scheduleIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sprintId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
    },
  ): Promise<PlanningResult>;
  unscheduleIssue(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sprintId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
    },
  ): Promise<PlanningResult>;
  closeSprint(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sprintId: string;
      readonly expectedVersion: number;
    },
  ): Promise<PlanningResult>;
  listSprints(scope: RequestScope, projectId: string): Promise<readonly Sprint[]>;
  getSprintItems(
    scope: RequestScope,
    sprintId: string,
  ): Promise<{ readonly sprint: Sprint; readonly items: readonly SprintItem[] }>;
  readOperation(scope: RequestScope, operationId: string): Promise<PlanningResult | null>;
  readEvents(
    reader: PlanningEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly PlanningEvent[]>;
}
