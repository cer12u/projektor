import type { RequestScope } from "../access/public";
export interface InsightsMaintenanceScope {
  readonly workspaceId: string;
  readonly projectId?: string;
}
export interface InsightsPurgeStatus {
  readonly state: "frozen" | "purging" | "purged";
  readonly remaining: number;
  readonly pending: number;
}
export interface InsightsMaintenance {
  freezeScope(scope: InsightsMaintenanceScope): Promise<InsightsPurgeStatus>;
  purgeScope(scope: InsightsMaintenanceScope): Promise<InsightsPurgeStatus>;
  purgeStatus(scope: InsightsMaintenanceScope): Promise<InsightsPurgeStatus | null>;
}

export type SourceOwner = "projects" | "issues" | "wiki" | "coordination" | "planning" | "assets";
export interface ProjectionLag {
  readonly source: SourceOwner;
  readonly sequence: number;
  readonly consumedAt: number | null;
}
export interface ActivityItem {
  readonly source: SourceOwner;
  readonly sequence: number;
  readonly type: string;
  readonly entityId: string;
  readonly projectId: string;
  readonly title: string;
  readonly actorId: string;
  readonly clientId: string | null;
  readonly occurredAt: number;
}
export interface ActivityPage {
  readonly items: readonly ActivityItem[];
  readonly nextCursor: string | null;
  readonly lag: readonly ProjectionLag[];
}
export interface ProjectMetrics {
  readonly projectId: string;
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
  readonly completed7Days: readonly {
    principalId: string;
    clientId: string | null;
    count: number;
  }[];
  readonly completed30Days: readonly {
    principalId: string;
    clientId: string | null;
    count: number;
  }[];
  readonly activeLeases: number;
  readonly activeSessions: number;
  readonly lag: readonly ProjectionLag[];
}
export interface FlowDistribution {
  readonly count: number;
  readonly avg: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
}
export interface FlowMetrics {
  readonly leadTime: FlowDistribution;
  readonly leadTimeExcluded: number;
  readonly cycleTime: FlowDistribution;
  readonly wipOverTime: readonly { readonly date: string; readonly count: number }[];
  readonly throughputOverTime: readonly { readonly bucketStart: string; readonly count: number }[];
  readonly bugShareOverTime: readonly {
    readonly bucketStart: string;
    readonly total: number;
    readonly bugCount: number;
    readonly bugSharePercent: number | null;
  }[];
  readonly bugTypeTracked: boolean;
  readonly reviewLatency: FlowDistribution;
  readonly reviewLatencyOverTime: readonly {
    readonly bucketStart: string;
    readonly p50: number | null;
  }[];
  readonly humanInterventions: FlowDistribution;
  readonly autonomyRatio: FlowDistribution;
  readonly cfdOverTime: readonly {
    readonly bucketStart: string;
    readonly backlogTodo: number;
    readonly inProgress: number;
    readonly inReview: number;
    readonly done: number;
  }[];
  readonly timeInProgress: FlowDistribution;
  readonly arrivalVsCompletionOverTime: readonly {
    readonly bucketStart: string;
    readonly created: number;
    readonly completed: number;
    readonly net: number;
  }[];
  readonly flowEfficiency: FlowDistribution;
  readonly agingWip: readonly {
    readonly id: string;
    readonly status: "in_progress" | "in_review";
    readonly ageSeconds: number;
  }[];
  readonly factoryHealth: {
    readonly leaseExpiries: number;
    readonly abandonedClaims: number;
    readonly gateRejections: number;
    readonly wipCapPressure: number;
  };
}
export interface Notification {
  readonly id: string;
  readonly issueId: string;
  readonly kind: "assigned" | "comment" | "lease";
  readonly occurredAt: number;
  readonly version: number;
  readonly read: boolean;
}
export interface NotificationPage {
  readonly items: readonly Notification[];
  readonly nextCursor: string | null;
  readonly unread: number;
  readonly lag: readonly ProjectionLag[];
}
export interface SubscriptionResult {
  readonly id: string;
  readonly version: number;
  readonly active: boolean;
}
export interface ReadResult {
  readonly id: string;
  readonly version: number;
}
export interface InsightsApi {
  getFlowMetrics(
    scope: RequestScope,
    input: {
      readonly projectId: string;
      readonly since?: number;
      readonly until?: number;
      readonly granularity?: "day" | "week";
    },
  ): Promise<FlowMetrics>;
  getSubscription(scope: RequestScope, issueId: string): Promise<SubscriptionResult | null>;
  subscribe(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
    },
  ): Promise<SubscriptionResult>;
  unsubscribe(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly issueId: string;
      readonly expectedVersion: number;
    },
  ): Promise<SubscriptionResult>;
  markRead(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly notificationId: string;
      readonly expectedVersion: number;
    },
  ): Promise<ReadResult>;
  getActivity(
    scope: RequestScope,
    input?: {
      readonly projectId?: string;
      readonly principalId?: string;
      readonly clientId?: string;
      readonly cursor?: string;
      readonly limit?: number;
    },
  ): Promise<ActivityPage>;
  getMetrics(scope: RequestScope, projectId: string): Promise<ProjectMetrics>;
  listNotifications(
    scope: RequestScope,
    cursor?: string,
    limit?: number,
  ): Promise<NotificationPage>;
}
