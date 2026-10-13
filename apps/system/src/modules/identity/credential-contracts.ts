// @module identity
// @role public-contract
/** Credential record DTO only; no credential loading, creation, storage or provider implementation. */
export type CredentialEnvironment='production'|'synthetic-local';
export interface CredentialEnvelope{version:1;environment:CredentialEnvironment;origin:string;principalId:string;credentialId:string;token:string}
