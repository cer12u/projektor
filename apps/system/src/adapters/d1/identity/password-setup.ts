// @module identity
// @role private-facade
/** Public password-setup capability API; implementations are authority-specific. */
export { prepareBootstrapSetup } from './password-setup-bootstrap';
export { commitPasswordSetup,setupCompletionResultByHash,setupRightContext } from './password-setup-completion';
export { executeSetupManagement,prepareSetupManagement,setupManagementPolicies,setupManagementResult,setupManagementState } from './password-setup-management';
export * from './password-setup-model';
