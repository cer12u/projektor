// @module persistence
// @role private-d1-store
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import {guardedBatch} from "./guarded-batch";
import {MutationError,sql,type Sql} from "./commit";
import {currentCredentialSql,currentPermissionsSql,currentPermissionSetSql} from "../identity/authorization";
import type {DurableOperation,OperationSummary} from "../../../modules/prepared-operations";
import type {D1OperationDefinition,OperationRowExpressions,PreparedIntent,StoredIntentFence,MutationCommand} from './transaction';
const identifier=/^[A-Za-z0-9_-]{1,128}$/;
const and=(...parts:Sql[]):Sql=>sql(parts.map(p=>`(${p.text})`).join(' AND '),...parts.flatMap(p=>p.values));
const statement=(db:AuthDB,q:Sql)=>db.prepare(q.text).bind(...q.values);
const readable=()=>sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode IN ('open','stopped'))");
const writable=()=>sql("EXISTS(SELECT 1 FROM write_gate WHERE id=1 AND mode='open')");
const row:OperationRowExpressions={operationKind:sql('i.operation_kind'),projectId:sql('i.project_id'),targetId:sql('i.target_id'),operationId:sql('i.operation_id'),routeJson:sql('i.route_json'),inputJson:sql('i.input_json'),formatVersion:sql('i.format_version')};
function allowedSql(auth:Authenticated,definitions:readonly D1OperationDefinition[]):Sql {
 const policies=definitions.map(d=>({kind:sql(`i.operation_kind IN (${d.operationKinds.map(()=>'?').join(',')})`,...d.operationKinds),policy:d.recovery(row)}));
 const recognized=policies.map(({kind,policy:p})=>and(kind,p.supported,sql(`CASE WHEN r.state='confirmed' THEN (${p.confirmedVisible.text}) ELSE (${p.preparedVisible.text}) END`,...p.confirmedVisible.values,...p.preparedVisible.values)));
 const target=recognized.length?sql(recognized.map(p=>`(${p.text})`).join(' OR '),...recognized.flatMap(p=>p.values)):sql('0');
 const current=sql(`CASE ${policies.map(({kind,policy})=>`WHEN (${kind.text}) THEN (${policy.permissions.text})`).join(' ')} ELSE '[]' END`,...policies.flatMap(({kind,policy})=>[...kind.values,...policy.permissions.values]));
 const required=sql(`(SELECT json_group_array(value) FROM(SELECT value FROM json_each(i.required_permissions) UNION SELECT value FROM json_each(COALESCE(r.required_permissions,'[]')) UNION SELECT value FROM json_each(${current.text})))`,...current.values);
 return and(sql(auth.kind==='agent'?'1':'0'),readable(),currentCredentialSql(auth),currentPermissionSetSql(auth,row.projectId,required),target);
}
const joins=`FROM operation_intents i LEFT JOIN operation_results r ON r.principal_id=i.principal_id AND r.operation_id=i.operation_id`;
const payload=`json_object('sequence',i.sequence,'operationId',i.operation_id,'formatVersion',i.format_version,'recorded',json('true'),'inputHash',i.input_hash,'route',json(i.route_json),
  'input',json(i.input_json),'target',json_object('kind',i.operation_kind,'targetId',i.target_id,'projectId',i.project_id),
  'requiredPermissions',json(i.required_permissions),'preparedAt',i.prepared_at,
  'result',json(CASE WHEN r.state='confirmed' THEN json_object('status','confirmed','snapshot',json(r.snapshot)) ELSE json_object('status','unknown') END))`;
// SQL projects only recovery metadata for routine discovery; authorization below
// still examines current input policy. This does not claim fewer scanned D1 rows.
const summaryPayload=`json_object('sequence',i.sequence,'operationId',i.operation_id,'formatVersion',i.format_version,'inputHash',i.input_hash,
  'target',json_object('kind',i.operation_kind,'targetId',i.target_id,'projectId',i.project_id),'preparedAt',i.prepared_at,
  'result',json_object('status',CASE WHEN r.state='confirmed' THEN 'confirmed' ELSE 'unknown' END))`;
const matches=`r.operation_id IS NULL OR (r.operation_kind=i.operation_kind AND r.target_id=i.target_id AND r.project_id=i.project_id AND r.input_hash=i.input_hash AND r.authority_kind='project')`;

