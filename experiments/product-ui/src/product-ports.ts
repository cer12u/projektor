import {createWikiAPI} from '../vendor/client/wiki-content.mjs';
import {createWikiProtection} from '../vendor/client/wiki-protection.mjs';
import {createSessionAPI,createContentProtection} from '../vendor/session-ports/client.mjs';
import {createContentAPI} from '../vendor/client/issue-content.mjs';
import {createMyIssuesTransport} from '../vendor/browser/my-issues.mjs';
import type {ProductPorts,Selected} from './contracts.ts';
/** Thin mapping of the session owner's exact wire contract into view props.
 * No endpoint fallback, issuer, membership mutation or local identity cache. */
export function createProductPorts({baseUrl=globalThis.location?.origin,fetchImpl=globalThis.fetch}={}):ProductPorts{
  const sessionAPI=createSessionAPI({baseUrl,fetchImpl});
  const api=createContentAPI({baseUrl,fetchImpl});
  const list=createMyIssuesTransport({baseUrl,fetchImpl});
  const actor=(id:string)=>({id,kind:'human' as const,displayName:id});
  const session=async(selected:Selected,options:{signal?:AbortSignal}={})=>{
    const value=await sessionAPI.session({workspaceId:selected.workspace.id,signal:options.signal} as any);
    if(value.principalId!==selected.principal.id||value.workspaceEpoch!==selected.workspace.epoch||value.actorKind!==selected.principal.kind)throw Object.assign(new Error('SELECTION_BINDING_MISMATCH'),{code:'SELECTION_BINDING_MISMATCH'});
    return value;
  };
  return {
    evidence:'product',
    async bootstrap(options){
      const b=await sessionAPI.bootstrap(options);
      return {principal:b.principalId?actor(b.principalId):null,expiresAt:b.expiresAt,
        workspaces:b.workspaces.map((w:any)=>({id:w.workspaceId,epoch:w.workspaceEpoch,title:w.name,principal:actor(w.principalId)}))};
    },
    session,
    wikiAPI(selected){return createWikiAPI({baseUrl,fetchImpl,session:(options:any)=>session(selected,options)} as any);},
    wikiProtection(options){return createWikiProtection({...options,factory:createContentProtection,keyProvider:sessionAPI.keyProvider,dbName:'projektor-product-drafts-v1'});},
    contentAPI(selected){return {...api,session:(options:any)=>session(selected,options)};},
    listTransport(){return list;},
    protection(options){return createContentProtection({...options,keyProvider:sessionAPI.keyProvider,dbName:'projektor-product-drafts-v1'} as any);},
  };
}
