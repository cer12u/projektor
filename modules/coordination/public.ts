import type { RequestScope } from "../access/public";

export interface Session {
  readonly id: string;
  readonly agentLabel: string;
  readonly clientKind: string;
  readonly repo: string | null;
  readonly principalId: string;
  readonly expiresAt: number;
  readonly live: boolean;
}
export interface Lease {
  readonly issueId: string;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly fencingToken: number;
  readonly expiresAt: number;
  readonly releaseReason: string | null;
}
export interface ProjectLease extends Lease {
  readonly holderPrincipalId: string;
  readonly agentLabel: string;
  readonly clientKind: string;
}
export interface FileClaim {
  readonly repo: string;
  readonly path: string;
  readonly sessionId: string;
  readonly leaseIssueId: string | null;
  readonly expiresAt: number;
}
export interface Progress {
  readonly issueId: string;
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly text: string;
  readonly status: string;
  readonly reportedAt: number;
}
export interface ProgressEntry extends Progress {
  readonly sequence: number;
}
export interface ProgressPage {
  readonly items: readonly ProgressEntry[];
  readonly nextCursor: number | null;
}
export interface ProjectPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface ProjectProgress extends Progress {
  readonly projectId: string;
}
export interface WipCap {
  readonly projectId: string;
  readonly cap: number;
  readonly version: number;
}
export interface CoordinationEvent {
  readonly eventId: string;
  readonly source: "coordination";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly type: "LeaseChanged" | "ProgressReported" | "FileClaimForced";
  readonly subjectId: string;
  readonly actorId: string;
  readonly otherSessionId: string | null;
  readonly occurredAt: number;
  readonly cursor: number;
}
declare const readerBrand: unique symbol;
export interface CoordinationEventReader {
  readonly [readerBrand]: true;
}
export interface CoordinationApi {
  startSession(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly agentLabel: string;
      readonly clientKind: string;
      readonly repo?: string;
      readonly ttlSeconds?: number;
    },
  ): Promise<Session>;
  heartbeat(
    scope: RequestScope,
    input: { readonly operationId: string; readonly sessionId: string },
  ): Promise<Session>;
  endSession(
    scope: RequestScope,
    input: { readonly operationId: string; readonly sessionId: string },
  ): Promise<Session>;
  acquireLease(
    scope: RequestScope,
    input: { readonly operationId: string; readonly sessionId: string; readonly issueId: string },
  ): Promise<Lease>;
  renewLease(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly issueId: string;
      readonly fencingToken: number;
    },
  ): Promise<Lease>;
  releaseLease(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly issueId: string;
      readonly fencingToken: number;
    },
  ): Promise<Lease>;
  setProjectLimit(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly projectId: string;
      readonly cap: number;
      readonly expectedVersion: number;
    },
  ): Promise<{ readonly projectId: string; readonly cap: number; readonly version: number }>;
  getProjectLimit(scope: RequestScope, projectId: string): Promise<WipCap>;
  projectSessions(
    scope: RequestScope,
    projectId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ProjectPage<Session>>;
  projectLeases(
    scope: RequestScope,
    projectId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ProjectPage<ProjectLease>>;
  projectProgress(
    scope: RequestScope,
    projectId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ProjectPage<ProjectProgress>>;
  projectClaims(
    scope: RequestScope,
    projectId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ProjectPage<FileClaim>>;
  claimFiles(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly repo: string;
      readonly paths: readonly string[];
      readonly leaseIssueId?: string;
      readonly fencingToken?: number;
      readonly force?: boolean;
    },
  ): Promise<readonly FileClaim[]>;
  releaseFiles(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly repo: string;
      readonly paths: readonly string[];
    },
  ): Promise<readonly string[]>;
  reportProgress(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sessionId: string;
      readonly issueId: string;
      readonly fencingToken: number;
      readonly text: string;
      readonly status: string;
    },
  ): Promise<Progress>;
  getLease(scope: RequestScope, issueId: string): Promise<Lease | null>;
  listLeases(scope: RequestScope, projectId: string): Promise<readonly Lease[]>;
  listClaims(scope: RequestScope, repo: string, sessionId: string): Promise<readonly FileClaim[]>;
  getProgress(scope: RequestScope, issueId: string): Promise<Progress | null>;
  listProgress(
    scope: RequestScope,
    issueId: string,
    input?: { readonly cursor?: number; readonly limit?: number },
  ): Promise<ProgressPage>;
  listSessions(scope: RequestScope): Promise<readonly Session[]>;
  readOperation(scope: RequestScope, operationId: string): Promise<unknown | null>;
  readAgentEvents(
    scope: RequestScope,
    cursor: number,
    limit: number,
  ): Promise<readonly CoordinationEvent[]>;
  readEvents(
    reader: CoordinationEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly CoordinationEvent[]>;
}
