// @module verification
// @role ptordev32-d1-fixture
// PTORDEV-32 isolated acceptance bridge for Main. Never deploy. Product mutations stay in their normal adapters.
import product from "../../src/apps/worker";
import {authenticate} from './identity-fixture';
import {compileExecution,getExecution,liveExecutionSql,type ExecutionAction} from "../../src/adapters/d1/execution/lifecycle";
import {compileReport,type ReportAction} from "../../src/adapters/d1/execution/reports";
import {decodeExecutionCommand,decodeReportCommand} from "../../src/modules/execution/public";
import {createExecution} from '../../src/modules/execution/application';
import {createExecutionPersistence} from '../../src/adapters/d1/execution/adapter';
import {observeChange} from '../../src/adapters/d1/persistence/outcomes';
import type {Receipt} from '../../src/modules/change-outcomes';
import type {ExecutionAttempt,ReportSnapshot} from '../../src/modules/execution/public';
import {executeMutation,type MutationAdapter,type MutationCommand,type ReadPolicyFor} from "../../src/adapters/d1/persistence/transaction";
import {currentCredentialSql,currentPermissionsSql} from "../../src/adapters/d1/identity/authorization";
import type {AuthDB} from "../../src/adapters/d1/primitives";
import type {Authenticated} from "../../src/adapters/d1/identity/authorization";
const pauses=new Map<string,{stage:string;release:()=>void;released:boolean;details?:unknown}>();
async function paused(key:string,stage:string,details?:unknown){
 const entry={stage,released:false,release(){this.released=true;},details};
 pauses.set(key,entry);
 // An outstanding timer keeps the real runtime request alive while the harness
 // releases it from another HTTP request. An unresolved bare promise is canceled.
 const until=Date.now()+15000;
 while(!entry.released){if(Date.now()>until)throw new Error('fixture pause timeout');await new Promise(r=>setTimeout(r,20));}
}
function wrap(raw:AuthDB,options:{pause?:string;before?:string[];after?:string[];lostAck?:boolean},metrics:unknown[]){
 let used=false;
 return new Proxy(raw,{get(target,key){
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   if(!used){used=true;if(options.pause)await paused(options.pause,'before_batch');
    for(const text of options.before??[])await target.prepare(text).run();}
   try{const result=await target.batch(statements);for(const text of options.after??[])await target.prepare(text).run();metrics.push({ok:true,statements:statements.length,changes:result.map(r=>r.meta.changes),rowsWritten:result.reduce((n,r)=>n+r.meta.rows_written,0)});
    if(options.lostAck){options.lostAck=false;throw new Error('fixture acknowledgement lost after actual D1 commit');}return result;
   }catch(e){metrics.push({ok:false,statements:statements.length,error:e instanceof Error?e.message:String(e)});throw e;}
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(path==='/__32/control'){
  const q=await request.json() as {key:string;release?:boolean};const p=pauses.get(q.key);
  if(q.release)p?.release();return Response.json({stage:p?.stage??null,details:p?.details??null});
 }
 if(path==='/__32/invoke'){
  const q=await request.json() as {issueId:string;action:ExecutionAction|ReportAction;domain?:'report';input:unknown;pause?:string;before?:string[];fault?:string;lostAck?:boolean};
  const raw=env.DB.withSession('first-primary'),metrics:unknown[]=[];
  try{
   const auth=await authenticate(request,raw,Math.floor(Date.now()/1000));
   const db=wrap(raw,q,metrics),port=createExecutionPersistence(db,auth);
   async function commit(p:{command:MutationCommand;adapter:MutationAdapter;policyFor:ReadPolicyFor}){
    if(q.fault==='zero-update'){const updates=p.adapter.updates;p.adapter.updates=c=>[...updates(c),{statement:{text:"UPDATE issue_execution_heads SET attempt_id=attempt_id WHERE issue_id='missing'",values:[]},expectedChanges:1}];}
    if(q.fault==='event'){const history=p.adapter.history;p.adapter.history=c=>[...history(c),{statement:{text:"INSERT INTO mutation_guards(batch_id,step,valid) VALUES('fault',1,0)",values:[]},expectedChanges:1}];}
    if(q.fault==='snapshot')p.adapter.snapshot=()=>({text:'NULL',values:[]});
    const result=await executeMutation(db,auth,p.command,p.adapter,p.policyFor);
    return {operationId:p.command.operationId,...result};
   }
   // Fault injection decorates only commit encoding; the production application still plans every transition.
   const api=createExecution({...port,
    commitExecution:(c,plan)=>observeChange(c.input.operationId,async()=>await commit(await compileExecution(auth,c,plan)) as unknown as Receipt<ExecutionAttempt>&{source:'committed'|'recovered'}),
    commitReport:(c,plan)=>observeChange(c.input.operationId,async()=>await commit(await compileReport(auth,c,plan)) as unknown as Receipt<ReportSnapshot>&{source:'committed'|'recovered'}),
   });
   const outcome=q.domain==='report'?await api.report(decodeReportCommand({projectId:'P',issueId:q.issueId},q.action as ReportAction,q.input)):await api.change(decodeExecutionCommand({projectId:'P',issueId:q.issueId},q.action as ExecutionAction,q.input));
   if(outcome.application!=='confirmed'){
    const status={invalid:400,unauthenticated:401,forbidden:403,not_found:404,conflict:409,input_mismatch:409,rate_limited:429,internal:500,unavailable:503}[outcome.failure.kind];
    return Response.json({ok:false,status,code:outcome.failure.code,reason:outcome.failure.reason,metrics,bookmark:raw.getBookmark()});
   }
   const value={snapshot:outcome.receipt.snapshot,source:outcome.source};
   return Response.json({ok:true,value,metrics,bookmark:raw.getBookmark()});
  }catch(e){const error=e as {status?:number;code?:string;reason?:string;message?:string};return Response.json({ok:false,status:error.status,code:error.code,reason:error.reason,metrics,bookmark:raw.getBookmark()});}
 }
 if(path==='/__32/predicates'){
  const q=await request.json() as {issueId:string;attemptId?:string};const db=env.DB.withSession('first-primary');
  const auth=await authenticate(request,db,Math.floor(Date.now()/1000));
  const rights=currentPermissionsSql(auth,'P',['view','execute']),credential=currentCredentialSql(auth);
  const row=await db.prepare(`SELECT unixepoch() dbNow,(${credential.text}) credentialValid,(${rights.text}) rightsValid,EXISTS(SELECT 1 FROM issues WHERE id=? AND assignee_id=?) assignmentValid`).bind(...credential.values,...rights.values,q.issueId,auth.id).first();
  let live:unknown=null;if(q.attemptId){const p=liveExecutionSql(auth,'P',q.issueId,q.attemptId);live=await db.prepare(`SELECT unixepoch() dbNow,(${p.text}) valid,(SELECT expires_at FROM issue_execution_attempts WHERE attempt_id=?) expiresAt`).bind(...p.values,q.attemptId).first();}
  return Response.json({row,live,current:await getExecution(db,auth,'P',q.issueId)});
 }
 const pause=request.headers.get('X-32-Pause-Batch'),before=request.headers.get('X-32-Before-Batch'),after=request.headers.get('X-32-After-Batch');
 const wrappedEnv=(pause||before||after)?{...env,DB:wrap(env.DB,{pause:pause??undefined,before:before?[before]:[],after:after?[after]:[]},[]) as D1Database}:env;
 const response=await product.fetch(request,wrappedEnv);
 const hold=request.headers.get('X-32-Hold-Response');
 if(hold)await paused(hold,'after_product_response',{status:response.status});
 return response;
}};
