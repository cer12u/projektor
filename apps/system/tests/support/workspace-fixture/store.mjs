// @module verification
// @role fixture-workspace
export class EditStore {async load(){return undefined;}async put(){}async list(){return globalThis.testDrafts??[];}}
export const unsavedRecord=r=>r.status!=='clean';export const draftReferences=r=>r.references??r.base?.references??[];
