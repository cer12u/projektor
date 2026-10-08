/** Issue content editor state machine. Server sessions and protected persistence
 * are injected; no credential storage, auth provider, HTML renderer or retry loop.
 * A receipt confirms one snapshot, never the current Issue representation. */
import {createFetchTransport, boundedAttempt} from './recovery.mjs';
const copy = value => structuredClone(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && UUID.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, status) => Object.assign(Error(code), {code, status});
const naturalVersion = value => Number.isSafeInteger(value) && value > 0;
const terminal = journal => journal && ['committed', 'rejected'].includes(journal.state);
const canon = value => JSON.stringify(value);
const denied = code => ['AUTH_REQUIRED','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','PROJECT_NOT_FOUND','EPOCH_MISMATCH','WORKSPACE_MISMATCH','BINDING_MISMATCH'].includes(code);
const modes = new Set(['create','body','add-comment','edit-comment','assign','priority']);
const priority = value => value === null || /^P[0-4]$/.test(value);
const string = value => typeof value === 'string' && value.isWellFormed();
const markdown = value => string(value) && new TextEncoder().encode(value).byteLength <= 256 * 1024;

export function validateContentSession(value, now = Date.now()) {
  if (!object(value) || !['principalId','workspaceId','workspaceEpoch','sessionId'].every(key => id(value[key])) || value.actorKind !== 'human' || !integer(value.authzVersion) || !integer(value.expiresAt) || !Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string')) throw fail('PROTOCOL_ERROR');
  if (value.expiresAt <= now) throw fail('AUTH_REQUIRED', 401);
  return copy(Object.fromEntries(['principalId','workspaceId','workspaceEpoch','sessionId','actorKind','authzVersion','expiresAt','scopes'].map(key => [key, value[key]])));
}

/** Bounded same-origin JSON read, including body streaming. Never follows a login redirect. */
export async function contentJSON(fetchImpl, url, {signal, deadlineMs = 8000, method = 'GET', body} = {}) {
  const result = await boundedAttempt(async attemptSignal => {
    const response = await fetchImpl(url, {method, ...(body === undefined ? {} : {body: JSON.stringify(body)}), credentials:'same-origin', redirect:'manual', cache:'no-store', signal:attemptSignal,
      headers:{Accept:'application/json', ...(method === 'POST' ? {'Content-Type':'application/json','X-Projektor-Csrf':'same-origin'} : {})}});
    if (response.status === 401) return {error: fail('AUTH_REQUIRED', 401)};
    if (response.status === 403) return {error: fail('FORBIDDEN', 403)};
    if (response.status === 404) return {error: fail('NOT_FOUND', 404)};
    if (response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return {error: fail('PROTOCOL_ERROR', response.status)};
    const reader = response.body?.getReader();
    if (!reader) return {error: fail('PROTOCOL_ERROR')};
    let bytes = 0, raw = '';
    const decoder = new TextDecoder('utf-8', {fatal:true});
    try {
      for (;;) {
        const {done, value} = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) {void reader.cancel().catch(() => {}); return {error: fail('PROTOCOL_ERROR')};}
        raw += decoder.decode(value, {stream:true});
      }
      raw += decoder.decode();
      let value; try {value = JSON.parse(raw);} catch {return {error: fail('PROTOCOL_ERROR')};}
      if (!response.ok || value.error) return {error: fail(value.error?.code ?? 'SERVER_UNAVAILABLE', response.status)};
      return {value};
    } finally {reader.releaseLock();}
  }, deadlineMs, signal);
  if (result.error) throw result.error;
  if (!Object.hasOwn(result, 'value')) throw fail(result.code ?? 'NETWORK_ERROR');
  return result.value;
}

export function createContentAPI({baseUrl = globalThis.location?.origin, fetchImpl = globalThis.fetch, deadlineMs = 8000} = {}) {
  const base = new URL(baseUrl);
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || globalThis.location && globalThis.location.origin !== base.origin) throw fail('CROSS_ORIGIN_ENDPOINT');
  const read = (path, options) => contentJSON(fetchImpl, new URL(path, base.origin), {deadlineMs, ...options});
  const url = (session, path) => `/v1/workspaces/${encodeURIComponent(session.workspaceId)}/${path}?workspaceEpoch=${encodeURIComponent(session.workspaceEpoch)}`;
  return {
    session: options => read('/v1/session', options),
    projects: ({session, signal}) => read(url(session, 'projects'), {signal}),
    project: ({session, projectId, signal}) => read(url(session, `projects/${encodeURIComponent(projectId)}`), {signal}),
    issue: ({session, issueId, signal}) => read(url(session, `issues/${encodeURIComponent(issueId)}`), {signal}),
    entries: ({session, issueId, cursor, signal}) => read(url(session, `issues/${encodeURIComponent(issueId)}/entries`)+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''), {signal}),
    revisions: ({session, issueId, revisionId, cursor, signal}) => read(url(session, `issues/${encodeURIComponent(issueId)}/revisions${revisionId ? `/${encodeURIComponent(revisionId)}` : ''}`)+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''), {signal}),
    transport: createFetchTransport({baseUrl:base.origin, fetchImpl, prefix:'/v1', getToken:() => null}),
  };
}

