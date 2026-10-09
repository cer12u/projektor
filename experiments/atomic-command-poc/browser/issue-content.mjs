import {IssueContentController,createContentAPI,contentJSON,validateContentSession,validateContentIssue} from '../client/issue-content.mjs';
import {DraftVault,canonical} from './draft-vault.mjs';
const copy=value=>structuredClone(value);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Textarea exposes LF even when its source is CRLF. Preserve untouched raw
 * runs and use the existing line-ending style only for inserted line breaks. */
export function preserveMarkdownInput(raw, displayed) {
  const normalized=raw.replace(/\r\n?/g,'\n');
  if(normalized===displayed)return raw;
  let prefix=0,suffix=0;
  while(prefix<normalized.length&&prefix<displayed.length&&normalized[prefix]===displayed[prefix])prefix++;
  while(suffix<normalized.length-prefix&&suffix<displayed.length-prefix&&normalized[normalized.length-1-suffix]===displayed[displayed.length-1-suffix])suffix++;
  const offset=target=>{let input=0,output=0;while(output<target){if(raw[input]==='\r'&&raw[input+1]==='\n')input++;input++;output++;}return input;};
  const ending=raw.match(/\r\n|\r|\n/)?.[0]??'\n';
  const inserted=displayed.slice(prefix,displayed.length-suffix).replace(/\n/g,ending);
  return raw.slice(0,offset(prefix))+inserted+raw.slice(offset(normalized.length-suffix));
}

export function createContentProtection({api,issueId,projectId,draftId,projectAtProtection,dbName,fault=()=>null,onBinding=()=>{},dirty=()=>false}) {
  let binding=null,branchConflict=false;
  const vault=new DraftVault({dbName,fault,keyProvider:(binding,keyId)=>contentJSON(fetch,new URL('/v1/draft-keys',location.origin),{method:'POST',body:{binding,...(keyId?{keyId}:{})}})});
  async function ensure(session,guard) {
    if(binding)return;
    let project=projectId??projectAtProtection;
    if(!project){const body=await api.issue({session,issueId});if(!guard())throw Error('STALE_CONTEXT');project=validateContentIssue(body,session,issueId).project_id;}
    if(!guard())throw Error('STALE_CONTEXT');
    binding={principalId:session.principalId,workspaceId:session.workspaceId,workspaceEpoch:session.workspaceEpoch,resourceType:projectId?'project':'issue',resourceId:projectId??issueId,editorId:projectId?'issue-create':'content',projectAtProtection:project,draftId};
    onBinding(copy(binding));
  }
  return {
    vault,
    get binding(){return binding&&copy(binding);},
    lock(){vault.clearKeys();},
    async restore(session,guard){
      if(branchConflict)throw Error('DRAFT_WRITE_CONFLICT');
      await ensure(session,guard);
      if(await vault.tombstoned(session.sessionId))throw Error('SESSION_TOMBSTONED');
      const oldHead=vault.heads.get(canonical(binding));
      const stored=await vault.restore(binding,session,guard);
      if(oldHead!==undefined&&oldHead!==vault.heads.get(canonical(binding))&&dirty()){branchConflict=true;throw Error('DRAFT_WRITE_CONFLICT');}
      return stored;
    },
    async unlock(session,guard){await ensure(session,guard);await vault.key(binding,null,session,{fresh:true});if(!guard())throw Error('STALE_CONTEXT');},
    persist(record,session,guard){if(branchConflict||!binding)throw Error('DRAFT_WRITE_CONFLICT');return vault.persist(binding,record,session,guard);},
    expiresAt(){return binding?vault.keys.get(canonical(binding))?.leaseExpiresAt:0;},
  };
}

const modeLabels={create:'Create issue',body:'Issue body','add-comment':'New comment','edit-comment':'Edit comment',assign:'Assignee',priority:'Priority'};
const labels={title:'Title',description:'Markdown body',bodyMarkdown:'Comment Markdown',assigneeId:'Assignee principal ID',parentId:'Parent issue ID',priority:'Priority',initialStatus:'Initial status'};
const phaseText=state=>{
  if(state.locked)return `Editor locked · ${state.code}. Verify your session to continue.`;
  if(state.phase==='refresh-required')return 'The result is confirmed, but current issue data could not be refreshed. Verify your session to reload.';
  if(state.phase==='conflict')return 'Version conflict. Your draft is retained. Compare the current text before explicitly using its version.';
  if(state.phase==='committed')return state.record?.journal?.effectApplied===false?'No change was needed. Current data checked.':'Saved. Current data checked.';
  if(['unknown','ambiguous'].includes(state.phase))return 'Save outcome unknown. Check the existing operation before retrying the same saved request.';
  if(state.phase==='rejected')return `Save rejected: ${state.code}. Your draft is retained.`;
  return `${state.busy?'Checking…':state.phase==='editing'?'Unsaved changes':'Ready'} · ${state.protection}${state.code?` · ${state.code}`:''}`;
};

