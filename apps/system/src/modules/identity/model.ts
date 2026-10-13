// @module identity
// @role domain-model
export interface SubjectRow { id: string; kind: 'human' | 'agent'; display_name: string; auth_version: number }
export interface PasswordRow extends SubjectRow { encoded_hash: string; active: number }
export interface LegacyAuthenticated extends SubjectRow {
  authentication: 'session' | 'api'; token_hash: string; credential_id: string | null; csrf_token: string | null;
}
export interface FederatedAuthenticated extends SubjectRow {
  authentication: 'federated'; token_hash: null; credential_id: null; csrf_token: null;
  binding_id: string; federated_credential_id: string; credential_revision: number;
  issuer: string; audience: string; subject: string; assertion_expires_at: number; assertion_not_before: number;
}
export type Authenticated = LegacyAuthenticated | FederatedAuthenticated;
