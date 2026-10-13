// @module browser-session
// @role public
// Non-UI authority and request port; importing it never imports React presenters.
export type {SessionConsumer,PrincipalReader,AuthorityLease} from './session-contracts';
export {request} from './http-client';
export {sessionRequest} from './session-coordination';
export {createPrincipalReader} from './principal-observation';
export {captureCredentialLease} from './identity-observation';
export {authorityObservation as captureAuthorityLease,onAuthorityChanged,latestIdentity as currentIdentity,AuthorityChanged} from './identity-observation';
export {SubjectChanged} from './subject-changed';
export {prepareLoginChallenge,withLoginChallenge,LoginChallengeCoordinationUnavailable,LoginChallengePreparationError} from './login-challenge';
