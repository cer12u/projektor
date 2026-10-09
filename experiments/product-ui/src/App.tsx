import {NativeDeviceView} from './NativeDeviceView.tsx';
import {needsLogin} from './app-auth.mjs';
import {LoginView} from './AuthView.tsx';
import {WikiView} from './WikiView.tsx';
import {Component,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {checkBootstrap,chooseWorkspace,retainViewSelection,workspaceAccessNotice,type Bootstrap,type ProductPorts,type PrepareLeave,type Route,type Selected} from './contracts.ts';
import {UIRouter,nextRoute} from './router.ts';
import {resolveLegacyNavigation} from './legacy-navigation.ts';
import {ProjectView} from './ProjectView.tsx';
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
  const[legacyState,setLegacyState]=useState<{binding:string;phase:string}|null>(null);
  const flight=useRef<AbortController|null>(null);const seq=useRef(0);const bootFlight=useRef<Promise<void>|null>(null);const logoutPending=useRef(false);
  const [authBusy,setAuthBusy]=useState(false),[authMessage,setAuthMessage]=useState<string|null>(null),[logoutUnknown,setLogoutUnknown]=useState(false);
  const prepare=useRef<PrepareLeave>(async()=>true);const workspaceButton=useRef<HTMLButtonElement>(null);
  const guard=useCallback((fn:PrepareLeave)=>{prepare.current=fn;return()=>{if(prepare.current===fn)prepare.current=async()=>true;};},[]);
  const boot=useCallback(({refresh=false}:{refresh?:boolean}={})=>{
    if(logoutPending.current)return Promise.resolve();
    if(bootFlight.current)return bootFlight.current;
    const run=(async()=>{
      flight.current?.abort();const abort=new AbortController();flight.current=abort;const generation=++seq.current;
      setMasked(true);setPhase('loading');setCode(null);
      try{
        if(ports.auth)await ports.auth.restore({refresh});
        const value=checkBootstrap(await ports.bootstrap({signal:abort.signal}));
        let chosen=null;try{chosen=chooseWorkspace(value,router.route.workspaceId);}catch{/* Invalid deep links remain locked to their requested workspace. */}
        if(chosen){const principal=chosen.principal??value.principal;if(principal)await ports.session({principal,workspace:chosen},{signal:abort.signal});}
        if(generation!==seq.current||abort.signal.aborted||document.visibilityState==='hidden')return;
        setData(value);setAccessRevision(generation);setPhase(value.workspaces.length?'ready':'empty');setMasked(false);
        if(!chosen)ports.auth?.confirmAccess();
      }catch(e:any){if(generation!==seq.current)return;setPhase(ports.auth&&needsLogin(e.code??e.message)?'login':'error');setCode(e.code??e.message??'BOOTSTRAP_FAILED');setMasked(true);}
    })();
    bootFlight.current=run.finally(()=>{bootFlight.current=null;});return bootFlight.current;
  },[ports,router]);
  const logout=useCallback(async()=>{
    if(authBusy||!ports.auth)return;setAuthBusy(true);setAuthMessage(null);
    try{
      if(!await prepare.current()){setAuthMessage('Sign-out stopped: the latest draft could not be protected. Keep this page open.');return;}
      logoutPending.current=true;flushSync(()=>setMasked(true));flight.current?.abort();seq.current++;
      try{await ports.auth.logout();logoutPending.current=false;setPhase('login');setLogoutUnknown(false);const channel=new BroadcastChannel('projektor-session');channel.postMessage({changed:true});channel.close();}
      catch{setLogoutUnknown(true);setPhase('logout-unknown');setAuthMessage('Sign-out is unconfirmed. Content stays locked; check the session before leaving.');}
    }catch{setAuthMessage('Sign-out stopped: keep this page open to preserve the latest draft.');}
    finally{setAuthBusy(false);}
  },[ports,authBusy]);
  const accessReady=useCallback(()=>{if(!masked)ports.auth?.confirmAccess();},[ports,masked]);
  useEffect(()=>ports.auth?.subscribe(()=>{if(!bootFlight.current&&!logoutUnknown)void boot({refresh:true});}),[ports,boot,logoutUnknown]);
  useEffect(()=>{router.prepare=()=>prepare.current();return router.subscribe(()=>redraw(x=>x+1));},[router]);
  useEffect(()=>{
    const mask=()=>{flight.current?.abort();seq.current++;flushSync(()=>setMasked(true));};
    const resume=()=>{void Promise.resolve(bootFlight.current).then(()=>{if(document.visibilityState!=='hidden')return boot();});};
    const visibility=()=>document.visibilityState==='hidden'?mask():resume();
    const show=()=>{mask();if(document.visibilityState!=='hidden')resume();};
    const session=()=>{mask();resume();};
    document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',mask);window.addEventListener('pageshow',show);
    const channel=new BroadcastChannel('projektor-session');channel.addEventListener('message',session);
    void boot();return()=>{flight.current?.abort();seq.current++;document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',mask);window.removeEventListener('pageshow',show);channel.close();router.dispose();};
  },[boot,router]);
  useEffect(()=>{if(!data||masked)return;const remaining=data.expiresAt-Date.now(),lead=ports.auth?Math.min(30000,Math.max(0,remaining/2)):0;const t=setTimeout(()=>ports.auth?void boot({refresh:true}):setMasked(true),Math.max(0,Math.min(2147483647,remaining-lead)));return()=>clearTimeout(t);},[data,masked,ports,boot]);
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
  useEffect(()=>{if(selected&&!route.workspaceId)router.bindWorkspace(selected.workspace.id);},[selected,route.workspaceId]);
  const legacyBinding=JSON.stringify([router.legacyPath,router.navigationGeneration,router.busy,selected?.principal.id,selected?.principal.kind,selected?.workspace.id,selected?.workspace.epoch,accessRevision,masked]);
  useEffect(()=>{
    const abort=new AbortController();
    if(masked||router.busy||!selected||!router.legacyPath||route.workspaceId!==selected.workspace.id)return()=>abort.abort();
    setLegacyState({binding:legacyBinding,phase:'loading'});
    void resolveLegacyNavigation(router,ports,selected,{signal:abort.signal,visible:()=>document.visibilityState!=='hidden'&&seq.current===accessRevision&&Date.now()<(data?.expiresAt??0)}).then(result=>{if(!abort.signal.aborted&&result==='unavailable')setLegacyState({binding:legacyBinding,phase:'unavailable'});});
    return()=>abort.abort();
  },[router,ports,selected,legacyBinding,route.workspaceId]);
  const navigate=useCallback((patch:Partial<Route>)=>{void router.go(nextRoute(router.route,patch)).then(ok=>{if(ok){setWorkspacePicker(false);requestAnimationFrame(()=>document.querySelector<HTMLElement>('main h1')?.focus());}});},[router]);
  const replace=useCallback((patch:Partial<Route>)=>router.replace(nextRoute(router.route,patch)),[router]);
  const restoreView=useCallback(()=>router.restoreView(),[router]);
  const props=viewSelection?{ports,selected:viewSelection,route,navigate,replace,guard,restoreView,accessReady,accessRevision,locked:masked||!selected}:null;
  return <><a className="skip" href="#main">Skip to main content</a><ConnectionNotice fixture={ports.evidence==='contract-fixture'}/>
    <header><strong>Projektor</strong><span>{masked?'Identity verification required':selected?`${selected.principal.displayName} · ${selected.principal.kind==='machine'?'Agent':'Human'}`:data?.principal?`${data.principal.displayName} · ${data.principal.kind==='machine'?'Agent':'Human'}`:data?'Authenticated identity · no selected workspace principal':''}</span>{ports.auth&&phase!=='login'&&<button disabled={masked||authBusy||router.busy} onClick={()=>void logout()}>Sign out</button>}</header>
    <div className="shell"><nav aria-label="Main navigation">
      <p>{masked?'Workspace locked':workspace?.title??'Choose a workspace'}</p>
      <button disabled={!selected||masked||router.busy} onClick={()=>navigate({view:'list',issueId:null,projectId:null,draftId:null,projectAtProtection:null})}>My Issues</button>
      <button disabled={!selected||masked||router.busy} onClick={()=>navigate({view:'board',issueId:null,projectId:null,draftId:null,projectAtProtection:null})}>Board</button>
      <button ref={workspaceButton} disabled={masked||router.busy} onClick={()=>setWorkspacePicker(true)}>Choose workspace</button>
      <button disabled={!selected||masked||router.busy} onClick={()=>navigate({view:'wiki',projectId:null,pageId:null,draftId:null,projectAtProtection:null,wikiProtectionScope:null})}>Wiki</button>
      {ports.auth&&<button disabled={masked||router.busy} onClick={()=>navigate({view:'devices',issueId:null,projectId:null,pageId:null,draftId:null,projectAtProtection:null,wikiProtectionScope:null})}>Machine devices</button>}
    </nav><main id="main">
      {authMessage&&<Notice error>{authMessage}</Notice>}
      {phase==='login'&&ports.auth&&<LoginView auth={ports.auth} reason={code} onLogin={()=>{setAuthMessage(null);setLogoutUnknown(false);logoutPending.current=false;return boot();}}/>}
      {logoutUnknown&&<button disabled={authBusy} onClick={async()=>{setAuthBusy(true);try{if(await ports.auth.logoutStatus()){logoutPending.current=false;setLogoutUnknown(false);setAuthMessage(null);setPhase('login');}else setAuthMessage('The session is still active. Keep this page open and explicitly sign out again.');}catch{setAuthMessage('Session status is unavailable. Keep this page open.');}finally{setAuthBusy(false);}}}>Check sign-out status</button>}
      {logoutUnknown&&<button disabled={authBusy} onClick={()=>void logout()}>Retry sign out</button>}
      {router.error&&<Notice error>{router.error}</Notice>}
      {phase==='loading'&&<Notice>Checking authenticated workspace access…</Notice>}
      {phase==='error'&&<><h1 tabIndex={-1}>Product connection incomplete</h1><Notice error>{code}. Workspace content remains locked; bootstrap has not authorized this view.</Notice><button onClick={()=>boot()}>Retry bootstrap</button></>}
      {!masked&&accessNotice==='no-workspaces'&&<><h1>No workspace access</h1><Notice>Your identity is verified, but no workspace membership is available</Notice><button onClick={()=>boot()}>Recheck workspace access</button></>}
      {!masked&&accessNotice==='selection-unavailable'&&<><h1>Workspace unavailable</h1><Notice error>This deep link does not select an authorized workspace. Choose a workspace explicitly.</Notice><button onClick={()=>boot()}>Recheck workspace access</button></>}
      {!masked&&data&&(workspacePicker||!selected||selectionError)&&data.workspaces.length>0&&<section aria-label="Workspace selection"><h1 data-workspace-heading tabIndex={-1}>Choose a workspace</h1>{workspacePicker&&selected&&<button onClick={()=>{setWorkspacePicker(false);workspaceButton.current?.focus();}}>Cancel workspace selection</button>}<ul>{data.workspaces.map(w=><li key={w.id}><button onClick={()=>{if(router.legacyPath){router.bindWorkspace(w.id);setWorkspacePicker(false);}else navigate({workspaceId:w.id,view:'list',issueId:null,projectId:null,draftId:null,projectAtProtection:null});}}>{w.title}</button></li>)}</ul></section>}
      {!masked&&selected&&router.pendingLocation&&<section aria-label="Legacy navigation"><h1 tabIndex={-1}>{router.unavailable||legacyState?.binding===legacyBinding&&legacyState.phase==='unavailable'?'Link unavailable':'Opening link'}</h1><Notice>{router.unavailable||legacyState?.binding===legacyBinding&&legacyState.phase==='unavailable'?'This link is unavailable in the selected workspace.':'Checking access to this link…'}</Notice>{!router.unavailable&&legacyState?.binding===legacyBinding&&legacyState.phase==='unavailable'&&<button onClick={()=>boot()}>Recheck link access</button>}</section>}
      {route.view==='devices'&&ports.auth&&!router.pendingLocation&&<NativeDeviceView auth={ports.auth} locked={masked} accessRevision={accessRevision} accessReady={accessReady}/>}
      {route.view!=='devices'&&viewSelection&&props&&!router.pendingLocation&&<div key={viewSelection.principal.id+viewSelection.workspace.id+viewSelection.workspace.epoch}>
        {!masked&&data&&<Expiry expiresAt={data.expiresAt}/>}
        {route.view==='project'?<ProjectView {...props} accessRevision={accessRevision}/>:route.view.startsWith('wiki')?<WikiView key={route.view+route.pageId} {...props} accessRevision={accessRevision}/>:['list','board'].includes(route.view)?<><ListView {...props}/><ProjectPicker ports={ports} selected={viewSelection} navigate={navigate} locked={masked||!selected} accessRevision={accessRevision}/></>:<ContentView key={route.view+route.issueId+route.projectId} {...props}/>}
      </div>}
      {masked&&phase!=='loading'&&phase!=='error'&&phase!=='login'&&!logoutUnknown&&<Notice>Content locked. Verify your session before restoring drafts <button onClick={()=>boot()}>Verify access</button></Notice>}
    </main></div></>;
}
