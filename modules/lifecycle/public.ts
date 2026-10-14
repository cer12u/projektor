import type { AuthenticatedPrincipal } from "../access/public";

export interface LifecycleScope {
  readonly principal: AuthenticatedPrincipal;
  readonly workspaceId: string;
  readonly requestId: string;
}
export interface PurgeStep {
  readonly owner: string;
  readonly state: "pending" | "frozen" | "purging" | "purged";
  readonly remaining: number;
  readonly pending: number;
  readonly error: string | null;
}
export interface PurgeJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly version: number;
  readonly state: "freezing" | "purging" | "complete";
  readonly steps: readonly PurgeStep[];
}
export interface LifecycleApi {
  requestPurge(
    scope: LifecycleScope,
    input: {
      readonly operationId: string;
      readonly expectedVersion: number;
      readonly projectId?: string;
      readonly confirmation: string;
    },
  ): Promise<PurgeJob>;
  resumePurge(
    scope: LifecycleScope,
    input: {
      readonly operationId: string;
      readonly expectedVersion: number;
      readonly jobId: string;
    },
  ): Promise<PurgeJob>;
  getPurgeStatus(
    scope: LifecycleScope,
    input: { readonly projectId?: string },
  ): Promise<PurgeJob | null>;
}
export interface LifecycleEvent {
  readonly eventId: string;
  readonly source: "lifecycle";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: "PurgeRequested" | "PurgeResumed" | "PurgeAdvanced" | "PurgeCompleted";
  readonly occurredAt: number;
}
