// @module identity
// @role private-storage-api
/** Stable authentication-storage export surface; no transport or policy implementation. */
export { AUTH_STATE_LIMITS,challengeValid,countAttempts,reserveLoginContext } from './auth-challenges';
export * from './auth-types';
export { apiCredential,createSession,passwordRow,session } from './credential-store';
export { grants } from './identity-grants';
export { ABSOLUTE_SECONDS,IDLE_SECONDS } from "../../../modules/identity/session-policy";
