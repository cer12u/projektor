import {WikiView} from './WikiView.tsx';
import {Component,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {checkBootstrap,chooseWorkspace,retainViewSelection,workspaceAccessNotice,type Bootstrap,type ProductPorts,type PrepareLeave,type Route,type Selected} from './contracts.ts';
import {UIRouter,nextRoute} from './router.ts';
import {ConnectionNotice,Expiry,Notice} from './components.tsx';
import {ListView,ContentView,ProjectPicker} from './views.tsx';
export class Boundary extends Component<{children:React.ReactNode},{failed:boolean}>{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<main><h1>View unavailable</h1><Notice error>The view stopped safely. Keep this page open if input was not protected. No automatic reload or resubmission was performed.</Notice></main>:this.props.children;}
}
export function App({ports}:{ports:ProductPorts}){
  const router=useMemo(()=>new UIRouter(window),[]);const[,redraw]=useState(0);
  const[data,setData]=useState<Bootstrap|null>(null);const[phase,setPhase]=useState('loading');const[code,setCode]=useState<string|null>(null);
  const[masked,setMasked]=useState(true);const[accessRevision,setAccessRevision]=useState(0);const[workspacePicker,setWorkspacePicker]=useState(false);
  const flight=useRef<AbortController|null>(null);const seq=useRef(0);
  const prepare=useRef<PrepareLeave>(async()=>true);const workspaceButton=useRef<HTMLButtonElement>(null);
  const guard=useCallback((fn:PrepareLeave)=>{prepare.current=fn;return()=>{if(prepare.current===fn)prepare.current=async()=>true;};},[]);
  const boot=useCallback(async()=>{
    flight.current?.abort();const abort=new AbortController();flight.current=abort;const generation=++seq.current;
    setMasked(true);setPhase('loading');setCode(null);
    try{const value=checkBootstrap(await ports.bootstrap({signal:abort.signal}));if(generation!==seq.current||abort.signal.aborted||document.visibilityState==='hidden')return;
      setData(value);setAccessRevision(generation);setPhase(value.workspaces.length?'ready':'empty');setMasked(false);
    }catch(e:any){if(generation!==seq.current)return;setPhase('error');setCode(e.code??e.message??'BOOTSTRAP_FAILED');setMasked(true);}
  },[ports]);
  useEffect(()=>{router.prepare=()=>prepare.current();return router.subscribe(()=>redraw(x=>x+1));},[router]);
  useEffect(()=>{
    const mask=()=>{flight.current?.abort();seq.current++;flushSync(()=>setMasked(true));};
    const visibility=()=>document.visibilityState==='hidden'?mask():void boot();
    const show=()=>{mask();if(document.visibilityState!=='hidden')void boot();};
    const session=()=>{mask();void boot();};
    document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',mask);window.addEventListener('pageshow',show);
    const channel=new BroadcastChannel('projektor-session');channel.addEventListener('message',session);
    void boot();return()=>{flight.current?.abort();seq.current++;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',mask);window.removeEventListener('pageshow',show);channel.close();router.dispose();};
  },[boot,router]);
  useEffect(()=>{if(!data)return;const t=setTimeout(()=>setMasked(true),Math.max(0,data.expiresAt-Date.now()));return()=>clearTimeout(t);},[data]);
  useEffect(()=>{if(workspacePicker)requestAnimationFrame(()=>document.querySelector<HTMLElement>('[data-workspace-heading]')?.focus());},[workspacePicker]);
  const route=router.route;let workspace=null,selectionError:string|null=null;
  try{if(data)workspace=chooseWorkspace(data,route.workspaceId);}catch(e:any){selectionError=e.message;}
  const accessNotice=workspaceAccessNotice(data?.workspaces.length??null,!!selectionError);
  const selectedPrincipal=workspace?.principal??data?.principal??null;
  const selected=useMemo<Selected|null>(()=>workspace&&selectedPrincipal?{principal:selectedPrincipal,workspace}:null,[selectedPrincipal?.id,selectedPrincipal?.kind,workspace?.id,workspace?.epoch]);
  const retainedSelection=useRef<Selected|null>(null);retainedSelection.current=retainViewSelection(retainedSelection.current,selected);
  // Retain only a locked editor for memory preservation. This is never an
  // authorized selection or a source for header/navigation identity.
  const viewSelection=retainedSelection.current;
  // Explicitly bind route to the sole authorized workspace without interpreting
  // an old hint as authorization. Invalid deep links never fall back to home.
  useEffect(()=>{if(selected&&!route.workspaceId)router.replace({...route,workspaceId:selected.workspace.id});},[selected,route.workspaceId]);
  const navigate=useCallback((patch:Partial<Route>)=>{void router.go(nextRoute(router.route,patch)).then(ok=>{if(ok){setWorkspacePicker(false);requestAnimationFrame(()=>document.querySelector<HTMLElement>('main h1')?.focus());}});},[router]);
  const replace=useCallback((patch:Partial<Route>)=>router.replace(nextRoute(router.route,patch)),[router]);
  const restoreView=useCallback(()=>router.restoreView(),[router]);
  const props=viewSelection?{ports,selected:viewSelection,route,navigate,replace,guard,restoreView,locked:masked||!selected}:null;
  return <><a className="skip" href="#main">Skip to main content</a><ConnectionNotice fixture={ports.evidence==='contract-fixture'}/>
    <header><strong>Projektor</strong><span>{masked?'Identity verification required':selected?`${selected.principal.displayName} · ${selected.principal.kind==='machine'?'Agent':'Human'}`:data?.principal?`${data.principal.displayName} · ${data.principal.kind==='machine'?'Agent':'Human'}`:data?'Authenticated identity · no selected workspace principal':''}</span></header>
    <div className="shell"><nav aria-label="Main navigation">
      <p>{masked?'Workspace locked':workspace?.title??'Choose a workspace'}</p>
      <button disabled={!selected||masked||router.busy} onClick={()=>navigate({view:'list',issueId:null,projectId:null,draftId:null,projectAtProtection:null})}>My Issues</button>
      <button disabled={!selected||masked||router.busy} onClick={()=>navigate({view:'board',issueId:null,projectId:null,draftId:null,projectAtProtection:null})}>Board</button>
      <button ref={workspaceButton} disabled={masked||router.busy} onClick={()=>setWorkspacePicker(true)}>Choose workspace</button>
      <button disabled={!selected||masked||router.busy} onClick={()=>navigate({view:'wiki',pageId:null,draftId:null,projectAtProtection:null,wikiProtectionScope:null})}>Wiki</button>
    </nav><main id="main">
      {router.error&&<Notice error>{router.error}</Notice>}
      {phase==='loading'&&<Notice>Checking authenticated workspace access…</Notice>}
      {phase==='error'&&<><h1 tabIndex={-1}>Product connection incomplete</h1><Notice error>{code}. Workspace content remains locked; bootstrap has not authorized this view.</Notice><button onClick={()=>boot()}>Retry bootstrap</button></>}
      {!masked&&accessNotice==='no-workspaces'&&<><h1>No workspace access</h1><Notice>Your identity is verified, but no workspace membership is available</Notice><button onClick={()=>boot()}>Recheck workspace access</button></>}
      {!masked&&accessNotice==='selection-unavailable'&&<><h1>Workspace unavailable</h1><Notice error>This deep link does not select an authorized workspace. Choose a workspace explicitly.</Notice><button onClick={()=>boot()}>Recheck workspace access</button></>}
      {!masked&&data&&(workspacePicker||!selected||selectionError)&&data.workspaces.length>0&&<section aria-label="Workspace selection"><h1 data-workspace-heading tabIndex={-1}>Choose a workspace</h1>{workspacePicker&&selected&&<button onClick={()=>{setWorkspacePicker(false);workspaceButton.current?.focus();}}>Cancel workspace selection</button>}<ul>{data.workspaces.map(w=><li key={w.id}><button onClick={()=>navigate({workspaceId:w.id,view:'list',issueId:null,projectId:null,draftId:null,projectAtProtection:null})}>{w.title}</button></li>)}</ul></section>}
      {viewSelection&&props&&<div key={viewSelection.principal.id+viewSelection.workspace.id+viewSelection.workspace.epoch}>
        {!masked&&data&&<Expiry expiresAt={data.expiresAt}/>}
        {route.view.startsWith('wiki')?<WikiView key={route.view+route.pageId} {...props} accessRevision={accessRevision}/>:['list','board'].includes(route.view)?<><ListView {...props}/><ProjectPicker ports={ports} selected={viewSelection} navigate={navigate} locked={masked||!selected} accessRevision={accessRevision}/></>:<ContentView key={route.view+route.issueId+route.projectId} {...props}/>}
      </div>}
      {masked&&phase!=='loading'&&phase!=='error'&&<Notice>Content locked. Verify your session before restoring drafts <button onClick={()=>boot()}>Verify access</button></Notice>}
    </main></div></>;
}
