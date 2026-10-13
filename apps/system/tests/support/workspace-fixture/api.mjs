// @module verification
// @role fixture-workspace
export class IssueApi {constructor(owner,identityChanged,resource={kind:'issue'}){Object.assign(this,{owner,resource});}assertCurrent(){}get prefix(){return'I_';}directory(){return globalThis.testRequest('/api/directory');}resolve(path){return globalThis.testRequest('/api/resolve?path='+encodeURIComponent(path));}}
export const request=path=>globalThis.testRequest(path);
export const isIssue=()=>false;

export class HttpError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
