import type { RequestScope } from "../access/public";

export type ProjectRole = "manager" | "editor" | "viewer";
export type ProjectPermission = "read" | "write" | "manage";
export interface Project {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly version: number;
  readonly archived: boolean;
  readonly role: ProjectRole;
}
export interface ProjectResult {
  readonly id: string;
  readonly version: number;
}
export interface ProjectPage {
  readonly projects: readonly Project[];
  readonly nextCursor: string | null;
}
export type ProjectEventType = "ProjectChanged" | "ProjectArchived" | "ProjectGrantChanged";
export interface ProjectEvent {
  readonly eventId: string;
  readonly source: "projects";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: ProjectEventType;
  readonly occurredAt: number;
  readonly payload: { readonly actorId: string };
  readonly cursor: number;
}
declare const readerBrand: unique symbol;
export interface ProjectEventReader {
  readonly [readerBrand]: true;
}
export interface ProjectsApi {
  createProject(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly projectId: string;
      readonly key: string;
      readonly name: string;
    },
  ): Promise<ProjectResult>;
  renameProject(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly projectId: string;
      readonly expectedVersion: number;
      readonly key?: string;
      readonly name: string;
    },
  ): Promise<ProjectResult>;
  grantProjectRole(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly projectId: string;
      readonly expectedVersion: number;
      readonly principalId: string;
      readonly role: ProjectRole;
    },
  ): Promise<ProjectResult>;
  revokeProjectRole(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly projectId: string;
      readonly expectedVersion: number;
      readonly principalId: string;
    },
  ): Promise<ProjectResult>;
  archiveProject(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly projectId: string;
      readonly expectedVersion: number;
    },
  ): Promise<ProjectResult>;
  getProject(scope: RequestScope, projectId: string): Promise<Project>;
  listVisibleProjects(scope: RequestScope, cursor?: string, limit?: number): Promise<ProjectPage>;
  authorizeProject(
    scope: RequestScope,
    projectId: string,
    permission?: ProjectPermission,
  ): Promise<Project>;
  /** Checks a proposed assignee's live membership and project visibility. */
  authorizeProjectPrincipal(
    scope: RequestScope,
    projectId: string,
    principalId: string,
  ): Promise<void>;
  readOperation(scope: RequestScope, operationId: string): Promise<ProjectResult | null>;
  readEvents(
    reader: ProjectEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly ProjectEvent[]>;
}