export function mountIssueContent({root=document.querySelector('[data-content]'),api=createContentAPI(),issueId=null,projectId=null,draftId=crypto.randomUUID(),projectAtProtection,dbName='projektor-content-v1',fault=()=>null}={}) {
  if(!root||!UUID.test(draftId))throw Error('VIEW_REQUIRED');
  const doc=root.ownerDocument,win=doc.defaultView;
  const status=root.querySelector('[data-status]'),fields=root.querySelector('[data-fields]'),select=root.querySelector('[data-editor]'),save=root.querySelector('[data-save]'),check=root.querySelector('[data-check]'),retry=root.querySelector('[data-retry]'),rebase=root.querySelector('[data-rebase]'),verify=root.querySelector('[data-verify]'),current=root.querySelector('[data-current]'),comments=root.querySelector('[data-comments]'),history=root.querySelector('[data-history]'),historyButton=root.querySelector('[data-load-history]');
  let controller,renderedKey=null;
  const protection=createContentProtection({api,issueId,projectId,draftId,projectAtProtection,dbName,fault,dirty:()=>controller?.protectionState!=='protected',onBinding:binding=>{
    const url=new URL(win.location.href);url.searchParams.set('draftId',draftId);url.searchParams.set('projectAtProtection',binding.projectAtProtection);win.history.replaceState(null,'',url);
  }});
  const render=state=>{
    root.setAttribute('aria-busy',String(state.busy));status.textContent=phaseText(state);status.dataset.phase=state.phase;
    select.disabled=state.locked;save.disabled=state.locked||state.busy||!!state.record?.journal&&!['committed','rejected'].includes(state.record.journal.state);
    check.disabled=retry.disabled=state.locked||state.busy||!state.record?.journal||['committed','rejected'].includes(state.record.journal.state);
    verify.disabled=state.busy;historyButton.disabled=state.locked||state.busy||!issueId;
    rebase.hidden=state.locked||!state.record?.drafts[state.record.active]?.conflict;rebase.disabled=state.busy;
    if(state.locked){fields.replaceChildren();current.replaceChildren();comments.replaceChildren();history.replaceChildren();select.replaceChildren();renderedKey=null;return;}
    root.querySelector('[data-more-comments]').hidden=!state.entriesCursor;root.querySelector('[data-more-history]').hidden=!state.historyCursor;
    const record=state.record,draft=record.drafts[record.active];
    const selections=projectId?['create']:['body','add-comment','assign','priority'];
    const selectedComments=Object.keys(record.drafts).filter(key=>key.startsWith('edit-comment:'));
    select.replaceChildren(...[...selections,...selectedComments].map(key=>{const option=doc.createElement('option');option.value=key;option.textContent=key.startsWith('edit-comment:')?`Edit comment ${key.slice(13)}`:modeLabels[key];return option;}));select.value=record.active;
    if(renderedKey!==record.active){
      fields.replaceChildren();renderedKey=record.active;
      for(const [key,value]of Object.entries(draft.value)){
        if(key==='projectId')continue;
        const label=doc.createElement('label');label.textContent=labels[key]??key;
        let input;
        if(['priority','initialStatus'].includes(key)){
          input=doc.createElement('select');
          for(const [value,text]of key==='priority'?[['','No priority'],...['P0','P1','P2','P3','P4'].map(v=>[v,v])]:[['backlog','Backlog'],['ready','Ready']]){const option=doc.createElement('option');option.value=value;option.textContent=text;input.append(option);}
        }else{input=doc.createElement(['description','bodyMarkdown'].includes(key)?'textarea':'input');if(input.tagName==='TEXTAREA'){input.rows=12;input.spellcheck=false;}else input.type='text';}
        input.dataset.field=key;input.setAttribute('aria-label',labels[key]??key);label.append(input);fields.append(label);
        input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{
          const draft=controller.record?.drafts[controller.record.active];if(!draft)return;
          let value=input.value;
          if(['assigneeId','parentId','priority'].includes(key)&&value==='')value=null;
          if(['description','bodyMarkdown'].includes(key))value=preserveMarkdownInput(draft.value[key],value);
          controller.edit({[key]:value});
        });
      }
    }
    for(const input of fields.querySelectorAll('[data-field]')){const value=draft.value[input.dataset.field]??'';const display=input.tagName==='TEXTAREA'?value.replace(/\r\n?/g,'\n'):value;if(input.value!==display)input.value=value;input.disabled=false;}
    const currentFragment=doc.createDocumentFragment();
    if(state.issue){
      const title=doc.createElement('h2');title.textContent=state.issue.title;
      const meta=doc.createElement('p');meta.textContent=`Issue ${state.issue.id} · v${state.issue.version} · ${state.issue.status} · ${state.issue.priority??'No priority'} · Assignee ${state.issue.assigneeId??'None'}`;
      const body=doc.createElement('pre');body.dataset.currentBody='';body.textContent=state.issue.description;
      currentFragment.append(title,meta,body);
      if(projectId){const link=doc.createElement('a');link.textContent='Open created issue';link.href=`/browser/issue-content.html?issueId=${encodeURIComponent(state.issue.id)}`;currentFragment.append(link);}
    }else if(projectId){const hint=doc.createElement('p');hint.textContent=`Create in project ${projectId}`;currentFragment.append(hint);}
    current.replaceChildren(currentFragment);
    comments.replaceChildren(...state.entries.map(entry=>{
      const item=doc.createElement('li'),meta=doc.createElement('p'),text=doc.createElement('pre');
      meta.textContent=`${entry.kind} ${entry.id} · v${entry.version} · Original author ${entry.authorRef?.principalId??entry.authorRef?.sourceAuthorId??'unknown'}`;text.textContent=entry.bodyMarkdown??'';item.append(meta,text);
      if(entry.kind==='comment'){const button=doc.createElement('button');button.type='button';button.textContent='Edit comment';button.dataset.commentId=entry.id;button.addEventListener('click',()=>controller.select('edit-comment',entry.id));item.append(button);}return item;
    }));
    history.replaceChildren(...state.history.map(revision=>{
      const row=doc.createElement('details'),summary=doc.createElement('summary'),text=doc.createElement('pre');
      summary.textContent=`${revision.contentKind} · ${revision.id} · resource v${revision.resourceVersionAtCommit} · original author ${revision.originalAuthorRef?.principalId??revision.originalAuthorRef?.sourceAuthorId??'unknown'} · ${revision.occurredAtRaw??'time unknown'}`;
      text.textContent=revision.contentMarkdown;row.append(summary,text);return row;
    }));
    if(state.historyCode){const note=doc.createElement('p');note.textContent=`History unavailable: ${state.historyCode}. Current content is not a historical substitute.`;history.append(note);}
  };
  controller=new IssueContentController({api,protection,issueId,projectId,onChange:render});
  const moreComments=root.querySelector('[data-more-comments]'),moreHistory=root.querySelector('[data-more-history]');
  const handlers=[
    [moreComments,'click',()=>void controller.loadMoreEntries()],[moreHistory,'click',()=>void controller.loadHistory(undefined,{more:true})],
    [save,'click',()=>void controller.save()], [check,'click',()=>void controller.checkResult()], [retry,'click',()=>void controller.checkResult({retry:true})], [verify,'click',()=>void controller.revalidate()],
    [rebase,'click',()=>controller.useCurrentVersion()], [historyButton,'click',()=>void controller.loadHistory()],
    [select,'change',()=>{const [mode,commentId]=select.value.split(':');controller.select(mode,commentId);}],
    [doc,'visibilitychange',()=>void controller.setVisible(doc.visibilityState!=='hidden')],
    [win,'pagehide',()=>controller.setVisible(false)], [win,'pageshow',()=>void controller.setVisible(doc.visibilityState!=='hidden')],
    [win,'beforeunload',event=>{const record=controller.record;if(record&&(Object.values(record.drafts).some(d=>d.revision>d.ack)||record.journal&&!['committed','rejected'].includes(record.journal.state))){event.preventDefault();event.returnValue='';}}],
  ];
  for(const[target,type,listener]of handlers)target.addEventListener(type,listener);
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('projektor-session'):null;channel?.addEventListener('message',()=>void controller.sessionChanged());
  const dispose=controller.dispose.bind(controller);controller.dispose=()=>{for(const[target,type,listener]of handlers)target.removeEventListener(type,listener);channel?.close();dispose();};
  controller.protectionAdapter=protection;
  render(controller.snapshot());void controller.setVisible(doc.visibilityState!=='hidden');return controller;
}

