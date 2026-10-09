import {validateWikiCreateRecord} from './wiki-create-record.mjs';
/** Interface bridge; the existing session owner remains the sole key authority. */
export function createWikiProtection({factory,keyProvider,api,pageId,draftId,originalScope,existingPage,creating=false,...options}){
 if(Object.keys(options).some(k=>!['dbName','fault','onBinding','dirty'].includes(k)))throw Error('WIKI_PROTECTION_OPTION_INVALID');
 if(typeof factory!=='function'||typeof keyProvider!=='function')throw Error('WIKI_PROTECTION_PORT_UNCONNECTED');
 if(!originalScope||!['project','workspace_shared'].includes(originalScope.kind)||originalScope.kind==='project'&&typeof originalScope.projectId!=='string')throw Error('WIKI_ORIGINAL_SCOPE_REQUIRED');
 const scope=Object.freeze(structuredClone(originalScope));
 if(creating&&draftId!==pageId)throw Error('WIKI_CREATE_BINDING_MISMATCH');
 if(!creating&&(!existingPage||existingPage.id!==pageId))throw Error('WIKI_EXISTING_PAGE_REQUIRED');
 const shared=scope.kind==='workspace_shared';
 // Shared creation's resourceId is selected session workspaceId, never an arbitrary page.
 const settings={...options,api,keyProvider,issueId:pageId,draftId,projectAtProtection:shared?null:scope.projectId,resourceType:creating?(shared?'workspace':'project'):'wiki',editorId:creating?'wiki-create':'wiki-content'};
 if(creating&&!shared)settings.projectId=scope.projectId;
 if(creating&&shared)settings.resourceIdFromSession='workspace';
 const port=factory(settings);
 if(creating){const restore=port.restore.bind(port),persist=port.persist.bind(port);port.restore=async(...args)=>{const r=await restore(...args);return r?validateWikiCreateRecord(r,{pageId,scope,session:args[0]}):r;};port.persist=(r,...args)=>persist(validateWikiCreateRecord(r,{pageId,scope,session:args[0]}),...args);}
 Object.defineProperties(port,{resourceType:{value:'wiki'},resourceId:{value:pageId},purpose:{value:creating?'wiki-create':'wiki-content'}});return port;
}