function boundData(body, session) {
  if (!object(body?.data) || !object(body.meta) || body.meta.workspaceId !== session.workspaceId || body.meta.actorId !== session.principalId) throw fail('BINDING_MISMATCH');
  if (body.meta.workspaceEpoch !== undefined && body.meta.workspaceEpoch !== session.workspaceEpoch) throw fail('EPOCH_MISMATCH');
  return body.data;
}
export function validateContentIssue(body, session, issueId) {
  const value = boundData(body, session);
  if (value.id !== issueId || !id(value.project_id) || !naturalVersion(value.version) || !string(value.title) || !markdown(value.description) || !priority(value.priority) || value.assigneeId !== null && !id(value.assigneeId)) throw fail('PROTOCOL_ERROR');
  return copy(value);
}
export function validateContentEntries(body, session, issueId) {
  const value = boundData(body, session);
  if (!Array.isArray(value.items) || value.items.some(item => !object(item) || !id(item.id) || item.issueId !== issueId || !['comment','progress','transition'].includes(item.kind) || !naturalVersion(item.version) || item.kind === 'comment' && !markdown(item.bodyMarkdown)) || new Set(value.items.map(item => item.id)).size !== value.items.length) throw fail('PROTOCOL_ERROR');
  return copy(value.items);
}

/** Every editable draft stays separate. Selecting a comment never overwrites an
 * unsaved body or another comment. One journal serializes writes for this page. */
