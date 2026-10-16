import type { RequestScope } from "../access/public";
import type { Issue } from "../issues/public";

export interface Sprint {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly version: number;
  readonly closed: boolean;
  readonly goal: string | null;
  readonly status: "planned" | "active" | "completed";
  readonly startDate: number | null;
  readonly endDate: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}
export interface SprintItem {
  readonly issueId: string;
  readonly issue: Issue | null;
  readonly archived: boolean;
}
export interface SprintAssignments {
  readonly [issueId: string]: string | null;
}
export interface PlanningResult {
  readonly id: string;
  readonly version: number;
}
export interface PlanningEvent {
  readonly eventId: string;
  readonly source: "planning";
  readonly schemaVersion: 1 | 2;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: "SprintChanged" | "IssueScheduled";
  readonly issueId: string | null;
  readonly actorId: string;
  readonly payload: { readonly actorId: string; readonly clientId: string | null };
  readonly occurredAt: number;
  readonly cursor: number;
}
export interface PlanningMaintenanceScope {
  readonly workspaceId: string;
  readonly projectId?: string;
}
export interface PlanningPurgeStatus {
  readonly state: "frozen" | "purging" | "purged";
  readonly remaining: number;
  readonly pending: number;
}
export interface PlanningMaintenance {
  freezeScope(scope: PlanningMaintenanceScope): Promise<PlanningPurgeStatus>;
  purgeScope(scope: PlanningMaintenanceScope): Promise<PlanningPurgeStatus>;
  purgeStatus(scope: PlanningMaintenanceScope): Promise<PlanningPurgeStatus | null>;
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
      readonly goal?: string | null;
      readonly startDate?: number | null;
      readonly endDate?: number | null;
    },
  ): Promise<PlanningResult>;
  updateSprint(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sprintId: string;
      readonly expectedVersion: number;
      readonly name?: string;
      readonly goal?: string | null;
      readonly status?: "planned" | "active" | "completed";
      readonly startDate?: number | null;
      readonly endDate?: number | null;
    },
  ): Promise<PlanningResult>;
  getSprint(scope: RequestScope, sprintId: string): Promise<Sprint>;
  sprintsForIssues(scope: RequestScope, issueIds: readonly string[]): Promise<SprintAssignments>;
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
    page?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{
    readonly sprint: Sprint;
    readonly items: readonly SprintItem[];
    readonly nextCursor: string | null;
  }>;
  readOperation(scope: RequestScope, operationId: string): Promise<PlanningResult | null>;
  readEvents(
    reader: PlanningEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly PlanningEvent[]>;
}
