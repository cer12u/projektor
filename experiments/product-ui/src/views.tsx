import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {flushSync} from 'react-dom';
import {isID,type ProductPorts,type Selected,type Route,type PrepareLeave} from './contracts.ts';
import {IssueContentController,MyIssuesController,preserveMarkdownInput} from './core.ts';
import {Notice,IssueRows,listMessage,EntryList,History,editorMessage,states,actionResultText} from './components.tsx';
export interface ViewProps {ports:ProductPorts;selected:Selected;route:Route;navigate:(patch:Partial<Route>)=>void;replace:(patch:Partial<Route>)=>void;guard:(prepare:PrepareLeave)=>()=>void;locked:boolean;restoreView:()=>void}
export function useLifecycle(controller:any,allowed:boolean,revision?:number){
  const canRun=useRef(allowed);canRun.current=allowed;
  // Root bootstrap lock must also invalidate requests and clear cached keys.
  // Layout effects run before paint; masking never substitutes for this lock.
  useLayoutEffect(()=>{
    if(!controller)return;
    if(!allowed)controller.setVisible(false);
    else void controller.setVisible(document.visibilityState!=='hidden');
  },[controller,allowed,revision]);
  useEffect(()=>{
    if(!controller)return;
    const hidden=()=>{if(document.visibilityState==='hidden'||!canRun.current)flushSync(()=>controller.setVisible(false));else void controller.setVisible(true);};
    const hide=()=>flushSync(()=>controller.setVisible(false));
    const show=()=>{flushSync(()=>controller.lock('VERIFY_SESSION'));if(canRun.current)void controller.setVisible(document.visibilityState!=='hidden');};
    const session=()=>{flushSync(()=>controller.lock('SESSION_CHANGED'));if(canRun.current)void controller.sessionChanged();};
    document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);
    const channel=new BroadcastChannel('projektor-session');channel.addEventListener('message',session);
    return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);channel.close();controller.dispose();};
  },[controller]);
}
export function ListView(props:ViewProps){
  const{ports,selected,route,navigate,locked}=props;
  const[state,setState]=useState<any>(null);
  const controller=useMemo(()=>{let c:any;c=new MyIssuesController({sessionAdapter:{read:(opts:any)=>ports.session(selected,opts)},transport:ports.listTransport(selected),filters:{status:route.status},onChange:(snapshot:any)=>setState({owner:c,snapshot})});return c;},[ports,selected,route.status]);
  useLifecycle(controller,!locked);
  const s=state?.owner===controller?state.snapshot:controller.snapshot();
  useEffect(()=>{if(!locked&&['ready','empty','partial'].includes(s.phase))requestAnimationFrame(props.restoreView);},[locked,s.phase,props.restoreView]);
  const visible=locked?{...s,locked:true,phase:'locked',items:[],total:null,code:'VERIFY_BOOTSTRAP'}:s;
  return <section aria-busy={visible.busy}><div className="heading"><h1 tabIndex={-1}>{route.view==='board'?'My issues board':'My Issues'}</h1><button disabled={visible.busy||locked} onClick={()=>controller.refresh()}>Refresh issues</button></div>
    <label>Show <select value={route.status} disabled={locked} onChange={e=>navigate({status:e.target.value as Route['status']})}><option value="unresolved">Unresolved</option><option value="all">All statuses</option></select></label>
    <Notice error={visible.phase==='error'}>{listMessage(visible)}</Notice>
    {['error','locked'].includes(visible.phase)&&<button disabled={locked||visible.busy} onClick={()=>controller.retry()}>Retry issue query</button>}
    <IssueRows state={visible} board={route.view==='board'} onOpen={id=>navigate({view:'issue',issueId:id,projectId:null,draftId:crypto.randomUUID(),projectAtProtection:null})}/>
    {visible.phase==='partial'&&<button disabled={visible.busy} onClick={()=>visible.code?controller.retry():controller.loadMore()}>{visible.code?'Retry next page':'Load more issues'}</button>}
    {route.view==='board'&&<p className="meta">This board groups the same My Issues page and filters. Open an issue to edit it; no drag operation is required. Counts describe loaded rows only.</p>}
  </section>;
}
const labels:Record<string,string>={title:'Title',description:'Markdown body',bodyMarkdown:'Comment Markdown',assigneeId:'Assignee principal ID',parentId:'Parent issue ID',priority:'Priority',initialStatus:'Initial status',toStatus:'New status',reason:'Reason',waitingFor:'Waiting for',nextStep:'Next step',resultSummary:'Result summary'};
export function ContentView(props:ViewProps){
  const{ports,selected,route,replace,navigate,guard,locked}=props;
  const[state,setState]=useState<any>(null);const[positionError,setPositionError]=useState(false);const[actionMessage,setActionMessage]=useState<string|null>(null);const ref=useRef<any>(null);
  const draftId=useMemo(()=>route.draftId??crypto.randomUUID(),[route.issueId,route.projectId,route.draftId]);
  const controller=useMemo(()=>{
    const api=ports.contentAPI(selected);
    const protection=ports.protection({selected,api,issueId:route.view==='issue'?route.issueId:null,projectId:route.view==='create'?route.projectId:null,draftId,projectAtProtection:route.projectAtProtection??undefined,dirty:()=>ref.current?.protectionState!=='protected',onBinding:()=>{}});
    let c:any;c=new IssueContentController({api,protection,issueId:route.view==='issue'?route.issueId:null,projectId:route.view==='create'?route.projectId:null,onChange:(snapshot:any)=>setState({owner:c,snapshot})});return c;
  },[ports,selected,route.issueId,route.projectId,draftId]);
  ref.current=controller;
  // Preserve the opaque draft ID and original scope across reload. Never put text
  // or credentials in the URL. Scope binding comes from the verified core adapter.
  useEffect(()=>{if(!route.draftId)replace({draftId});},[draftId]);
  useLifecycle(controller,!locked);
  useEffect(()=>guard(async()=>{
    if(!controller.record)return true;
    const binding=controller.protection?.binding;
    if(route.draftId!==draftId||binding?.projectAtProtection&&route.projectAtProtection!==binding.projectAtProtection)return false;
    if(controller.locked&&controller.protectionState==='protected')return true;
    const result=await controller.flush();
    return result.kind==='protected'&&controller.protectionState==='protected';
  }),[controller,guard,route.draftId,route.projectAtProtection,draftId]);
  useEffect(()=>{
    const before=(event:BeforeUnloadEvent)=>{
      const record=controller.record;if(record&&(Object.values(record.drafts).some((d:any)=>d.revision>d.ack)||record.journal&&!['committed','rejected'].includes(record.journal.state))){event.preventDefault();event.returnValue='';}
    };
    window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);
  },[controller]);
  const s=state?.owner===controller?state.snapshot:controller.snapshot();const isLocked=locked||s.locked;
  useEffect(()=>{
    const binding=controller.protection?.binding;
    if(binding?.projectAtProtection&&route.projectAtProtection!==binding.projectAtProtection)replace({projectAtProtection:binding.projectAtProtection});
  },[s,route.projectAtProtection]);
  const wasLocked=useRef(true);
  const focusBinding=selected.principal.id+':'+selected.workspace.id+':'+draftId;
  useLayoutEffect(()=>{
    if(isLocked){wasLocked.current=true;return;}
    if(!wasLocked.current)return;wasLocked.current=false;
    const saved=window.history.state?.editorPosition;
    if(saved?.binding!==focusBinding||saved.mode!==s.record?.active||typeof saved.field!=='string')return;
    const field=[...document.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-editor-field]')].find(e=>e.dataset.editorField===saved.field);
    if(field&&Number.isSafeInteger(saved.start)&&Number.isSafeInteger(saved.end)){
      field.focus({preventScroll:true});field.setSelectionRange(Math.max(0,saved.start),Math.max(0,saved.end));
      if(Number.isFinite(saved.scrollTop))field.scrollTop=Math.max(0,saved.scrollTop);
    }
  },[isLocked,focusBinding,s.record?.active]);
  const capturePosition=(field:HTMLInputElement|HTMLTextAreaElement,key:string)=>{
    // Position metadata only. Body text and credentials stay in DraftVault.
    try{window.history.replaceState({...window.history.state,editorPosition:{binding:focusBinding,mode:s.record?.active,field:key,start:field.selectionStart,end:field.selectionEnd,scrollTop:field.scrollTop}},'');setPositionError(false);}catch{setPositionError(true);}
  };
  const draft=!isLocked?s.record?.drafts[s.record.active]:null;
  const runAction=async(action:()=>Promise<any>)=>{setActionMessage(null);try{setActionMessage(actionResultText(await action()));}catch{setActionMessage('Action unavailable. Keep this page open; check any existing operation before retrying');}};
  const journal=s.record?.journal;const unresolved=journal&&!['committed','rejected'].includes(journal.state);
  const created=route.view==='create'&&journal?.state==='committed'&&journal.command?.commandType==='Issue.Create';
  return <section aria-busy={s.busy}><h1 tabIndex={-1}>{route.view==='create'?'Create issue':isLocked?'Issue':s.issue?.title??'Issue'}</h1>
    <Notice error={['rejected','conflict'].includes(s.phase)}>{locked?'Editor locked · VERIFY_BOOTSTRAP':editorMessage(s)}</Notice>
    {actionMessage&&<Notice error>{actionMessage}</Notice>}
    {positionError&&<Notice error>Cursor position could not be retained. Text protection is reported separately above.</Notice>}
    <button disabled={locked||s.busy} onClick={()=>controller.revalidate()}>Verify session and reload current data</button>
    {!isLocked&&<>
      {s.issue&&<article className="current"><h2>Current saved issue</h2><p className="meta">v{s.issue.version} · {s.issue.status} · {s.issue.priority??'No priority'} · Assignee {s.issue.assigneeId??'Unassigned'}{s.issue.assigneeKind==='machine'?' · Agent':''}</p><pre>{s.issue.description}</pre>
      {route.view==='create'&&<button onClick={()=>navigate({view:'issue',issueId:s.issue.id,projectId:null,draftId:crypto.randomUUID(),projectAtProtection:null})}>Open created issue</button>}</article>}
      <div className="editor">
        <label>Editor<select aria-label="Editor" value={s.record.active} onChange={e=>{const[mode,id]=e.target.value.split(':');controller.select(mode,id);}}>
          {(route.view==='create'?[['create','Create issue']]:[['title','Issue title'],['body','Issue body'],['add-comment','New comment'],['assign','Assignee'],['priority','Priority'],['progress','Progress update'],['transition','Status transition'],...(s.issue?.canManageAccess?[['access','Resource access']]:[])]).map(([value,label])=><option value={value} key={value}>{label}</option>)}
          {Object.keys(s.record.drafts).filter(k=>k.startsWith('edit-comment:')).map(k=><option key={k} value={k}>Edit comment {k.slice(13)}</option>)}
        </select></label>
        {draft&&Object.entries(draft.value).filter(([key])=>!['projectId','resource','expectedPolicyVersion'].includes(key)).map(([key,value]:[string,any])=>{
          const change=(next:string)=>{let v:any=next;if(['priority','assigneeId','parentId'].includes(key)&&next==='')v=null;if(['description','bodyMarkdown','reason','waitingFor','nextStep','resultSummary'].includes(key))v=preserveMarkdownInput(draft.value[key],next);controller.edit({[key]:v});};
          const label=key==='bodyMarkdown'&&draft.mode==='progress'?'Progress Markdown':labels[key]??key;
          return <label key={s.record.active+key}>{label}{key==='policy'?<textarea aria-label="Access policy JSON" value={draft.rawJSON?.policy??JSON.stringify(value)} aria-invalid={!!draft.rawJSONErrors?.policy} onChange={e=>controller.editAccessPolicy(e.target.value)}/>:['description','bodyMarkdown','reason','waitingFor','nextStep','resultSummary'].includes(key)?
            <textarea rows={12} data-editor-field={key} onSelect={e=>capturePosition(e.currentTarget,key)} aria-label={label} value={(value??'').replace(/\r\n?/g,'\n')} onChange={e=>change(e.target.value)} spellCheck={false}/>:
            ['priority','initialStatus','toStatus'].includes(key)?<select aria-label={label} value={value??''} onChange={e=>change(e.target.value)}>{(key==='priority'?['','P0','P1','P2','P3','P4']:key==='toStatus'?states:['backlog','ready']).map(v=><option value={v} key={v}>{v||'No priority'}</option>)}</select>:
            <input data-editor-field={key} onSelect={e=>capturePosition(e.currentTarget,key)} aria-label={label} value={value??''} onChange={e=>change(e.target.value)} autoComplete="off"/>}</label>;
        })}
        {s.issue?.accessManagementError&&<Notice error>Access management for this issue requires policy identity migration; no policy identity was created automatically</Notice>}{draft?.mode==='access'&&<Notice>Resource and policy versions are checked together; historical audiences stay unchanged</Notice>}{s.code&&<p id="field-error" className="error">Validation or operation code: {s.code}. Your input is retained.</p>}
        <div className="actions"><button disabled={s.busy||!!unresolved||created} onClick={()=>runAction(()=>controller.save())}>Save</button>
          {unresolved&&<><button disabled={s.busy} onClick={()=>runAction(()=>controller.checkResult())}>Check existing operation</button><button disabled={s.busy} onClick={()=>runAction(()=>controller.checkResult({retry:true}))}>Retry the same protected request</button></>}
          {draft?.conflict&&<button disabled={s.busy} onClick={()=>controller.useCurrentVersion()}>Keep my draft and use current version</button>}
        </div>
        {created&&<Notice>Issue creation is confirmed. This draft cannot create a second issue. Newer unsent input remains here; open the created issue to continue editing.</Notice>}
        <p className="meta">Input stays separate from the sent snapshot. Save does not follow redirects or automatically resend a new operation.</p>
      </div>
      {route.view==='issue'&&<>
        <section aria-label="Workflow"><h2>Status and progress</h2><p>Choose Status transition or Progress update in the editor. Done requires a result summary. Blocked requires a reason and waiting-for or next-step text. Cancel and reopen require a reason. The service validates the complete transition atomically.</p><p className="meta">Human edits do not claim Agent work. Artifact result selection is not connected yet; results here use a written summary.</p></section>
        <h2>Comments and activity</h2><EntryList entries={s.entries} onEdit={id=>{controller.select('edit-comment',id);requestAnimationFrame(()=>document.querySelector<HTMLSelectElement>('[aria-label="Editor"]')?.focus());}}/>
        {s.entriesCursor&&<button onClick={()=>controller.loadMoreEntries()} disabled={s.busy}>Load more comments</button>}
        <h2>History</h2><button disabled={s.busy} onClick={()=>controller.loadHistory()}>Load authorized history</button><History state={s}/>{s.historyCursor&&<button disabled={s.busy} onClick={()=>controller.loadHistory(undefined,{more:true})}>Load more history</button>}
        <h2>Artifacts</h2><Notice>Product connection incomplete: artifact metadata and download UI are awaiting the owner’s explicit adapter.</Notice>
      </>}
    </>}
  </section>;
}
export function ProjectPicker({ports,selected,navigate,locked,accessRevision,wiki=false}:{ports:ProductPorts;selected:Selected;navigate:(patch:Partial<Route>)=>void;locked:boolean;accessRevision:number;wiki?:boolean}){
  const[state,setState]=useState<any>({phase:'loading',items:[],binding:null});
  const binding=selected.principal.id+':'+selected.workspace.id+':'+selected.workspace.epoch+':'+accessRevision;
  useEffect(()=>{
    let alive=true;const abort=new AbortController();
    setState({phase:'loading',items:[],binding});
    if(!locked)(async()=>{try{
      const session=await ports.session(selected,{signal:abort.signal});
      if(!alive)return;
      const body=await ports.contentAPI(selected).projects({session,signal:abort.signal});
      if(body.meta?.workspaceId!==selected.workspace.id||body.meta?.actorId!==selected.principal.id||body.meta?.workspaceEpoch!==undefined&&body.meta.workspaceEpoch!==selected.workspace.epoch||!Array.isArray(body.data?.items)||body.data.items.some((p:any)=>!isID(p.id)||typeof p.title!=='string')||new Set(body.data.items.map((p:any)=>p.id)).size!==body.data.items.length)throw new Error('BINDING_MISMATCH');
      if(alive&&!abort.signal.aborted)setState({phase:'ready',items:body.data.items,binding});
    }catch(e:any){if(alive&&!abort.signal.aborted)setState({phase:'error',items:[],code:e.code??e.message,binding});}})();
    return()=>{alive=false;abort.abort();};
  },[ports,selected,locked,binding]);
  if(locked)return null;
  const current=state.binding===binding?state:{phase:'loading',items:[]};
  return <section><h2>Create in a project</h2>{current.phase==='loading'?<Notice>Loading projects…</Notice>:current.phase==='error'?<Notice error>Projects unavailable · {current.code}</Notice>:current.items.length===0?<Notice>No readable projects</Notice>:<ul>{current.items.map((p:any)=><li key={p.id}><button onClick={()=>{const id=crypto.randomUUID();navigate(wiki?{view:'wiki-create',projectId:null,issueId:null,pageId:id,draftId:id,wikiProtectionScope:'project',projectAtProtection:p.id}:{view:'create',projectId:p.id,issueId:null,draftId:id,projectAtProtection:null});}}>Create {wiki?'Wiki page':'issue'} in {p.title}</button></li>)}</ul>}</section>;
}
