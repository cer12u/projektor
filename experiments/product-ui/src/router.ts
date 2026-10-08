import {isID,type Route,type PrepareLeave} from './contracts.ts';
const views=new Set(['list','board','issue','create','project','wiki','wiki-page','wiki-create']);
export function parseRoute(input:string):Route{
  if(!/^\/(?:\?|$)/.test(input))throw new Error('ROUTE_INVALID');
  const url=new URL(input,'https://ui.invalid');
  if(url.origin!=='https://ui.invalid'||url.pathname!=='/'||url.hash||/[\\]/.test(input))throw new Error('ROUTE_INVALID');
  const p=url.searchParams;
  if([...p.keys()].some(k=>!['view','workspaceId','pageId','wikiProtectionScope','issueId','projectId','status','draftId','projectAtProtection'].includes(k))||[...p.keys()].some(k=>p.getAll(k).length!==1))throw new Error('ROUTE_INVALID');
  const view=p.get('view')??'list';
  if(!views.has(view))throw new Error('ROUTE_INVALID');
  for(const key of ['workspaceId','pageId','issueId','projectId','draftId','projectAtProtection'])if(p.has(key)&&!isID(p.get(key)))throw new Error('ROUTE_INVALID');
  const status=p.get('status')??'unresolved';if(!['all','unresolved'].includes(status))throw new Error('ROUTE_INVALID');
  if(p.has('wikiProtectionScope')&&!['project','workspace_shared'].includes(p.get('wikiProtectionScope')!))throw new Error('ROUTE_INVALID');
  if(['wiki-page','wiki-create'].includes(view)&&!p.get('pageId'))throw new Error('ROUTE_INVALID');
  if(view==='wiki-create'&&(p.get('draftId')!==p.get('pageId')||!p.get('wikiProtectionScope')||p.get('wikiProtectionScope')==='project'&&!p.get('projectAtProtection')||p.get('wikiProtectionScope')==='workspace_shared'&&p.has('projectAtProtection')))throw new Error('ROUTE_INVALID');
  if(view==='issue'&&!p.get('issueId')||['create','project'].includes(view)&&!p.get('projectId'))throw new Error('ROUTE_INVALID');
  return {view:view as Route['view'],workspaceId:p.get('workspaceId'),pageId:p.get('pageId'),wikiProtectionScope:p.get('wikiProtectionScope') as Route['wikiProtectionScope'],issueId:p.get('issueId'),projectId:p.get('projectId'),status:status as Route['status'],draftId:p.get('draftId'),projectAtProtection:p.get('projectAtProtection')};
}
export function routeURL(route:Route):string{
  const p=new URLSearchParams();for(const[k,v]of Object.entries(route))if(v!==null)p.set(k,v);
  const url='/?'+p;parseRoute(url);return url;
}
export function nextRoute(current:Route,patch:Partial<Route>):Route{
  return parseRoute(routeURL({...current,...patch}));
}
/** Recognize direct source routes only; this does not resolve or authorize them.
 * The authenticated service owns key, slug and number semantics. */