async function landing(root,api) {
  const status=root.querySelector('[data-status]'),picker=root.querySelector('[data-projects]');
  try {
    const session=validateContentSession(await api.session()),result=await api.projects({session});
    if(result.meta?.workspaceId!==session.workspaceId||result.meta?.actorId!==session.principalId||!Array.isArray(result.data?.items))throw Error('PROTOCOL_ERROR');
    for(const project of result.data.items){if(!UUID.test(project.id)||typeof project.title!=='string')throw Error('PROTOCOL_ERROR');const item=document.createElement('li'),link=document.createElement('a');link.href=`/browser/issue-content.html?projectId=${encodeURIComponent(project.id)}`;link.textContent=`Create issue in ${project.title}`;item.append(link);picker.append(item);}
    status.textContent=result.data.items.length?'Choose a project to create an issue, or open one from My Issues.':'No readable projects are available.';
  }catch(error){picker.replaceChildren();status.textContent=`Projects unavailable: ${error.code??error.message}`;}
}

if(typeof document!=='undefined'&&document.querySelector('[data-content]')){
  window.startContent=options=>{window.contentApp?.dispose();window.contentApp=mountIssueContent({...options,fault:()=>window.testFault});return window.contentApp;};
  const params=new URL(location.href).searchParams,issueId=params.get('issueId'),projectId=params.get('projectId');
  if(issueId||projectId){try{window.startContent({issueId,projectId,draftId:params.get('draftId')??crypto.randomUUID(),projectAtProtection:params.get('projectAtProtection')??undefined});}catch(error){document.querySelector('[data-status]').textContent=`Editor unavailable: ${error.message}`;}}
  else void landing(document.querySelector('[data-content]'),createContentAPI());
}
