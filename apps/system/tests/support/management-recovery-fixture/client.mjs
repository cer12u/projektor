// @module verification
// @role fixture-management
export class ManagementClient {constructor(owner){return globalThis.testApi(owner);}}
export class SetupNotApplied extends Error {constructor(original){super('setup_not_applied');this.original=original;}}