export function intentFenceSql(principalId:string,fence:StoredIntentFence,command:MutationCommand):Sql {
 if((command.operationId!==fence.operationId||command.kind!==fence.kind||command.targetId!==fence.targetId||command.projectId!==fence.projectId))return sql('0');
 return sql(`EXISTS(SELECT 1 FROM operation_intents WHERE principal_id=? AND operation_id=? AND format_version=?
  AND operation_kind=? AND target_id=? AND project_id=? AND route_json=? AND input_json=? AND input_hash=? AND required_permissions=?)`,
  principalId,fence.operationId,fence.formatVersion,fence.kind,fence.targetId,fence.projectId,fence.routeJson,fence.inputJson,fence.hash,JSON.stringify(fence.permissions));
}
export function createD1IntentStore(db:AuthDB,auth:Authenticated,definitions:readonly D1OperationDefinition[]) {
 async function assertBoundary(write=false):Promise<void>{
  if(auth.kind!=='agent')throw new MutationError(403,'agent_required');
  const credential=currentCredentialSql(auth),q=sql(`SELECT (${credential.text}) authenticated,(SELECT mode FROM write_gate WHERE id=1) gate`,...credential.values);
  const found=await statement(db,q).first<{authenticated:number;gate:string}>();
  if(!found?.authenticated)throw new MutationError(401,'unauthenticated');
  if(found.gate==='importing')throw new MutationError(503,'import_in_progress');
  if(!['open','stopped'].includes(found.gate)||(write&&found.gate!=='open'))throw new MutationError(503,'write_stopped');
 }
 const allowed=allowedSql(auth,definitions);
 function preparationPolicy(p:PreparedIntent){
  const permissions=currentPermissionsSql(auth,p.projectId,p.permissions);
  const definition=definitions.find(d=>d.operationKinds.includes(p.kind));
  if(!definition)throw new MutationError(500,'unregistered_mutation_kind');
  const policy=definition.recovery({operationKind:sql('?',p.kind),projectId:sql('?',p.projectId),targetId:sql('?',p.targetId),operationId:sql('?',p.operationId),routeJson:sql('?',p.routeJson),inputJson:sql('?',p.inputJson),formatVersion:sql('1')});
  const visible=and(policy.supported,policy.preparedVisible);
  const sameReceipt=sql(`NOT EXISTS(SELECT 1 FROM operation_results WHERE principal_id=? AND operation_id=? AND
   (operation_kind<>? OR target_id<>? OR project_id<>? OR input_hash<>? OR authority_kind<>'project'))`,auth.id,p.operationId,p.kind,p.targetId,p.projectId,p.hash);
  return {permissions,visible,sameReceipt};
 }
 return {
  assertBoundary,
  async get(operationId:string){
   if(!identifier.test(operationId))throw new MutationError(400,'invalid_operation_id');
   const q=sql(`SELECT CASE WHEN ${allowed.text} AND (${matches}) THEN ${payload} ELSE NULL END data,(${matches}) matches ${joins} WHERE i.principal_id=? AND i.operation_id=?`,...allowed.values,auth.id,operationId);
   const found=await statement(db,q).first<{data:string|null;matches:number}>();
   if(!found?.data){await assertBoundary();if(!found)throw new MutationError(404,'operation_intent_not_found');
    const authorized=await statement(db,sql(`SELECT (${allowed.text}) permitted ${joins} WHERE i.principal_id=? AND i.operation_id=?`,...allowed.values,auth.id,operationId)).first<{permitted:number}>();
    if(!authorized?.permitted)throw new MutationError(403,'forbidden');throw new MutationError(409,'operation_input_mismatch');
   }
   return JSON.parse(found.data) as DurableOperation;
  },
  async list(options:{after?:number;limit?:number}={}){
   if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['after','limit'].includes(k)))throw new MutationError(400,'invalid_input');
   const after=options.after??0,limit=options.limit??20;
   if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new MutationError(400,'invalid_input');
   await assertBoundary();
   const q=sql(`SELECT ${summaryPayload} data ${joins} WHERE i.principal_id=? AND i.sequence>? AND (${allowed.text}) AND (${matches}) ORDER BY i.sequence LIMIT ?`,auth.id,after,...allowed.values,limit+1);
   const rows=await statement(db,q).all<{data:string}>();await assertBoundary();
   const operations=rows.results.slice(0,limit).map(r=>JSON.parse(r.data) as OperationSummary);
   return {operations,nextAfter:rows.results.length>limit?operations.at(-1)!.sequence:null};
  },
  async record(p:PreparedIntent){
   const {permissions,visible,sameReceipt}=preparationPolicy(p),guard=and(writable(),currentCredentialSql(auth),permissions,visible,sameReceipt);
   await db.batch(guardedBatch(db,guard,[{expectedChanges:1,statement:sql(`INSERT INTO operation_intents(principal_id,operation_id,format_version,operation_kind,target_id,project_id,route_json,input_json,input_hash,required_permissions,prepared_at)
    VALUES(?,?,1,?,?,?,?,?,?,?,unixepoch())`,auth.id,p.operationId,p.kind,p.targetId,p.projectId,p.routeJson,p.inputJson,p.hash,JSON.stringify(p.permissions))}]));
  },
  async diagnoseUnrecorded(p:PreparedIntent):Promise<never>{
   await assertBoundary(true);const {permissions,visible,sameReceipt}=preparationPolicy(p);
   const q=sql(`SELECT (${permissions.text}) AND (${visible.text}) permitted,(${sameReceipt.text}) matches`,...permissions.values,...visible.values,...sameReceipt.values);
   const found=await statement(db,q).first<{permitted:number;matches:number}>();
   if(!found?.permitted)throw new MutationError(403,'forbidden');if(!found.matches)throw new MutationError(409,'operation_input_mismatch');throw new MutationError(503,'operation_prepare_unknown');
  }
 };
}
