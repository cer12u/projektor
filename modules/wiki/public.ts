import type { ProjectsApi } from "../projects/public";

type Scope = Parameters<ProjectsApi["authorizeProject"]>[0];

export interface WikiPage {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly archived: boolean;
}
export interface WikiResult {
  readonly id: string;
  readonly version: number;
}
export interface WikiPageList {
  readonly pages: readonly WikiPage[];
  readonly nextCursor: string | null;
}
export interface WikiRevision {
  readonly pageId: string;
  readonly version: number;
  readonly action: "create" | "edit" | "archive";
  readonly title: string;
  readonly body: string;
  readonly actorId: string;
  readonly actorKind: "human" | "machine";
  readonly clientId: string | null;
  readonly occurredAt: number;
}
export interface WikiEvent {
  readonly eventId: string;
  readonly source: "wiki";
  readonly projectId: string | null;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: "PageCreated" | "PageChanged" | "PageArchived";
  readonly occurredAt: number;
  readonly payload: {
    readonly actorId: string;
    readonly actorKind: "human" | "machine";
    readonly clientId: string | null;
  };
  readonly cursor: number;
}
declare const readerBrand: unique symbol;
export interface WikiEventReader {
  readonly [readerBrand]: true;
}
export interface WikiApi {
  createPage(
    scope: Scope,
    input: {
      readonly operationId: string;
      readonly pageId: string;
      readonly projectId: string;
      readonly slug: string;
      readonly title: string;
      readonly body: string;
    },
  ): Promise<WikiResult>;
  editPage(
    scope: Scope,
    input: {
      readonly operationId: string;
      readonly pageId: string;
      readonly expectedVersion: number;
      readonly title: string;
      readonly body: string;
    },
  ): Promise<WikiResult>;
  archivePage(
    scope: Scope,
    input: {
      readonly operationId: string;
      readonly pageId: string;
      readonly expectedVersion: number;
    },
  ): Promise<WikiResult>;
  getPage(
    scope: Scope,
    input: { readonly pageId: string } | { readonly projectId: string; readonly slug: string },
  ): Promise<WikiPage>;
  listPages(
    scope: Scope,
    input: { readonly projectId: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<WikiPageList>;
  searchPages(
    scope: Scope,
    input: { readonly projectId: string; readonly text: string; readonly limit?: number },
  ): Promise<readonly WikiPage[]>;
  getRevision(scope: Scope, pageId: string, version: number): Promise<WikiRevision>;
  listRevisions(
    scope: Scope,
    pageId: string,
    cursor?: number,
    limit?: number,
  ): Promise<{ readonly revisions: readonly WikiRevision[]; readonly nextCursor: number | null }>;
  authorizePage(scope: Scope, pageId: string, permission?: "read" | "write"): Promise<WikiPage>;
  readOperation(scope: Scope, operationId: string): Promise<WikiResult | null>;
  readEvents(
    reader: WikiEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly WikiEvent[]>;
}

/** Composition-only maintenance capability. */
export interface WikiMaintenance {
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
