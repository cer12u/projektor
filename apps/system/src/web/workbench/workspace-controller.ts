// @module workbench
// @role controller
import type {Directory} from './directory-model';
import {resourceKey,validContentId,type EditingResource} from "../../modules/work/content-contracts";
import {useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import type {WorkspaceProps} from './workspace-contracts';
import {unsavedRecord} from './edit-store';
import {IssueEditor} from './editor';
import {currentZone} from './planning-location';
import {IssueApi} from './issue-api';
import {store} from './editor-store';
import {documentId,storageTarget,newTarget} from './content-target';
import {navigate,readSelection} from './workspace-navigation';
import {acquireUnit} from './editor-unit';
export function useWorkspaceController({identity,reauth,identityChanged,onEditor}:WorkspaceProps){
  const params=new URL(location.href).searchParams,allowed=identity.projects.filter(p=>p.permissions.includes('view'));
  const directoryScope=JSON.stringify(allowed.map(p=>p.id).sort());
  const navigationVersion=useRef(0),viewableProjects=useRef(allowed);viewableProjects.current=allowed;
  useEffect(()=>()=>{navigationVersion.current++;},[]);
  const initialProject=allowed.some(p=>p.id===params.get('project'))?params.get('project')!:(allowed[0]?.id??'PTORDEV');
  const [directorySnapshot,setDirectory]=useState<{scope:string;value:Directory}|null>(null),legacyPath=useRef(location.pathname);
  const directory=directorySnapshot?.scope===directoryScope?directorySnapshot.value:null;
  const [selection,setSelection]=useState(()=>readSelection(initialProject));
  const [editor,setEditor]=useState<IssueEditor|null>(null),[drafts,setDrafts]=useState<{targetId:string;unitId:string;projectId:string;resource?:EditingResource;text:string;updatedAt:number}[]>([]),[openId,setOpenId]=useState(''),[listEpoch,setListEpoch]=useState(0);
  const api=useMemo(()=>new IssueApi(identity.principal.id,identityChanged,selection.resource),[identity.principal.id,identityChanged,selection.resource]);
  const issueApi=useMemo(()=>new IssueApi(identity.principal.id,identityChanged),[identity.principal.id,identityChanged]);
  const current=useRef<IssueEditor|null>(null);const [zone,setZone]=useState(currentZone);
  useEffect(()=>{function warn(event:BeforeUnloadEvent){const view=current.current?.snapshot();if(view&&(view.writes||unsavedRecord(view.record)))event.preventDefault();}window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
  useEffect(()=>{let live=true;void issueApi.directory<Directory>().then(d=>{issueApi.assertCurrent(d);if(live)setDirectory({scope:directoryScope,value:d});}).catch(()=>{if(live)setDirectory(null);});return()=>{live=false;};},[identity.principal.id,directoryScope,issueApi]);
  useEffect(()=>{let live=true;const path=legacyPath.current,from=location.href,version=navigationVersion.current;if(path!=='/')void issueApi.resolve(path).then(async r=>{
    const p=new URL(r.url,location.origin),project=p.searchParams.get('project');
    await current.current?.flush();issueApi.assertCurrent(r);
    if(!live||version!==navigationVersion.current||location.href!==from||p.origin!==location.origin||!viewableProjects.current.some(v=>v.id===project))return;
    history.replaceState(null,'',p);legacyPath.current='/';const next=readSelection(project!);setSelection(v=>({...next,serial:v.serial+1}));
  }).catch(()=>{});return()=>{live=false;};},[identity.principal.id]);
  const canView=allowed.some(p=>p.id===selection.project),canEdit=allowed.some(p=>p.id===selection.project&&p.permissions.includes('edit'));
  const visibleDrafts=drafts.filter(d=>allowed.some(p=>p.id===d.projectId));
  useEffect(()=>{
    let cancelled=false,release=()=>{},routeTarget=selection.target,routeUnit=new URL(location.href).searchParams.get('unit');setEditor(null);onEditor(null);
    const visible=()=>{const p=new URL(location.href).searchParams,next=readSelection(selection.project);return(p.get('project')??selection.project)===selection.project&&next.target===routeTarget&&p.get('unit')===routeUnit&&resourceKey(next.resource)===resourceKey(selection.resource)&&viewableProjects.current.some(v=>v.id===selection.project);};
    void acquireUnit(identity.principal.id,selection.project,selection.target).then(async acquired=>{
      release=acquired.release;if(cancelled||!visible()){release();return;}if(legacyPath.current==='/'||location.pathname==='/'){navigate(selection.project,selection.resource,selection.target,acquired.unit);routeUnit=acquired.unit;}
      const e=new IssueEditor(store,api,selection.project,selection.target,acquired.unit,reauth,(id,unit)=>{if(cancelled||current.current!==e||!visible())return;acquired.setTarget(id);navigate(selection.project,selection.resource,id,unit);routeTarget=id;routeUnit=unit;setListEpoch(v=>v+1);});
      current.current=e;setEditor(e);onEditor(e);await e.init();
    });
    return()=>{cancelled=true;release();current.current?.dispose();current.current=null;onEditor(null);};
  },[selection,identity.principal.id,api,reauth,onEditor]);
  useEffect(()=>{const restore=()=>{
    const version=++navigationVersion.current,from=location.href,p=new URL(from).searchParams,project=p.get('project')??initialProject;
    if(!viewableProjects.current.some(v=>v.id===project))return;
    const next=readSelection(project),unit=p.get('unit');
    if(selection.project!==project||current.current?.snapshot().record.targetId!==next.target||resourceKey(selection.resource)!==resourceKey(next.resource)||(unit&&current.current?.snapshot().record.unitId!==unit)){
      void(async()=>{await current.current?.flush();const p=new URL(location.href).searchParams,restored=readSelection(project);if(version!==navigationVersion.current||(p.get('project')??initialProject)!==project||restored.target!==next.target||resourceKey(restored.resource)!==resourceKey(next.resource)||p.get('unit')!==unit||!viewableProjects.current.some(v=>v.id===project))return;setSelection(v=>({...next,serial:v.serial+1}));setOpenId(documentId(next.resource,next.target)??'');})();
    }
  };window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[selection,initialProject]);
  async function choose(project:string,resource:EditingResource,target:string,unit?:string){
    const version=++navigationVersion.current;await current.current?.flush();
    if(version!==navigationVersion.current||!viewableProjects.current.some(v=>v.id===project))return;
    const key=validContentId(resource,target)?storageTarget(resource,target):target;navigate(project,resource,key,unit,'push');setOpenId(documentId(resource,key)??'');setSelection(s=>({project,resource,target:key,serial:s.serial+1}));
  }
  function selectProject(project:string){const resource:EditingResource={kind:project.startsWith('workspace:')||selection.resource.kind==='wiki'?'wiki':'issue'};void choose(project,resource,newTarget(resource,project));}
  const selectContent=(resource:EditingResource,id?:string)=>void choose(selection.project,resource,id??newTarget(resource,selection.project));
  async function listDrafts(){try{setDrafts((await store.list(identity.principal.id)).filter(unsavedRecord));}catch{setDrafts([]);}}
  function open(event:FormEvent){event.preventDefault();if(validContentId(api.resource,openId))void choose(selection.project,selection.resource,openId);}
  const label=selection.resource.kind==='issue'?'Issue':selection.resource.kind==='wiki'?'Wiki':'コメント';
return {identity,identityChanged,allowed,directory,selection,editor,openId,setOpenId,listEpoch,api,issueApi,zone,setZone,canView,canEdit,visibleDrafts,choose,selectContent,selectProject,listDrafts,open,label};
}
