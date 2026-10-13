// @module delivery
// @role result-route-input
/** Exact read-only receipt routes only; never infer a receipt lookup from a suffix. */
export function resultLookupOperationId(path:string):string|undefined{
 const prepared=path.match(/^\/api\/agent\/operations\/([A-Za-z0-9_-]{1,128})$/);
 if(prepared)return prepared[1];
 const project=path.match(/^\/api\/projects\/[A-Za-z0-9_:-]{1,138}\/(?:(?:issue|wiki|execution|execution-report)-operations|(?:issues|wikis)\/[A-Za-z0-9_-]{1,128}\/comment-operations)\/([A-Za-z0-9_-]{1,128})$/);
 if(project)return project[1];
 const workspace=path.match(/^\/api\/workspaces\/[a-fA-F0-9-]{36}\/(?:wiki-operations|wikis\/[A-Za-z0-9_-]{1,128}\/comment-operations)\/([A-Za-z0-9_-]{1,128})$/);
 if(workspace)return workspace[1];
 return path.match(/^\/api\/management\/(?:password-setup\/)?operations\/([A-Za-z0-9_-]{1,128})$/)?.[1];
}

/** Execute paths also carry a request-known operation ID before authentication or gate checks. */
export function preparedExecuteOperationId(path:string):string|undefined {
 return path.match(/^\/api\/agent\/operations\/([A-Za-z0-9_-]{1,128})\/execute$/)?.[1];
}