export class IssueContentController {
  constructor({api, protection, issueId = null, projectId = null, onChange = () => {}, uuid = () => crypto.randomUUID(), now = Date.now} = {}) {
    if (!api?.session || !api?.transport || !protection?.restore || !protection?.persist || !protection?.unlock || !protection?.lock || (!!issueId === !!projectId) || issueId && !id(issueId) || projectId && !id(projectId)) throw fail('CONFIGURATION_REQUIRED');
    this.api=api; this.protection=protection; this.issueId=issueId; this.projectId=projectId; this.onChange=onChange; this.uuid=uuid; this.now=now;
    this.generation=0; this.locked=true; this.phase='locked'; this.code='VERIFY_SESSION'; this.record=null; this.session=null; this.identity=null; this.issue=null; this.entries=[]; this.entriesCursor=null;this.historyCursor=null;this.history=[]; this.historyCode=null; this.busy=false; this.disposed=false; this.visible=true; this.protectionState='unavailable';
  }
  snapshot() {return copy({locked:this.locked,busy:this.busy,phase:this.phase,code:this.code,protection:this.protectionState,issue:this.locked?null:this.issue,entries:this.locked?[]:this.entries,history:this.locked?[]:this.history,historyCode:this.locked?null:this.historyCode,entriesCursor:this.locked?null:this.entriesCursor,historyCursor:this.locked?null:this.historyCursor,record:this.locked?null:this.record,projectId:this.projectId});}
  emit() {this.onChange(this.snapshot());}
  current(generation) {return !this.disposed && this.visible && this.generation===generation && this.session && this.session.expiresAt>this.now();}
  lock(code='VERIFY_SESSION', {erase=false}={}) {
    this.generation++; clearTimeout(this.leaseTimer); clearTimeout(this.flushTimer); this.abort?.abort(); this.abort=null; this.protection.lock(); this.locked=true; this.busy=false; this.phase='locked'; this.code=code; this.issue=null; this.entries=[]; this.entriesCursor=null;this.historyCursor=null;this.history=[]; this.historyCode=null;
    if (erase) {this.record=null; this.session=null;}
    this.emit(); return {kind:'locked',code};
  }
  setVisible(visible) {this.visible=!!visible; return visible ? this.revalidate() : this.lock('HIDDEN');}
  sessionChanged() {this.lock('SESSION_CHANGED'); return this.visible ? this.revalidate() : Promise.resolve({kind:'stopped'});}
  dispose() {this.disposed=true;this.lock('DISPOSED',{erase:true});}
  touch() {this.record.revision++;this.protectionState='memory-dirty';}
  draftKey(mode, commentId) {return mode==='edit-comment' ? `${mode}:${commentId}` : mode;}
  initial(mode, commentId) {
    const version=this.issue?.version ?? 0;
    if (mode==='create') return {value:{projectId:this.projectId,title:'',description:'',assigneeId:null,priority:null,parentId:null,initialStatus:'backlog'},baseVersion:0};
    if (mode==='body') return {value:{description:this.issue.description},baseVersion:version};
    if (mode==='assign') return {value:{assigneeId:this.issue.assigneeId},baseVersion:version};
    if (mode==='priority') return {value:{priority:this.issue.priority},baseVersion:version};
    if (mode==='add-comment') return {value:{bodyMarkdown:''},baseVersion:version};
    const entry=this.entries.find(item=>item.id===commentId && item.kind==='comment');
    if (!entry) throw fail('COMMENT_NOT_FOUND');
    return {value:{bodyMarkdown:entry.bodyMarkdown},baseVersion:entry.version,commentId};
  }
  select(mode, commentId) {
    if (this.locked || !modes.has(mode) || (this.projectId ? mode!=='create' : mode==='create') || mode==='edit-comment' && !id(commentId)) return {kind:'stopped'};
    const key=this.draftKey(mode,commentId);
    if (!this.record.drafts[key]) this.record.drafts[key]={mode,...this.initial(mode,commentId),revision:0,ack:0};
    this.record.active=key; this.touch(); this.emit(); this.scheduleFlush(); return {kind:'selected'};
  }
  edit(patch) {
    if (this.locked || !object(patch)) return {kind:'stopped'};
    const draft=this.record.drafts[this.record.active];
    if (Object.keys(patch).some(key=>!Object.hasOwn(draft.value,key))) return {kind:'invalid'};
    draft.value={...draft.value,...copy(patch)}; draft.revision++; this.touch(); this.phase='editing';this.code=null; this.emit(); this.scheduleFlush(); return {kind:'edited'};
  }
  scheduleFlush() {clearTimeout(this.flushTimer);this.flushTimer=setTimeout(()=>void this.flush(),150);this.flushTimer.unref?.();}
  async flush() {
    clearTimeout(this.flushTimer);
    if (!this.record || !this.session || this.quarantined) return {kind:'protection-failed'};
    const generation=this.generation, record=copy(this.record), session=copy(this.session);
    const result=await boundedAttempt(async()=>{await this.protection.persist(record,session,()=>this.current(generation));return {kind:'protected'};},3500);
    if (!this.current(generation)) return {kind:'stale'};
    if (result.kind==='protected') this.protectionState=canon(record)===canon(this.record)?'protected':'memory-dirty';
    else {this.protectionState='protection-failed';this.code=result.code??'PROTECTION_FAILED';}
    this.emit();return result.kind==='protected'?{kind:'protected'}:{kind:'protection-failed',code:this.code};
  }
  async readCurrent(generation) {
    const session=copy(this.session), signal=this.abort?.signal;
    if (this.projectId) {
      const body=await this.api.project({session,projectId:this.projectId,signal});
      if (!this.current(generation)) return false;
      const data=boundData(body,session); if (data.id!==this.projectId) throw fail('BINDING_MISMATCH');
      const committed=this.record?.journal?.state==='committed' && this.record.journal.command.commandType==='Issue.Create';
      if (committed) {
        const createdId=this.record.journal.command.entityId;
        const issue=await this.api.issue({session,issueId:createdId,signal});
        if (!this.current(generation)) return false;
        this.issue=validateContentIssue(issue,session,createdId);
      }
    } else {
      const issue=await this.api.issue({session,issueId:this.issueId,signal});
      if (!this.current(generation)) return false;
      const checkedIssue=validateContentIssue(issue,session,this.issueId);
      const entries=await this.api.entries({session,issueId:this.issueId,signal});
      if (!this.current(generation)) return false;
      this.issue=checkedIssue;this.entries=validateContentEntries(entries,session,this.issueId);this.entriesCursor=entries.data.nextCursor??null;
    }
    return true;
  }
  adoptCurrent() {
    for (const draft of Object.values(this.record.drafts)) {
      if (draft.mode==='create') continue;
      let latest;try {latest=this.initial(draft.mode,draft.commentId);} catch {continue;}
      draft.currentVersion=latest.baseVersion;
      if (draft.revision===draft.ack) {draft.value=latest.value;draft.baseVersion=latest.baseVersion;}
      draft.conflict=draft.revision>draft.ack && draft.baseVersion!==latest.baseVersion;
    }
    this.record.baseVersion=this.issue?.version ?? 0;
  }
  async revalidate() {
    if (this.disposed || !this.visible) return {kind:'stopped'};
    this.lock('CHECKING_SESSION'); const generation=this.generation;this.busy=true;this.abort=new AbortController();this.emit();
    try {
      const session=validateContentSession(await this.api.session({signal:this.abort.signal}),this.now());
      if (generation!==this.generation || this.disposed || !this.visible) return {kind:'stale'};
      const identity=canon([session.principalId,session.workspaceId,session.workspaceEpoch]);
      if (this.identity && this.identity!==identity) return this.lock('IDENTITY_CHANGED',{erase:true});
      this.identity=identity;this.session=session;
      if (this.record?.scopeCeiling && session.scopes.some(scope=>!this.record.scopeCeiling.includes(scope))) return this.lock('SCOPE_EXPANSION');
      this.quarantined=true;
      const restored=await this.protection.restore(session,()=>this.current(generation));
      if (!this.current(generation)) return {kind:'stale'};
      if (restored) {
        if (!object(restored) || !integer(restored.revision) || !object(restored.drafts) || !Array.isArray(restored.scopeCeiling)) throw fail('DRAFT_INVALID');
        if (session.scopes.some(scope=>!restored.scopeCeiling.includes(scope))) throw fail('SCOPE_EXPANSION');
        if (!this.record || restored.revision>this.record.revision) this.record=restored;
      }
      await this.protection.unlock(session,()=>this.current(generation));
      if (!this.current(generation)) return {kind:'stale'};
      this.quarantined=false;
      if (!await this.readCurrent(generation)) return {kind:'stale'};
      if (!this.record) this.record={revision:0,baseVersion:this.issue?.version??0,scopeCeiling:copy(session.scopes),active:this.projectId?'create':'body',drafts:{},journal:null};
      const active=this.record.active;
      if (!this.record.drafts[active]) this.record.drafts[active]={mode:active,...this.initial(active),revision:0,ack:0};
      this.adoptCurrent();this.touch();
      if ((await this.flush()).kind!=='protected') throw fail('PROTECTION_FAILED');
      if (!this.current(generation)) return {kind:'stale'};
      this.locked=false;this.phase=Object.values(this.record.drafts).some(draft=>draft.conflict)?'conflict':'ready';this.code=null;
      const lease=Math.min(session.expiresAt,this.protection.expiresAt?.()??session.expiresAt);
      if (lease<=this.now()) throw fail('AUTH_REQUIRED');
      this.leaseTimer=setTimeout(()=>this.lock('LEASE_EXPIRED'),Math.min(lease-this.now(),2147483647));this.leaseTimer.unref?.();
      return {kind:'ready'};
    } catch(error) {if (generation===this.generation) {this.quarantined=true;return this.lock(error.code??error.message??'LOAD_FAILED');}return {kind:'stale'};}
    finally {if (generation===this.generation) {this.busy=false;this.emit();}}
  }
  validateDraft(draft) {
    const v=draft.value;
    if (Object.hasOwn(v,'description') && !markdown(v.description) || Object.hasOwn(v,'bodyMarkdown') && !markdown(v.bodyMarkdown)) return 'BODY_TOO_LARGE';
    if (Object.hasOwn(v,'bodyMarkdown') && !v.bodyMarkdown.trim()) return 'CONTENT_EMPTY';
    if (Object.hasOwn(v,'title') && (!string(v.title) || !v.title.trim() || new TextEncoder().encode(v.title).byteLength>4096)) return 'VALIDATION';
    if (Object.hasOwn(v,'priority') && !priority(v.priority) || Object.hasOwn(v,'assigneeId') && v.assigneeId!==null && !id(v.assigneeId) || Object.hasOwn(v,'parentId') && v.parentId!==null && !id(v.parentId) || draft.mode==='create' && (v.projectId!==this.projectId || !['backlog','ready'].includes(v.initialStatus))) return 'VALIDATION';
    return null;
  }
  async save() {
    if (this.locked || this.busy) return {kind:'stopped'};
    if (this.record.journal && !terminal(this.record.journal)) return {kind:'pending',code:'CHECK_EXISTING_OPERATION'};
    const draft=this.record.drafts[this.record.active], code=this.validateDraft(draft);
    if (code) {this.code=code;this.emit();return {kind:'invalid',code};}
    const names={create:'Create',body:'UpdateBody','add-comment':'AddComment','edit-comment':'EditComment',assign:'Assign',priority:'SetPriority'};
    const payload=copy(draft.value);
    if (draft.mode==='add-comment') payload.commentId=this.uuid();
    if (draft.mode==='edit-comment') Object.assign(payload,{commentId:draft.commentId,expectedCommentVersion:draft.baseVersion});
    this.record.journal={state:'prepared',key:this.record.active,revision:draft.revision,attempts:0,checks:0,firstSubmittedAt:null,nextAllowedAt:0,command:{schemaVersion:1,workspaceId:this.session.workspaceId,workspaceEpoch:this.session.workspaceEpoch,operationId:this.uuid(),commandType:`Issue.${names[draft.mode]}`,entityId:draft.mode==='create'?this.uuid():draft.mode==='edit-comment'?draft.commentId:this.issueId,expectedVersion:draft.baseVersion,payload}};
    this.touch();return this.dispatch();
  }
  apply(result) {
    const journal=this.record.journal;
    if (result.kind==='committed') {
      const {meta,data}=result.body??{};
      if (meta?.workspaceId!==this.session.workspaceId || meta?.actorId!==this.session.principalId || meta?.operationId!==journal.command.operationId || data?.entityId!==journal.command.entityId || data?.outcome!=='committed' || typeof data.effectApplied!=='boolean' || !naturalVersion(data.committedVersion) || !integer(data.commitSeq)) return {kind:'ambiguous',code:'RECEIPT_BINDING_MISMATCH'};
      journal.state='committed';journal.effectApplied=data.effectApplied;
      const draft=this.record.drafts[journal.key]; draft.ack=Math.max(draft.ack,journal.revision);draft.baseVersion=data.committedVersion;
      // A late keystroke is not part of the acknowledged command snapshot.
      if (draft.mode==='add-comment' && draft.revision===draft.ack) draft.value.bodyMarkdown='';
    } else if (result.kind==='rejected' && result.body?.error?.outcome==='rejected' && result.body?.error?.effectApplied===false) journal.state='rejected';
    else journal.state='unknown';
    if (result.retryAfterMs!==undefined) journal.nextAllowedAt=Math.max(journal.nextAllowedAt,this.now()+result.retryAfterMs);
    if (result.retryAt!==undefined) journal.nextAllowedAt=Math.max(journal.nextAllowedAt,result.retryAt);
    this.touch();return result;
  }
  async settle(result,generation) {
    result=this.apply(result);
    if (result.kind==='auth-required' || result.kind==='forbidden' || denied(result.code)) {await this.flush();if (this.current(generation))this.lock(result.code??result.kind);return result;}
    if (result.kind==='committed' || result.kind==='rejected') {
      // The confirmed outcome remains recorded even if this GET later fails.
      if ((await this.flush()).kind!=='protected') return {kind:'protection-failed'};
      if (!this.current(generation)) return {kind:'stale'};
      try {if (!await this.readCurrent(generation)) return {kind:'stale'};this.adoptCurrent();this.touch();}
      catch(error) {if (this.current(generation)) {this.issue=null;this.entries=[];this.history=[];this.code=error.code??'REFRESH_REQUIRED';if(denied(this.code))this.lock(this.code);else this.phase='refresh-required';}return {...result,refreshRequired:true};}
    }
    if (!this.current(generation)) return {kind:'stale'};
    await this.flush();if(!this.current(generation))return {kind:'stale'};
    this.phase=result.kind==='rejected' && result.code==='VERSION_CONFLICT'?'conflict':result.kind;this.code=result.code??null;this.emit();return result;
  }
  async dispatch() {
    if (this.locked || this.busy) return {kind:'stopped'};
    const journal=this.record.journal;
    if (!journal || terminal(journal)) return {kind:'stopped'};
    if (journal.attempts>=4 || journal.firstSubmittedAt!==null && this.now()-journal.firstSubmittedAt>=60000) return {kind:'budget-exhausted'};
    if (journal.nextAllowedAt>this.now()) return {kind:'retry-floor',nextAllowedAt:journal.nextAllowedAt};
    const generation=this.generation;this.busy=true;this.emit();
    try {
      journal.state='submitted';journal.attempts++;journal.firstSubmittedAt??=this.now();this.touch();
      if ((await this.flush()).kind!=='protected') return {kind:'protection-failed'};
      if (!this.current(generation)) return {kind:'stale'};
      const result=await this.api.transport.submit({command:copy(journal.command),session:copy(this.session),signal:this.abort?.signal});
      if (!this.current(generation)) return {kind:'stale'};
      return await this.settle(result,generation);
    } finally {if (generation===this.generation) {this.busy=false;this.emit();}}
  }
  /** An explicit Check action is read-only and has its own renewable read budget.
   * It never resets the original command's send/recovery counters or deadline. */
  async checkManually({signal}={}) {
    if (this.locked || this.busy || signal?.aborted) return {kind:'stopped'};
    const journal=this.record?.journal;
    if (!journal || terminal(journal)) return {kind:journal?.state??'no-operation'};
    if (!Number.isSafeInteger(journal.firstSubmittedAt)) return {kind:'stopped',code:'NO_SUBMITTED_OPERATION'};
    const now=this.now(), prior=journal.manualReadBudget;
    const budget=prior && now-prior.startedAt<60000 ? prior : {startedAt:now,count:0};
    if (budget.count>=3) return {kind:'manual-budget-exhausted',nextAllowedAt:budget.startedAt+60000};
    // One receipt read per explicit action, at most three per persisted one-minute window.
    // Persist the separate counter so reload cannot reset this read-only budget.
    journal.manualReadBudget={startedAt:budget.startedAt,count:budget.count+1};this.touch();
    const generation=this.generation, previous=copy(this.session);this.busy=true;this.emit();
    const signals=[signal,this.abort?.signal].filter(Boolean),combined=signals.length?AbortSignal.any(signals):undefined;
    const stop=()=>{if(generation===this.generation)this.lock('MANUAL_CHECK_INTERRUPTED');};
    signal?.addEventListener('abort',stop,{once:true});
    try {
      const result=await boundedAttempt(async attemptSignal=>{
        const valid=()=>!attemptSignal.aborted&&generation===this.generation&&!this.disposed&&this.visible;
        const checked=await boundedAttempt(async s=>{try{return {session:await this.api.session({signal:s})};}catch(error){return {error};}},5000,attemptSignal);
        if(!valid())return {kind:'stale'};
        if(!checked.session){const code=checked.error?.code??checked.error?.message??checked.code??'SESSION_CHECK_FAILED';if(denied(code))return this.lock(code);return {kind:'ambiguous',code};}
        let session;
        try {session=validateContentSession(checked.session,this.now());}
        catch(error){return this.lock(error.code??'AUTH_REQUIRED');}
        if(['principalId','workspaceId','workspaceEpoch','actorKind'].some(k=>session[k]!==previous[k]))return this.lock('IDENTITY_CHANGED',{erase:true});
        if(session.scopes.some(scope=>!this.record.scopeCeiling.includes(scope)))return this.lock('SCOPE_EXPANSION');
        // Observed authorization changes must clear cached keys/visible content
        // before any retained draft is reused. Existing Verify/revalidate performs
        // fresh key + current-resource checks; read-only receipt remains available
        // afterward even if write/history scopes were removed.
        if(session.authzVersion!==previous.authzVersion||session.sessionId!==previous.sessionId||canon([...session.scopes].sort())!==canon([...previous.scopes].sort()))return this.lock('AUTHORIZATION_CHANGED');
        this.session=session;
        if((await this.flush()).kind!=='protected')return {kind:'protection-failed'};
        if(!valid()||!this.current(generation))return {kind:'stale'};
        const receipt=await boundedAttempt(s=>this.api.transport.readReceipt({command:copy(journal.command),session:copy(session),signal:s}),5000,attemptSignal);
        if(!valid()||!this.current(generation))return {kind:'stale'};
        if(receipt.kind==='not-observed'){
          journal.state='unknown';this.touch();await this.flush();
          if(!valid()||!this.current(generation))return {kind:'stale'};
          this.phase='unknown';this.code='NOT_OBSERVED';return receipt;
        }
        return await this.settle(receipt,generation);
      },30000,combined);
      if(generation===this.generation&&['TIMEOUT','CANCELLED'].includes(result.code))this.lock('MANUAL_CHECK_INTERRUPTED');
      else if(generation===this.generation&&result.kind==='ambiguous'){this.phase='unknown';this.code=result.code??'RECEIPT_UNAVAILABLE';}
      return result;
    } finally {signal?.removeEventListener('abort',stop);if(generation===this.generation){this.busy=false;this.emit();}}
  }
  async checkResult({retry=false,signal}={}) {
    if(!retry)return this.checkManually({signal});
    if (this.locked || this.busy) return {kind:'stopped'};
    const journal=this.record.journal;
    if (!journal || terminal(journal)) return {kind:journal?.state??'no-operation'};
    if (journal.checks>=6 || this.now()-journal.firstSubmittedAt>=60000) return {kind:'budget-exhausted'};
    const generation=this.generation;this.busy=true;this.emit();
    try {
      journal.checks++;this.touch();if((await this.flush()).kind!=='protected')return {kind:'protection-failed'};
      if(!this.current(generation))return {kind:'stale'};
      let result=await this.api.transport.readReceipt({command:copy(journal.command),session:copy(this.session),signal:this.abort?.signal});
      if(!this.current(generation))return {kind:'stale'};
      if(result.kind==='not-observed') {
        // Absence is never proof of non-execution. Only the exact saved envelope
        // may be retried; the caller explicitly chooses that action.
        journal.state='unknown';journal.nextAllowedAt=Math.max(journal.nextAllowedAt,journal.firstSubmittedAt+[1000,3000,10000][Math.min(journal.attempts-1,2)]);this.touch();await this.flush();
        if(!this.current(generation))return {kind:'stale'};
        if(retry) {this.busy=false;return await this.dispatch();}
        this.phase='unknown';this.code='NOT_OBSERVED';return result;
      }
      return await this.settle(result,generation);
    } finally {if(generation===this.generation){this.busy=false;this.emit();}}
  }
  /** Explicitly rebase the retained draft after showing the current version. */
  useCurrentVersion() {
    if(this.locked||this.busy||this.record.journal&&!terminal(this.record.journal))return {kind:'stopped'};
    const draft=this.record.drafts[this.record.active];
    if(draft.mode==='create')return {kind:'stopped'};
    const latest=this.initial(draft.mode,draft.commentId);draft.baseVersion=latest.baseVersion;draft.conflict=false;this.touch();this.phase='editing';this.emit();this.scheduleFlush();return {kind:'rebased'};
  }
  async loadMoreEntries() {
    if(this.locked||this.busy||!this.entriesCursor)return {kind:'stopped'};
    const generation=this.generation;this.busy=true;this.emit();
    try{const body=await this.api.entries({session:copy(this.session),issueId:this.issueId,cursor:this.entriesCursor,signal:this.abort?.signal});if(!this.current(generation))return {kind:'stale'};
      const items=validateContentEntries(body,this.session,this.issueId);if(body.meta.refreshRequired){this.entries=[];this.entriesCursor=null;this.history=[];this.historyCursor=null;this.emit();await this.readCurrent(generation);return {kind:'entries',refreshRequired:true};}this.entries=[...this.entries.filter(e=>!items.some(i=>i.id===e.id)),...items];this.entriesCursor=body.data.nextCursor??null;return {kind:'entries',refreshRequired:body.meta.refreshRequired};
    }catch(error){if(this.current(generation))this.lock(error.code??'LOAD_FAILED');return {kind:'unavailable'};}finally{if(this.current(generation)){this.busy=false;this.emit();}}
  }
  async loadHistory(revisionId,{more=false}={}) {
    if(this.locked||this.busy||!this.issueId||revisionId!==undefined&&!id(revisionId))return {kind:'stopped'};
    if(more&&!this.historyCursor)return {kind:'stopped'};
    const generation=this.generation;this.busy=true;if(!more){this.history=[];this.historyCursor=null;}this.historyCode=null;this.emit();
    try {
      const body=await this.api.revisions({session:copy(this.session),issueId:this.issueId,revisionId,...(more&&this.historyCursor?{cursor:this.historyCursor}:{}),signal:this.abort?.signal});
      if(!this.current(generation))return {kind:'stale'};
      const data=boundData(body,this.session);if(more&&body.meta.refreshRequired){this.history=[];this.historyCursor=null;this.entries=[];this.entriesCursor=null;this.historyCode='REFRESH_REQUIRED';this.emit();await this.readCurrent(generation);return {kind:'refresh-required'};}const items=revisionId?[data]:data.items;
      if(!Array.isArray(items)||items.some(item=>!id(item.id)||!markdown(item.contentMarkdown)||item.resource?.id!==this.issueId))throw fail('PROTOCOL_ERROR');
      this.history=more?[...this.history,...copy(items)]:copy(items);this.historyCursor=data.nextCursor??null;this.emit();return {kind:'history'};
    }catch(error){if(this.current(generation)){this.history=[];this.historyCursor=null;this.historyCode=error.code??'HISTORY_UNAVAILABLE';if(denied(this.historyCode))this.lock(this.historyCode);else this.emit();}return {kind:'unavailable',code:error.code};}finally{if(this.current(generation)){this.busy=false;this.emit();}}
  }
}
