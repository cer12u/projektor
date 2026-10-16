import type { ByteReader } from "../../platform/public";
import type { RequestScope } from "../access/public";

export type AssetTarget = { readonly kind: "issue" | "wiki"; readonly id: string };
export interface AssetMetadata {
  readonly id: string;
  readonly projectId: string;
  readonly size: number;
  readonly contentType: string;
  readonly filename: string;
  readonly sha256: string;
  readonly version: number;
  readonly ready: boolean;
  readonly kind: "file" | "link";
  readonly url: string | null;
  readonly title: string | null;
  readonly createdAt: number;
}
export interface AssetLink {
  readonly id: string;
  readonly filename: string;
  readonly assetId: string;
  readonly target: AssetTarget;
  readonly kind: "file" | "link";
  readonly url: string | null;
  readonly title: string | null;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: number;
}
export interface AssetResult {
  readonly id: string;
  readonly version: number;
}
export interface AssetEvent {
  readonly projectId?: string | null;
  readonly eventId: string;
  readonly source: "assets";
  readonly schemaVersion: 1 | 2;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: "AssetBegun" | "AssetCompleted" | "AssetLinked" | "AssetUnlinked";
  readonly occurredAt: number;
  readonly payload: { readonly actorId: string; readonly clientId: string | null };
  readonly cursor: number;
}
declare const readerBrand: unique symbol;
export interface AssetEventReader {
  readonly [readerBrand]: true;
}
export interface AssetsApi {
  beginUpload(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly assetId: string;
      readonly projectId: string;
      readonly size: number;
      readonly contentType: string;
      readonly filename: string;
      readonly sha256: string;
    },
  ): Promise<AssetResult>;
  putUpload(scope: RequestScope, assetId: string, body: ArrayBuffer): Promise<void>;
  completeUpload(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly assetId: string;
      readonly expectedVersion: number;
    },
  ): Promise<AssetResult>;
  linkAsset(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly assetId: string;
      readonly expectedVersion: number;
      readonly linkId: string;
      readonly target: AssetTarget;
    },
  ): Promise<AssetResult>;
  createLinkAsset(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly assetId: string;
      readonly url: string;
      readonly title?: string | null;
      readonly target: AssetTarget;
    },
  ): Promise<AssetResult>;
  unlinkAsset(
    scope: RequestScope,
    input: {
      readonly operationId: string;
      readonly assetId: string;
      readonly expectedVersion: number;
      readonly linkId: string;
    },
  ): Promise<AssetResult>;
  getMetadata(scope: RequestScope, assetId: string): Promise<AssetMetadata>;
  getLink(scope: RequestScope, linkId: string): Promise<AssetLink>;
  listAssets(
    scope: RequestScope,
    target: AssetTarget,
    cursor?: string,
    limit?: number,
  ): Promise<{ readonly items: readonly AssetLink[]; readonly nextCursor: string | null }>;
  downloadAsset(
    scope: RequestScope,
    assetId: string,
  ): Promise<{ readonly metadata: AssetMetadata; readonly body: ByteReader | null }>;
  readOperation(scope: RequestScope, operationId: string): Promise<AssetResult | null>;
  readEvents(
    reader: AssetEventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly AssetEvent[]>;
  drainGc(limit?: number): Promise<number>;
}

/** Issued only to Worker composition, never part of AssetsApi. */
export interface AssetsMaintenance {
  freezeScope(scope: {
    readonly workspaceId: string;
    readonly projectId?: string;
  }): Promise<AssetsPurgeStatus>;
  purgeScope(scope: {
    readonly workspaceId: string;
    readonly projectId?: string;
  }): Promise<AssetsPurgeStatus>;
  purgeStatus(scope: {
    readonly workspaceId: string;
    readonly projectId?: string;
  }): Promise<AssetsPurgeStatus | null>;
}
export interface AssetsPurgeStatus {
  readonly sweepingUntil?: number;
  readonly state: "frozen" | "purging" | "purged";
  readonly remaining: number;
  readonly pending: number;
}
