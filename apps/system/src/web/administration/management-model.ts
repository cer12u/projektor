// @module administration
// @role model
// Compatibility facade: no implementation or state.
export type {ManagedPrincipal,ManagedMembership,ManagedCredential,ManagedScope,ManagementRecord,ManagementContext,ManagementHistory,PrincipalRegistration,ManagementDraft,ManagementSubmission,SetupMetadata,SetupReceipt,SetupSubmission,SavedManagementEdit} from './management-contracts';
export {managementPermissions,managementIdPattern} from './management-validation';
export {managementRecord,managementTarget,sameManagementTarget,historyInitialProjects} from './management-response-validation';
export {canManageProject,canManageRecord} from './management-access';
export {managementQuery,managementChange,registrationInput} from './management-command';
export {draftFrom,restoreSubmission,restoreSetupSubmission,restoreManagementEdit,restoreRegistrationDraft} from './management-edit-state';
