import type { RequestScope } from "../access/public";

export type ExternalTarget = { readonly kind: "issue" | "wiki"; readonly id: string };
export type ExternalKind =
  | "github_issue"
  | "github_pr"
  | "github_commit"
  | "gitlab_issue"
  | "gitlab_mr"
  | "gitlab_commit";
export interface ExternalRef {
  readonly id: string;
  readonly target: ExternalTarget;
  readonly kind: ExternalKind;
  readonly url: string;
  readonly version: number;
}
export interface Feedback {
  readonly id: string;
  readonly sourceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly issueId: string | null;
  readonly version: number;
  readonly receivedAt: number;
}
export interface Delivery {
  readonly id: string;
  readonly sourceId: string;
  readonly eventType: string;
  readonly status: "pending" | "delivered" | "failed";
  readonly attempts: number;
  readonly nextAttemptAt: number;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface IntegrationsApi {
  linkExternalRef(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly refId: string;
      readonly target: ExternalTarget;
      readonly kind: ExternalKind;
      readonly url: string;
    },
  ): Promise<ExternalRef>;
  unlinkExternalRef(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly refId: string;
      readonly expectedVersion: number;
    },
  ): Promise<ExternalRef>;
  listExternalRefs(
    scope: RequestScope,
    target: ExternalTarget,
    cursor?: string,
    limit?: number,
  ): Promise<Page<ExternalRef>>;
  registerSource(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sourceId: string;
      readonly projectId: string;
      readonly name: string;
    },
  ): Promise<{ readonly id: string; readonly secret: string | null }>;
  registerWebhook(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sourceId: string;
      readonly url: string;
      readonly eventTypes: readonly string[];
    },
  ): Promise<{ readonly id: string; readonly secret: string | null }>;
  listSources(
    scope: RequestScope,
    cursor?: string,
    limit?: number,
  ): Promise<
    Page<{
      readonly id: string;
      readonly projectId: string;
      readonly name: string;
      readonly webhookUrl: string | null;
      readonly eventTypes: readonly string[];
    }>
  >;
  receiveFeedback(input: {
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly timestamp: number;
    readonly deliveryId: string;
    readonly signature: string;
    readonly rawBody: string;
  }): Promise<{ readonly id: string }>;
  convertFeedback(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly feedbackId: string;
      readonly expectedVersion: number;
    },
  ): Promise<{ readonly id: string; readonly issueId: string; readonly version: number }>;
  listFeedback(scope: RequestScope, cursor?: string, limit?: number): Promise<Page<Feedback>>;
  deliverWebhook(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly sourceId: string;
      readonly eventType: string;
      readonly externalId: string;
      readonly body: string;
    },
  ): Promise<Delivery>;
  getDeliveryStatus(scope: RequestScope, cursor?: string, limit?: number): Promise<Page<Delivery>>;
}
