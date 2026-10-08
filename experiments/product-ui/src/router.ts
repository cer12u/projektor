import {isID,type Route,type PrepareLeave} from './contracts.ts';
const views=new Set(['list','board','issue','create']);
export function parseRoute(input:string):Route{
  const url=new URL(input,'https://ui.invalid');
  if(url.origin!=='https://ui.invalid'||url.pathname!=='/'||url.hash||/[\\]/.test(input))throw new Error('ROUTE_INVALID');
  const p=url.searchParams;
  if([...p.keys()].some(k=>!['view','workspaceId','issueId','projectId','status','draftId','projectAtProtection'].includes(k))||[...p.keys()].some(k=>p.getAll(k).length!==1))throw new Error('ROUTE_INVALID');
  const view=p.get('view')??'list';
  if(!views.has(view))throw new Error('ROUTE_INVALID');
  for(const key of ['workspaceId','issueId','projectId','draftId','projectAtProtection'])if(p.has(key)&&!isID(p.get(key)))throw new Error('ROUTE_INVALID');
  const status=p.get('status')??'unresolved';if(!['all','unresolved'].includes(status))throw new Error('ROUTE_INVALID');
  if(view==='issue'&&!p.get('issueId')||view==='create'&&!p.get('projectId'))throw new Error('ROUTE_INVALID');
  return {view:view as Route['view'],workspaceId:p.get('workspaceId'),issueId:p.get('issueId'),projectId:p.get('projectId'),status:status as Route['status'],draftId:p.get('draftId'),projectAtProtection:p.get('projectAtProtection')};
}
export function routeURL(route:Route):string{
  const p=new URLSearchParams();for(const[k,v]of Object.entries(route))if(v!==null)p.set(k,v);
  const url='/?'+p;parseRoute(url);return url;
}
export function nextRoute(current:Route,patch:Partial<Route>):Route{
  return parseRoute(routeURL({...current,...patch}));
}
/** URL/navigation only. No command dispatch, auth state, retry or draft storage. */
export class UIRouter{
  route:Route; index:number; private window:Window; private listeners=new Set<()=>void>();
  prepare:PrepareLeave=async()=>true; busy=false; error:string|null=null;
  private bounce:number|null=null; private accept:number|null=null;
  private generation=0;
  private pendingView:any=null;
  constructor(win:Window){
    this.window=win;this.route=parseRoute(win.location.pathname+win.location.search);
    this.index=Number.isSafeInteger(win.history.state?.projektorIndex)?win.history.state.projektorIndex:0;
    this.pendingView=win.history.state?.view??null;
    win.history.replaceState({...win.history.state,projektorIndex:this.index,view:this.pendingView},'',routeURL(this.route));
    win.history.scrollRestoration='manual';
    win.addEventListener('popstate',this.pop);
  }
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private emit(){for(const fn of this.listeners)fn();}
  async go(route:Route){
    if(this.busy)return false;const target=parseRoute(routeURL(route));this.busy=true;this.error=null;this.emit();
    const generation=++this.generation;
    try{if(!await this.prepare()){this.error='Navigation stopped: the latest draft could not be protected';return false;}
      if(generation!==this.generation)return false;
      this.captureView();const nextIndex=this.index+1;this.window.history.pushState({projektorIndex:nextIndex},'',routeURL(target));this.route=target;this.index=nextIndex;this.pendingView=null;return true;
    }catch{this.error='Navigation stopped: keep this page open to preserve your draft';return false;}
    finally{this.busy=false;this.emit();}
  }
  replace(route:Route){const target=parseRoute(routeURL(route));try{this.window.history.replaceState({...this.window.history.state,projektorIndex:this.index,view:this.window.history.state?.view??null},'',routeURL(target));this.route=target;}catch{this.error='Navigation metadata could not be saved. Keep this page open';}this.emit();}
  captureView(){const active=this.window.document?.activeElement;const view={scrollY:Math.max(0,this.window.scrollY??0),focusKey:active?.getAttribute('data-focus-key')??null};this.window.history.replaceState({...this.window.history.state,projektorIndex:this.index,view},'',routeURL(this.route));}
  restoreView(){const view=this.pendingView;if(!view)return;this.pendingView=null;const target=[...this.window.document.querySelectorAll<HTMLElement>('[data-focus-key]')].find(el=>el.dataset.focusKey===view.focusKey);target?.focus({preventScroll:true});if(Number.isFinite(view.scrollY))this.window.scrollTo(0,Math.max(0,view.scrollY));}
  private pop=async(event:PopStateEvent)=>{
    const targetIndex=event.state?.projektorIndex;
    if(targetIndex===this.bounce){this.bounce=null;return;}
    if(targetIndex===this.accept){this.accept=null;this.index=targetIndex;this.pendingView=event.state?.view??null;this.route=parseRoute(this.window.location.pathname+this.window.location.search);this.error=null;this.busy=false;this.emit();return;}
    if(!Number.isSafeInteger(targetIndex)){this.error='Unknown history entry; use the navigation links';this.emit();return;}
    const delta=targetIndex-this.index;if(!delta)return;
    if(this.busy){this.bounce=this.index;this.window.history.go(-delta);return;}
    // Restore the old history entry before waiting on asynchronous protection.
    this.busy=true;this.bounce=this.index;this.window.history.go(-delta);
    let safe=false;try{safe=await this.prepare();}catch{}
    // Let the native restoration event settle before performing the intended pop.
    const restored=await new Promise<boolean>(resolve=>{const deadline=Date.now()+1000;const wait=()=>this.bounce===null?resolve(true):Date.now()>=deadline?resolve(false):setTimeout(wait,10);wait();});
    if(!restored){this.busy=false;this.error='History restoration stopped. Keep this page open';this.emit();return;}
    if(safe){this.accept=targetIndex;this.window.history.go(delta);}
    else{this.busy=false;this.error='Navigation stopped: the latest draft could not be protected';this.emit();}
  };
  dispose(){this.generation++;this.window.removeEventListener('popstate',this.pop);this.listeners.clear();}
}
