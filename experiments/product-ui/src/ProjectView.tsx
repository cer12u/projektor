import {useEffect,useState} from 'react';
import {Notice} from './components.tsx';
import {isID,type ProductPorts,type Selected} from './contracts.ts';
import type {ViewProps} from './views.tsx';

export async function readSelectedProject(ports:ProductPorts,selected:Selected,projectId:string,signal:AbortSignal){
  if(!isID(projectId))throw Error('PROJECT_UNAVAILABLE');
  const session=await ports.session(selected,{signal});
  if(signal.aborted)throw Error('PROJECT_UNAVAILABLE');
  const body=await ports.contentAPI(selected).project({session,projectId,signal});
  const p=body?.data,m=body?.meta;
  if(signal.aborted||session.expiresAt<=Date.now()||m?.actorId!==selected.principal.id||m?.workspaceId!==selected.workspace.id||m?.workspaceEpoch!==selected.workspace.epoch||p?.id!==projectId||typeof p.title!=='string'||!(p.key===null||typeof p.key==='string')||!(p.slug===null||typeof p.slug==='string'))throw Error('PROJECT_UNAVAILABLE');
  return {id:p.id as string,title:p.title as string,key:p.key as string|null,slug:p.slug as string|null};
}

/** Authorized project identity and existing actions, not an issue overview. */
export function ProjectView({ports,selected,route,navigate,locked,accessRevision}:ViewProps&{accessRevision:number}){
  const [loaded,setLoaded]=useState<{binding:string;project?:Awaited<ReturnType<typeof readSelectedProject>>;failed?:boolean}|null>(null);
  const binding=JSON.stringify([selected.principal.id,selected.principal.kind,selected.workspace.id,selected.workspace.epoch,route.projectId,accessRevision,locked]);
  useEffect(()=>{
    const abort=new AbortController();
    if(!locked&&route.projectId)void readSelectedProject(ports,selected,route.projectId,abort.signal).then(project=>{if(!abort.signal.aborted)setLoaded({binding,project});}).catch(()=>{if(!abort.signal.aborted)setLoaded({binding,failed:true});});
    return()=>abort.abort();
  },[ports,selected,binding]);
  if(locked)return <Notice>Project locked until access is verified</Notice>;
  const current=loaded?.binding===binding?loaded:null,p=current?.project;
  if(!p)return <section><h1 tabIndex={-1}>{current?.failed?'Project unavailable':'Project'}</h1><Notice>{current?.failed?'This project is unavailable in the selected workspace.':'Checking project access…'}</Notice></section>;
  const createWiki=()=>{const id=crypto.randomUUID();navigate({view:'wiki-create',pageId:id,draftId:id,projectId:null,issueId:null,wikiProtectionScope:'project',projectAtProtection:p.id});};
  return <section aria-label="Project"><h1 tabIndex={-1}>{p.title}</h1>{p.key&&<p>Project key: {p.key}</p>}{p.slug&&<p>Project slug: {p.slug}</p>}
    <button onClick={()=>navigate({view:'create',projectId:p.id,issueId:null,pageId:null,draftId:crypto.randomUUID(),projectAtProtection:null,wikiProtectionScope:null})}>Create issue in {p.title}</button>
    <button onClick={()=>navigate({view:'wiki',projectId:p.id,issueId:null,pageId:null,draftId:null,projectAtProtection:null,wikiProtectionScope:null})}>Open project Wiki</button>
    <button onClick={createWiki}>Create Wiki page in {p.title}</button>
  </section>;
}
