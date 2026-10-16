import { PlatformError } from "../../platform/public";

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
  readonly clientId?: string;
}
export type Authentication =
  | { readonly kind: "human"; readonly assertion: string }
  | { readonly kind: "machine"; readonly bearer: string }
  | { readonly kind: "oauth"; readonly bearer: string; readonly resource: string };
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
export interface AccessPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export interface CurrentPrincipal {
  readonly id: string;
  readonly kind: "human" | "machine" | "oauth";
  readonly displayName: string;
  readonly email: string | null;
  readonly clientName?: string;
}
export interface MemberItem {
  readonly principalId: string;
  readonly kind: "human" | "machine";
  readonly displayName: string;
  readonly email: string | null;
  readonly role: Role;
  readonly version: number;
}
export interface OAuthClientItem {
  readonly clientId: string;
  readonly name: string;
  readonly version: number;
  readonly revoked: boolean;
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
export interface CredentialItem extends Credential {
  readonly name: string;
  readonly createdAt: number;
}
export type EventType =
  | "WorkspaceCreated"
  | "MembershipChanged"
  | "MachineProvisioned"
  | "CredentialIssued"
  | "CredentialRevoked"
  | "WorkspaceArchived"
  | "OAuthConsentGranted"
  | "OAuthClientRevoked"
  | "OAuthTokenIssued"
  | "OAuthTokenRotated"
  | "OAuthFamilyRevoked";
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
export interface AccessApi extends OAuthApi {
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
  me(
    principal: AuthenticatedPrincipal,
    cursor?: string,
    limit?: number,
  ): Promise<{
    readonly principal: CurrentPrincipal;
    readonly workspaces: readonly Workspace[];
    readonly nextCursor: string | null;
  }>;
  meForScope(
    scope: RequestScope,
    cursor?: string,
    limit?: number,
  ): Promise<{
    readonly principal: CurrentPrincipal;
    readonly workspaces: readonly Workspace[];
    readonly nextCursor: string | null;
  }>;
  listMembers(
    scope: RequestScope,
    cursor?: string,
    limit?: number,
  ): Promise<AccessPage<MemberItem>>;
  getMembership(scope: RequestScope, principalId: string): Promise<Membership>;
  getCredential(scope: RequestScope, credentialId: string): Promise<Credential>;
  listCredentials(
    scope: RequestScope,
    cursor?: string,
    limit?: number,
  ): Promise<AccessPage<CredentialItem>>;
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
      readonly name?: string;
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

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_client_metadata"
  | "invalid_redirect_uri"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_target"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "access_denied"
  | "temporarily_unavailable";
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly authorizationRedirect?: {
      readonly redirect_uri: string;
      readonly iss: string;
      readonly state?: string;
    },
  ) {
    super(code);
    this.name = "OAuthError";
  }
}
export interface OAuthClientInput {
  readonly client_name?: string;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method?: string;
  readonly grant_types?: readonly string[];
  readonly response_types?: readonly string[];
  readonly scope?: string;
}
export interface OAuthClient extends OAuthClientInput {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: readonly string[];
  readonly response_types: readonly "code"[];
  readonly scope: string;
}
export interface OAuthAuthorizationRequest {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly response_type: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly resource: string;
  readonly scope?: string;
  readonly state?: string;
}
declare const consentBrand: unique symbol;
/** Request-local handle. Gateway must integrity-bind the displayed request across GET/POST. */
export interface OAuthConsent {
  readonly [consentBrand]: true;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly requestedScope: string;
  /** Scope this human can grant in the selected workspace. */
  readonly scope: string;
}
export interface OAuthAuthorizationResponse {
  readonly redirect_uri: string;
  readonly code: string;
  readonly state?: string;
  readonly iss: string;
}
export type OAuthTokenRequest = {
  readonly client_id: string;
  readonly resource: string;
} & (
  | {
      readonly grant_type: "authorization_code";
      readonly code: string;
      readonly redirect_uri: string;
      readonly code_verifier: string;
    }
  | {
      readonly grant_type: "refresh_token";
      readonly refresh_token: string;
      readonly scope?: string;
    }
);
export interface OAuthTokens {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope: string;
}
export interface OAuthServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly "code"[];
  readonly response_modes_supported: readonly "query"[];
  readonly grant_types_supported: readonly ("authorization_code" | "refresh_token")[];
  readonly token_endpoint_auth_methods_supported: readonly "none"[];
  readonly revocation_endpoint_auth_methods_supported: readonly "none"[];
  readonly code_challenge_methods_supported: readonly "S256"[];
  readonly scopes_supported: readonly ("read" | "write")[];
  readonly authorization_response_iss_parameter_supported: true;
}
export interface OAuthResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly ("read" | "write")[];
  readonly bearer_methods_supported: readonly "header"[];
}
export class OAuthInsufficientScope extends PlatformError {
  constructor() {
    super("forbidden", "Insufficient OAuth scope");
  }
}
export interface OAuthApi {
  issueOAuthForm(scope: RequestScope, tokenHash: string): Promise<void>;
  consumeOAuthForm(scope: RequestScope, tokenHash: string): Promise<void>;
  getAuthorizationServerMetadata(): OAuthServerMetadata;
  getProtectedResourceMetadata(): OAuthResourceMetadata;
  registerOAuthClient(input: OAuthClientInput): Promise<OAuthClient>;
  getOAuthConsent(
    principal: AuthenticatedPrincipal,
    input: OAuthAuthorizationRequest,
    workspaceScope: RequestScope,
  ): Promise<OAuthConsent>;
  /** Interactive, explicit workspace selection and consent only. Caller retains random secret for retry. */
  approveOAuthConsent(
    scope: RequestScope,
    consent: OAuthConsent,
    input: Operation & { readonly codeSecret: string },
  ): Promise<OAuthAuthorizationResponse>;
  exchangeOAuthToken(input: OAuthTokenRequest): Promise<OAuthTokens>;
  revokeOAuthToken(input: {
    readonly client_id: string;
    readonly token: string;
    readonly token_type_hint?: string;
  }): Promise<void>;
  getOAuthClient(
    scope: RequestScope,
    clientId: string,
  ): Promise<CommandResult & { readonly revoked: boolean }>;
  listOAuthClients(
    scope: RequestScope,
    cursor?: string,
    limit?: number,
  ): Promise<AccessPage<OAuthClientItem>>;
  revokeOAuthClient(
    scope: RequestScope,
    input: VersionedOperation & { readonly clientId: string },
  ): Promise<CommandResult>;
}

/** Composition-only maintenance capability. */
export interface AccessMaintenance {
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