export function isLegacyLocation(path:string):boolean{
  if(new TextEncoder().encode(path).byteLength>16384||/[?#\\\u0000-\u0020\u007f]/.test(path))return false;
  if(!/^\/projects\/[^/]+\/issues\/[1-9][0-9]*\/[^/]*$/.test(path)&&!/^\/wiki\/[^/]+$/.test(path)&&!/^\/projects\/view\/[^/]+$/.test(path))return false;
  try{return path.split('/').slice(1).every(part=>{const value=decodeURIComponent(part);return !['.','..'].includes(value)&&!/[\/\\\u0000-\u001f\u007f]/.test(value);});}catch{return false;}
}
/** URL/navigation only. No command dispatch, auth state, retry or draft storage. */
export class UIRouter{
  route:Route; index:number; private window:Window; private listeners=new Set<()=>void>();
  legacyPath:string|null=null; unavailable=false; private address='';
  prepare:PrepareLeave=async()=>true; busy=false; error:string|null=null;
  private bounce:number|null=null; private accept:number|null=null;
  private generation=0;
  private pendingView:any=null;
  constructor(win:Window){
    this.window=win;this.route=parseRoute('/');this.readLocation();
    this.index=Number.isSafeInteger(win.history.state?.projektorIndex)?win.history.state.projektorIndex:0;
    this.pendingView=win.history.state?.view??null;
    win.history.replaceState({...win.history.state,projektorIndex:this.index,view:this.pendingView},'',this.address);
    win.history.scrollRestoration='manual';
    win.addEventListener('popstate',this.pop);
  }
  get pendingLocation(){return this.legacyPath!==null||this.unavailable;}
  get navigationGeneration(){return this.generation;}
  private readLocation(){
    const input=this.window.location.pathname+this.window.location.search+(this.window.location.hash??'');
    this.legacyPath=null;this.unavailable=false;this.address=input;
    try{this.route=parseRoute(input);this.address=routeURL(this.route);}
    catch{this.route=parseRoute('/');if(isLegacyLocation(input))this.legacyPath=input;else this.unavailable=true;
      const hint=this.window.history.state?.legacyWorkspaceId;if(this.legacyPath&&isID(hint))this.route.workspaceId=hint;}
  }
  bindWorkspace(workspaceId:string){
    if(!isID(workspaceId))throw Error('ROUTE_INVALID');
    if(!this.legacyPath){if(!this.unavailable)this.replace({...this.route,workspaceId});return;}
    try{this.window.history.replaceState({...this.window.history.state,legacyWorkspaceId:workspaceId},'',this.address);this.generation++;this.route={...this.route,workspaceId};}
    catch{this.error='Navigation metadata could not be saved. Keep this page open';}this.emit();
  }
  resolveLegacy(target:Route,path:string,generation:number){
    if(this.busy||this.legacyPath!==path||generation!==this.generation||target.workspaceId!==this.route.workspaceId)return false;
    return this.replace(target);
  }
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private emit(){for(const fn of this.listeners)fn();}
  async go(route:Route){
    if(this.busy)return false;const target=parseRoute(routeURL(route));this.busy=true;this.error=null;this.emit();
    const generation=++this.generation;
    try{if(!await this.prepare()){this.error='Navigation stopped: the latest draft could not be protected';return false;}
      if(generation!==this.generation)return false;
      this.captureView();const nextIndex=this.index+1;this.window.history.pushState({projektorIndex:nextIndex},'',routeURL(target));this.route=target;this.address=routeURL(target);this.legacyPath=null;this.unavailable=false;this.index=nextIndex;this.pendingView=null;return true;
    }catch{this.error='Navigation stopped: keep this page open to preserve your draft';return false;}
    finally{this.busy=false;this.emit();}
  }
  async goLegacy(path:string){
    if(this.busy||!isLegacyLocation(path))return false;
    this.busy=true;this.error=null;this.emit();const generation=++this.generation;
    try{if(!await this.prepare()){this.error='Navigation stopped: the latest draft could not be protected';return false;}
      if(generation!==this.generation)return false;
      this.captureView();const nextIndex=this.index+1,workspaceId=this.route.workspaceId;
      this.window.history.pushState({projektorIndex:nextIndex,legacyWorkspaceId:workspaceId},'',path);
      this.readLocation();this.index=nextIndex;this.pendingView=null;return true;
    }catch{this.error='Navigation stopped: keep this page open to preserve your draft';return false;}
    finally{this.busy=false;this.emit();}
  }
  replace(route:Route){const target=parseRoute(routeURL(route));let saved=false;try{this.window.history.replaceState({...this.window.history.state,legacyWorkspaceId:undefined,projektorIndex:this.index,view:this.window.history.state?.view??null},'',routeURL(target));this.route=target;this.address=routeURL(target);this.legacyPath=null;this.unavailable=false;this.generation++;saved=true;}catch{this.error='Navigation metadata could not be saved. Keep this page open';}this.emit();return saved;}
  captureView(){const active=this.window.document?.activeElement;const view={scrollY:Math.max(0,this.window.scrollY??0),focusKey:active?.getAttribute('data-focus-key')??null};this.window.history.replaceState({...this.window.history.state,projektorIndex:this.index,view},'',this.address);}
  restoreView(){const view=this.pendingView;if(!view)return;this.pendingView=null;const target=[...this.window.document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(el=>el.dataset.focusKey===view.focusKey);target?.focus({preventScroll:true});if(Number.isFinite(view.scrollY))this.window.scrollTo(0,Math.max(0,view.scrollY));}
  private pop=async(event:PopStateEvent)=>{
    const targetIndex=event.state?.projektorIndex;
    if(targetIndex===this.bounce){this.bounce=null;return;}
    if(targetIndex===this.accept){this.accept=null;this.index=targetIndex;this.pendingView=event.state?.view??null;this.readLocation();this.generation++;this.error=null;this.busy=false;this.emit();return;}
    if(!Number.isSafeInteger(targetIndex)){this.error='Unknown history entry; use the navigation links';this.emit();return;}
    const delta=targetIndex-this.index;if(!delta)return;
    if(this.busy){this.bounce=this.index;this.window.history.go(-delta);return;}
    // Restore the old history entry before waiting on asynchronous protection.
    this.generation++;this.busy=true;this.bounce=this.index;this.window.history.go(-delta);this.emit();
    let safe=false;try{safe=await this.prepare();}catch{}
    // Let the native restoration event settle before performing the intended pop.
    const restored=await new Promise<boolean>(resolve=>{const deadline=Date.now()+1000;const wait=()=>this.bounce===null?resolve(true):Date.now()>=deadline?resolve(false):setTimeout(wait,10);wait();});
    if(!restored){this.busy=false;this.error='History restoration stopped. Keep this page open';this.emit();return;}
    if(safe){this.accept=targetIndex;this.window.history.go(delta);}
    else{this.busy=false;this.error='Navigation stopped: the latest draft could not be protected';this.emit();}
  };
  dispose(){this.generation++;this.window.removeEventListener('popstate',this.pop);this.listeners.clear();}
}
