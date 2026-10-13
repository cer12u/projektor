// @module administration
// @role model
/** Proven no new application of this attempted command; never inferred from a later identity failure. */
export class SetupNotApplied extends Error {constructor(readonly original:unknown){super('setup_not_applied');}}
