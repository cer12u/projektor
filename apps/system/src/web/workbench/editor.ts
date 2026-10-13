// @module workbench
// @role controller
import {AuthorityChanged} from '../session/access';
import {EditorLifecycle} from './editor-lifecycle';
import {operationTarget,validatePendingReceipt,validateReceiptChanges,validateHeldReceipt} from './editor-operation';
import type {EditorView} from './editor-view';
export type {EditorView} from './editor-view';
import{sameReferences,type ContentReference}from"../../modules/work/reference-contracts";
import {IssueApi} from './issue-api';
import {CreationNotApplied} from './creation-not-applied';
import {isIssue} from './content-response-validation';
import {HttpError} from '../platform/index';
import {SubjectChanged} from '../session/access';
import {type Receipt, type IssueChanges} from './editor-contracts';
import {EditStore} from './edit-store';
import {key,dirtyRecord,draftReferences,provenRejectedCreation} from './edit-state';
import type {EditRecord,Pending} from './edit-contracts';
import{pruneAttributes,type AttributeDraft}from'./attribute-draft';
import {blankBodyAllowed} from "../../modules/work/content-contracts";
export class IssueEditor{
  private listeners=new Set<()=>void>();private view:EditorView;private queue=Promise.resolve();private active=true;
  private readonly lifecycle:EditorLifecycle;
  private running=false;private timer?:ReturnType<typeof setTimeout>;
  constructor(readonly store:EditStore,readonly api:IssueApi,project:string,target:string,unit:string,private reauth:()=>void,private routeChanged:(id:string,unit:string)=>void){
    this.view={record:{schema:1,owner:api.owner,targetId:target,unitId:unit,projectId:project,resource:api.resource,text:'',base:null,pending:null,latest:null,status:'clean',updatedAt:Date.now(),message:'',fields:{}},accessLost:!!api.documentId(target),ready:false,storageAvailable:true,writes:0};
    this.lifecycle=new EditorLifecycle(api,project,()=>this.view.record,()=>this.active,()=>{clearTimeout(this.timer);this.view={...this.view,accessLost:true};this.publish();},()=>this.refresh());
  }
  subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>this.listeners.delete(f);};
  snapshot=()=>this.view;
  private change(fn:(r:EditRecord)=>void){const r=structuredClone(this.view.record);fn(r);r.updatedAt=Date.now();this.view={...this.view,record:r};for(const f of this.listeners)if(this.active)f();}
  private publish(){this.view={...this.view};for(const f of this.listeners)if(this.active)f();}
  private persist(work:()=>Promise<void>):Promise<boolean>{
    this.view={...this.view,writes:this.view.writes+1};this.publish();
    const p=this.queue.then(work).then(()=>true,()=>{this.view={...this.view,storageAvailable:false};return false;}).finally(()=>{this.view={...this.view,writes:this.view.writes-1};this.publish();});this.queue=p.then(()=>{});return p;
  }
  private storageBlocked(){clearTimeout(this.timer);this.view={...this.view,storageAvailable:false};this.change(r=>{r.status='blocked';r.message='操作の回復記録を端末に保存できないため送信を停止しました。入力と同じ操作IDはメモリに保持しています。閉じる前にコピーまたはダウンロードし、端末保存が使えるようになってから同じ操作を手動で再開してください。';});}
  private async preparePending():Promise<boolean>{
    const op=this.view.record.pending;if(!op)return false;
    const copy=structuredClone(this.view.record);if(!await this.persist(()=>this.store.prepare(copy,op))){this.storageBlocked();return false;}
    this.view={...this.view,storageAvailable:true};this.publish();return true;
  }
  private draft(){const copy=structuredClone(this.view.record);void this.persist(()=>this.store.put(copy));}
  async init(){
    try{const r=await this.store.load(this.api.owner,this.view.record.targetId,this.view.record.unitId);if(r&&r.projectId===this.view.record.projectId)this.view={...this.view,record:r};}
    catch{this.view={...this.view,storageAvailable:false};}
    // A queued older draft may survive an interruption after the atomic journal rejection.
    // Restore only the exact command's explicit pre-dispatch proof, never a generic rejected/absent result.
    if(this.view.record.pending){try{const op=this.view.record.pending,journal=await this.store.journal(op.owner,op.operationId);if(provenRejectedCreation(op,journal))this.change(r=>{if(r.pending){r.pending.phase='rejected';r.pending.nonApplication='pre_dispatch';}r.status='blocked';});}catch{this.view={...this.view,storageAvailable:false};}}
    if(this.view.record.pending&&(this.view.record.pending.resourceKey??'issue')!==this.api.resourceKey)throw new Error('draft_resource_mismatch');
    // Stored target content remains hidden until a fresh guarded target read succeeds.
    // This also covers blocked/conflict/invalid journals that do not run recovery.
    if(this.api.documentId(this.view.record.targetId))await this.refresh();
    if(this.view.record.pending){if(this.view.record.pending.phase==='rejected')this.change(r=>{r.status='blocked';});this.view={...this.view,ready:true};this.publish();if(!['blocked','conflict','invalid'].includes(this.view.record.status))await this.recover();return;}
    this.view={...this.view,ready:true};this.publish();
  }
  input(text:string){this.change(r=>{r.text=text;r.fields={};if(!r.pending&&!r.latest){r.status=dirtyRecord(r)?'dirty':'clean';r.message='';}});this.draft();}
  inputTitle(title:string){this.change(r=>{r.title=title;r.fields={};if(!r.pending&&!r.latest){r.status=dirtyRecord(r)?'dirty':'clean';r.message='';}});this.draft();}
  inputReferences(references:ContentReference[]){if(this.api.resource.kind==='comment')return;this.change(r=>{r.references=references;r.fields={};if(!r.pending&&!r.latest){r.status=dirtyRecord(r)?'dirty':'clean';r.message='';}});this.draft();}
  inputAttributes(changes:AttributeDraft){this.change(r=>{r.attributes={...r.attributes,...changes};if(isIssue(r.base))r.attributes=pruneAttributes(r.attributes,r.base);r.fields={};if(!r.pending&&!r.latest){r.status=dirtyRecord(r)?'dirty':'clean';r.message='';}});this.draft();}
  async refresh(){
    const r=this.view.record;if(!this.api.documentId(r.targetId))return;
    try{const latest=await this.api.get(r.projectId,r.targetId);if(!this.active)return;this.api.assertCurrent(latest);
      this.lifecycle.recordVisibleCredential();this.view={...this.view,accessLost:false};
      this.change(d=>{
        if(!d.pending&&d.status==='blocked'){d.status=d.latest?'conflict':dirtyRecord(d)?'dirty':'clean';d.message='';}
        if(!d.base&&!d.text&&!d.title&&!d.references?.length&&!Object.keys(d.attributes??{}).length&&!d.pending){d.base=latest;d.text=latest.body;d.title=latest.title??'';d.references=latest.references;d.status='clean';}
        else if(d.base&&latest.revision!==d.base.revision){d.latest=latest;if(!d.pending)d.status='conflict';d.message='別の更新があります。最新版と手入力を比較して解決してください。';}
      });if(this.view.record.latest||dirtyRecord(this.view.record))this.draft();
    }catch(e){if(!this.failure(e,false)){this.change(d=>{d.message='最新版を取得できません。手入力は保持しています。接続回復後に再取得してください。';});this.draft();}}
  }
  async save(){return this.startSave();}
  async saveAttributes(changes:IssueChanges){return this.startSave(changes);}
  private async startSave(changes?:IssueChanges){
    const r=this.view.record;if(!this.active||this.running||r.pending||r.latest||(!changes&&!blankBodyAllowed(this.api.resource)&&!r.text.trim())||(!changes&&!!r.base&&r.text===r.base.body&&(r.title??'')===(r.base.title??'')&&sameReferences(draftReferences(r),r.base.references))||(changes&&(!r.base||!Object.keys(changes).length))||(this.api.documentId(r.targetId)&&!r.base))return;
    const op:Pending={owner:this.api.owner,operationId:crypto.randomUUID(),resourceKey:this.api.resourceKey,projectId:r.projectId,body:changes?r.base!.body:r.text,...(this.api.resource.kind==='comment'?{}:{title:changes?r.base?.title??'':r.title??'',references:structuredClone(changes?r.base?.references??[]:draftReferences(r))}),...(changes?{changes}:{}),...(r.base?{issueId:r.base.id,revision:r.base.revision}:{}),attempts:0,queries:0,lastAttemptAt:0,createdAt:Date.now(),phase:'prepared'};
    this.change(d=>{d.pending=op;d.status='saving';d.message='送信内容を固定して保存しています。追加入力はそのまま残ります。';d.fields={};});
    if(!await this.preparePending())return;await this.send();
  }
  private schedule(kind:'query'|'send',delay=2000){if(!this.active)return;clearTimeout(this.timer);this.timer=setTimeout(()=>void(kind==='query'?this.recover():this.send()),delay);}
  private async accept(receipt:Receipt){
    const op=this.view.record.pending;if(!op)return;this.api.assertCurrent(receipt);
    validatePendingReceipt(receipt,op,value=>this.api.valid(value));
    if(receipt.snapshot.id!==await operationTarget(op,this.api.prefix))throw new Error('operation_subject_mismatch');this.api.assertCurrent(receipt);
    validateReceiptChanges(receipt,op);
    const oldKey=key(this.view.record);this.change(r=>{r.base=receipt.snapshot;r.targetId=this.api.storageTarget(receipt.snapshot.id);r.pending=null;
      if(isIssue(receipt.snapshot))r.attributes=pruneAttributes(r.attributes??{},receipt.snapshot);
      if(r.latest&&r.latest.revision<=receipt.snapshot.revision)r.latest=null;r.status=r.latest?'conflict':dirtyRecord(r)?'dirty':'clean';
      r.message=dirtyRecord(r)?'送信した編集は保存済みです。未保存の入力はそのまま保持しています。':'保存済みです。';r.fields={};});
    const copy=structuredClone(this.view.record);await this.persist(()=>this.store.finish(copy,oldKey,op));
    if(this.active)this.routeChanged(this.api.storageTarget(receipt.snapshot.id),this.view.record.unitId);
    this.lifecycle.announce(op.owner,op.projectId,receipt.snapshot.id,receipt.snapshot.revision);
  }
  private async send(){
    if(!this.active||this.running||!this.view.record.pending)return;this.running=true;
    try{
      let op=this.view.record.pending;
      await this.flush();if(!this.active)return;if(!this.view.storageAvailable){this.storageBlocked();return;}
      let reserved:Pending|null=null;
      if(!await this.persist(async()=>{reserved=await this.store.reserve(op);})){this.storageBlocked();return;}
      if(!reserved){this.change(r=>{r.status='unknown';r.message='自動再送の上限に達したか、操作記録が終了しています。操作結果を確認してください。';});return;}op=reserved;
      this.change(r=>{r.pending=op;r.status='saving';});this.draft();await this.flush();
      if(!this.active)return;if(!this.view.storageAvailable){this.storageBlocked();return;}
      const result=await this.api.send(op.projectId,op.operationId,op.body,op.issueId,op.revision,op.changes,op.title,op.references);await this.accept(result);
    }catch(e){
      const op=this.view.record.pending;
      if(e instanceof CreationNotApplied&&op&&!op.issueId&&op.operationId===e.operationId&&op.attempts===1&&this.view.storageAvailable){
        // An older tab must not retire an ID that another tab already tried. The journal check and retirement are atomic.
        try{if(await this.store.rejectCreation(op,structuredClone(this.view.record))){this.change(r=>{if(r.pending){r.pending.phase='rejected';r.pending.nonApplication='pre_dispatch';}r.status='blocked';r.message='この作成操作は送信前に拒否され、未反映と確認しました。入力を修正し、現在の権限を確認して新しい操作へ進めます。';});this.draft();return;}}catch{this.view={...this.view,storageAvailable:false};}
      }
      if(!this.failure(e,true)){this.change(r=>{if(r.pending)r.pending.phase='unknown';r.status='unknown';r.message='応答を確認できません。保存済みとは扱わず、操作結果を照会します。';});this.draft();if(this.view.storageAvailable)this.schedule('query');}
    }
    finally{this.running=false;}
  }
  async recover(){
    if(!this.active||this.running||!this.view.record.pending||this.view.record.pending.phase==='rejected')return;clearTimeout(this.timer);this.running=true;
    try{
      let op=this.view.record.pending;
      if(this.view.storageAvailable)await this.persist(async()=>{const journal=await this.store.journal(op.owner,op.operationId);if(journal)op={...op,attempts:Math.max(op.attempts,journal.attempts),queries:Math.max(op.queries,journal.queries)};});
      op={...op,queries:op.queries+1};this.change(r=>{r.pending=op;r.status='unknown';r.message='操作結果を確認しています。入力は保持しています。';});this.draft();
      await this.flush();if(this.view.storageAvailable)await this.persist(()=>this.store.mark(op));
      // Local journal failures stop replay, but cannot suppress the safe result read.
      await this.accept(await this.api.result(op.projectId,op.operationId));
    }catch(e){
      if(!this.failure(e,false)){
        const op=this.view.record.pending;if(!op)return;if(!this.view.storageAvailable){this.storageBlocked();return;}
        if(e instanceof HttpError&&e.status===503&&e.code==='operation_unconfirmed'){
          this.change(r=>{r.status='unknown';if(r.pending)r.pending.phase='unconfirmed';r.message='操作は未確定です。再送せず結果を再照会します。';});this.draft();if(op.queries<6)this.schedule('query');
        }else{
          this.change(r=>{r.status='unknown';r.message='結果を確認できません。送信内容と操作IDを変えず限定再送します。';});this.draft();
          if(this.view.storageAvailable&&op.attempts<4&&op.queries<6)this.schedule('send',Math.max(2000,op.lastAttemptAt+2000-Date.now()));
        }
      }
    }finally{this.running=false;}
  }
  async retrySameOperation(){if(!this.active||!this.view.record.pending||this.view.record.pending.phase==='rejected'||this.running||this.view.record.status==='saving')return;clearTimeout(this.timer);if(!this.view.storageAvailable){await this.recover();const pending=this.view.record.pending;if(!this.active||!pending||this.view.record.status!=='blocked'||pending.phase==='auth'||pending.phase==='rejected')return;if(!await this.preparePending())return;await this.recover();return;}await this.send();}
  private failure(e:unknown,mutation:boolean):boolean{
    if(!this.active)return true;
    if(e instanceof AuthorityChanged){clearTimeout(this.timer);if(this.view.record.pending){this.change(r=>{r.status='unknown';if(r.pending&&r.pending.phase!=='rejected')r.pending.phase='unknown';r.message='認証状態が変わったため結果を確定できません。操作IDと入力は保持しています。';});this.draft();}return true;}
    if(e instanceof SubjectChanged){this.dispose();return true;}
    if(e instanceof HttpError&&e.status===401){this.change(r=>{r.status='reauth';r.message='再認証が必要です。入力と進行中操作を保持しています。';if(r.pending&&r.pending.phase!=='rejected')r.pending.phase='auth';});this.draft();this.reauth();return true;}
    if(e instanceof HttpError&&e.status===403){this.change(r=>{r.status='blocked';r.message='操作または結果照会を拒否されました。不在結果を未確定とみなさず、自動再送を停止しています。';if(r.pending&&r.pending.phase!=='rejected')r.pending.phase='auth';});this.draft();return true;}
    if(e instanceof HttpError&&e.status===409){this.change(r=>{r.status='conflict';r.latest=e.current&&this.api.valid(e.current)?e.current:null;r.message='競合しています。最新版と手入力を比較して明示的に解決してください。';});this.draft();if(!e.current)void this.refresh();return true;}
    if(e instanceof HttpError&&[400,413,415].includes(e.status)){const op=this.view.record.pending;this.change(r=>{r.status='invalid';r.fields=e.fields??{body:e.code};r.message='入力を確認してください。自動再送しません。';if(mutation)r.pending=null;});this.draft();if(op&&mutation&&this.view.storageAvailable)void this.persist(()=>this.store.mark({...op,phase:'rejected'}));return true;}
    return false;
  }
  async resolve(useLatest:boolean){if(this.view.record.pending){this.change(r=>{r.message='操作結果が未確認です。先に操作結果を確認するか、未確定操作を保留して最新版で続けてください。';});this.draft();return;}const latest=this.view.record.latest;if(!latest)return;clearTimeout(this.timer);
    this.change(r=>{r.base=latest;r.pending=null;r.latest=null;if(useLatest){r.text=latest.body;r.title=latest.title??'';r.references=latest.references;}if(isIssue(latest))r.attributes=pruneAttributes(r.attributes??{},latest);r.status=dirtyRecord(r)?'dirty':'clean';r.message=useLatest?'最新版を選びました。':'手入力を保持して最新版の改訂へ合わせました。保存ボタンで確定してください。';});this.draft();await this.flush();}
  async continueAfterDenied(){
    const pending=this.view.record.pending;if(!this.active||this.running||!pending||!['blocked','conflict'].includes(this.view.record.status))return;
    this.running=true;clearTimeout(this.timer);
    try{
      if(pending.phase==='rejected'&&!pending.issueId&&this.api.resource.kind==='issue'){
        await this.api.checkCreationPermission(pending.projectId);if(!this.active)return;
        this.change(r=>{r.heldOperations=[...(r.heldOperations??[]),pending];r.pending=null;r.latest=null;r.base=null;r.status=dirtyRecord(r)?'dirty':'clean';r.message='未反映の作成操作を終了しました。入力は保持しています。保存すると修正内容を新しい操作IDで送信します。';});this.draft();await this.flush();return;
      }
      const target=await operationTarget(pending,this.api.prefix),latest=await this.api.get(pending.projectId,this.api.storageTarget(target));if(!this.active)return;this.api.assertCurrent(latest);const oldKey=key(this.view.record);
      this.change(r=>{r.heldOperations=[...(r.heldOperations??[]),pending];r.pending=null;r.latest=null;r.base=latest;r.targetId=this.api.storageTarget(latest.id);if(isIssue(latest))r.attributes=pruneAttributes(r.attributes??{},latest);r.status=dirtyRecord(r)?'dirty':'clean';r.message='拒否された操作は結果未確認のまま保留しました。最新版を基準に、現在許可された変更を保存できます。保留した操作は自動再送しません。';});const copy=structuredClone(this.view.record);await this.persist(()=>this.store.retarget(copy,oldKey));if(this.active)this.routeChanged(this.api.storageTarget(latest.id),this.view.record.unitId);
    }catch(e){if(!this.failure(e,false)){this.change(r=>{r.message='最新版を取得できません。操作と入力を保持し、編集の再開を停止しています。';});this.draft();}}finally{this.running=false;}
  }
  async checkHeldOperation(operationId:string){const op=this.view.record.heldOperations?.find(v=>v.operationId===operationId);if(!this.active||!op||op.phase==='rejected')return;
    try{const receipt=await this.api.result(op.projectId,operationId);if(!this.active)return;await validateHeldReceipt(receipt,op,operationId,this.api.prefix,value=>this.api.valid(value));
      this.api.assertCurrent(receipt);this.change(r=>{r.heldOperations=r.heldOperations?.filter(v=>v.operationId!==operationId);r.message='保留した操作の保存を確認しました（改訂 '+receipt.snapshot.revision+'）。現在の入力と表示中の改訂は変更していません。';});this.draft();if(this.view.storageAvailable)await this.persist(()=>this.store.mark({...op,phase:'confirmed'}));
    }catch(e){if(e instanceof SubjectChanged){this.dispose();return;}if(e instanceof HttpError&&e.status===401){this.failure(e,false);return;}if(this.active){this.change(r=>{r.message='保留した操作の結果は確認できません。操作IDと入力を保持し、再送していません。';});this.draft();}}
  }
  async flush(){await this.queue;}
  dispose(){this.active=false;this.lifecycle.dispose();clearTimeout(this.timer);}
}
