/** Handles are valid only in the issuing Access instance; casts/copies cannot mint them. */
declare const principalBrand: unique symbol;
declare const scopeBrand: unique symbol;
declare const operatorBrand: unique symbol;
declare const readerBrand: unique symbol;
export interface AuthenticatedPrincipal {
  readonly [principalBrand]: true;
}
export interface OperatorCapability {
  readonly [operatorBrand]: true;
}
export interface EventReader {
  readonly [readerBrand]: true;
}
export type Role = "owner" | "admin" | "member" | "viewer";
export type Permission = "read" | "write";
export interface PrincipalSummary {
  readonly id: string;
  readonly kind: "human" | "machine";
  readonly issuer: string;
  readonly subject: string;
}
export interface RequestScope {
  readonly [scopeBrand]: true;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly requestId: string;
  /** Admission snapshot only. Call requireMembership again for every operation. */
  readonly role: Role;
  readonly kind: "human" | "machine";
}
export type Authentication =
  | { readonly kind: "human"; readonly assertion: string }
  | { readonly kind: "machine"; readonly bearer: string };
export interface Operation {
  readonly operationId: string;
}
export interface VersionedOperation extends Operation {
  readonly expectedVersion: number;
}
export interface CommandResult {
  readonly id: string;
  readonly version: number;
}
export interface Workspace extends CommandResult {
  readonly name: string;
  readonly role: Role;
}
export interface Membership extends CommandResult {
  readonly role: Role;
  readonly active: boolean;
}
export interface Credential extends CommandResult {
  readonly principalId: string;
  readonly scope: Permission;
  readonly expiresAt: number;
  readonly revoked: boolean;
}
export type EventType =
  | "WorkspaceCreated"
  | "MembershipChanged"
  | "MachineProvisioned"
  | "CredentialIssued"
  | "CredentialRevoked"
  | "WorkspaceArchived";
export interface AccessEvent {
  readonly eventId: string;
  readonly source: "access";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly type: EventType;
  readonly occurredAt: number;
  readonly payload: { readonly actorId: string };
  readonly cursor: number;
}
export interface AccessApi {
  authenticate(input: Authentication): Promise<AuthenticatedPrincipal>;
  requireMembership(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    requestId: string,
    permission?: Permission,
  ): Promise<RequestScope>;
  /** Revalidates provenance, credential, workspace and live membership for downstream modules. */
  authorize(scope: RequestScope, permission?: Permission): Promise<RequestScope>;
  getPrincipalSummary(scope: RequestScope, principalId: string): Promise<PrincipalSummary>;
  listWorkspaces(principal: AuthenticatedPrincipal): Promise<readonly Workspace[]>;
  getMembership(scope: RequestScope, principalId: string): Promise<Membership>;
  getCredential(scope: RequestScope, credentialId: string): Promise<Credential>;
  bootstrap(
    operator: OperatorCapability,
    principal: AuthenticatedPrincipal,
    input: Operation & { readonly workspaceId: string; readonly name: string },
  ): Promise<CommandResult>;
  createWorkspace(
    principal: AuthenticatedPrincipal,
    input: Operation & { readonly workspaceId: string; readonly name: string },
  ): Promise<CommandResult>;
  inviteMember(
    scope: RequestScope,
    input: VersionedOperation & {
      readonly issuer: string;
      readonly subject: string;
      readonly role: Role;
    },
  ): Promise<CommandResult>;
  changeRole(
    scope: RequestScope,
    input: VersionedOperation & { readonly principalId: string; readonly role: Role },
  ): Promise<CommandResult>;
  removeMember(
    scope: RequestScope,
    input: VersionedOperation & { readonly principalId: string },
  ): Promise<CommandResult>;
  provisionMachine(
    scope: RequestScope,
    input: Operation & { readonly principalId: string; readonly role: "member" | "viewer" },
  ): Promise<CommandResult>;
  /** Caller retains a cryptographically random 32-byte lower-case hex secret for retries. Never persisted in receipts. */
  issueCredential(
    scope: RequestScope,
    input: Operation & {
      readonly principalId: string;
      readonly credentialId: string;
      readonly secret: string;
      readonly scope: Permission;
      readonly expiresAt: number;
    },
  ): Promise<CommandResult>;
  revokeCredential(
    scope: RequestScope,
    input: VersionedOperation & { readonly credentialId: string },
  ): Promise<CommandResult>;
  archiveWorkspace(scope: RequestScope, input: VersionedOperation): Promise<CommandResult>;
  readOperation(scope: RequestScope, operationId: string): Promise<CommandResult | null>;
  /** Composition-issued, producer/consumer-bound capability. Never expose through HTTP/MCP. */
  readEvents(
    reader: EventReader,
    workspaceId: string,
    cursor: number,
    limit: number,
  ): Promise<readonly AccessEvent[]>;
}
