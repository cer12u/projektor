// @module tooling.contracts
// @role operation-schema
/** Adds only the durable Agent REST transport contract to the shared API document. */
export function addOperationIntentContract(doc){
 const S=doc.components.schemas,ref=name=>({$ref:'#/components/schemas/'+name}),str={type:'string'},obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
 const id={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'},scope={type:'string',pattern:'^(?:workspace:)?[A-Za-z0-9_-]{1,128}$'},integer={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
 const contentId=prefix=>({type:'string',pattern:'^(?:'+prefix+'_[a-f0-9]{64}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$'});
 const variants=[];
 for(const kind of ['issue','wiki','comment'])for(const edit of [false,true]){
  const properties={kind:{const:kind},projectId:kind==='issue'?id:scope,...(edit?{id:contentId(kind==='issue'?'I':kind==='wiki'?'W':'C')}:{})};
  if(kind==='comment')Object.assign(properties,{parentKind:{enum:['issue','wiki']},parentId:{anyOf:[contentId('I'),contentId('W')]}});
  const name=(edit?'Edit':'Create')+kind[0].toUpperCase()+kind.slice(1)+'Input';
  variants.push(obj({route:obj(properties),input:ref(name)}));
 }
 for(const [kind,actions]of [['execution',['acquire','renew','end','interrupt']],['report',['progress','failed','completed','reconcile','restart']]])for(const action of actions){
  const input=kind==='execution'?(action==='acquire'?'ExecutionAcquireInput':'ExecutionLeaseInput'):{progress:'ExecutionReportInput',completed:'ExecutionReportInput',failed:'ExecutionFailedInput',reconcile:'ExecutionReconcileInput',restart:'ExecutionRestartInput'}[action];
  variants.push(obj({route:obj({kind:{const:kind},projectId:id,issueId:contentId('I'),action:{const:action}}),input:ref(input)}));
 }
 S.OperationPreparationInput={oneOf:variants,description:'One closed business route and its domain input, including the caller’s original operationId. Preparation persists input only and does not dispatch the business operation.'};
 const routes=variants.map(v=>v.properties.route),inputs=[...new Set(variants.map(v=>v.properties.input.$ref))].map($ref=>({$ref}));
 S.OperationRoute={anyOf:routes};S.OperationInput={anyOf:inputs};
 S.OperationSnapshot={anyOf:['Issue','BodyDocument','ExecutionAttempt','ExecutionReport','ExecutionReconciliation','ExecutionRestart'].map(ref)};
 S.CurrentDurableOperation=obj({sequence:{...integer,minimum:1},operationId:id,formatVersion:{const:1},recorded:{const:true},inputHash:{type:'string',pattern:'^[a-f0-9]{64}$'},route:ref('OperationRoute'),input:ref('OperationInput'),target:obj({kind:str,targetId:str,projectId:scope}),requiredPermissions:{type:'array',items:{enum:['view','edit','assign','transition','execute']}},preparedAt:integer,result:{oneOf:[obj({status:{const:'unknown'}}),obj({status:{const:'confirmed'},snapshot:ref('OperationSnapshot')})]}});
 S.FutureDurableOperation={...structuredClone(S.CurrentDurableOperation),description:'A recognizable retained target with an unsupported future input format. Input is opaque and bounded to65536 UTF-8 bytes; new execution is prohibited. Confirmed canonical receipts remain recoverable.'};
 S.FutureDurableOperation.properties.formatVersion={...integer,minimum:2};
 S.FutureDurableOperation.properties.input={type:'object',additionalProperties:true,'x-max-utf8-bytes':65536};
 // Read-only retained data: never referenced by preparation input or acknowledgement schemas.
 const retainedReportInputs=['ExecutionReportInput','ExecutionFailedInput'].map(name=>{const schema=structuredClone(S[name]);delete schema.properties.leaseVersion;schema.required=schema.required.filter(key=>key!=='leaseVersion');return schema;});
 S.RetainedUnversionedReportOperation={...structuredClone(S.CurrentDurableOperation),description:'Previously persisted report input without a lease version. Authorized reads and confirmed receipt recovery only; new preparation or unconfirmed execution is rejected.'};
 S.RetainedUnversionedReportOperation.properties.route=obj({kind:{const:'report'},projectId:id,issueId:contentId('I'),action:{enum:['progress','failed','completed']}});
 S.RetainedUnversionedReportOperation.properties.input={oneOf:retainedReportInputs};
 S.DurableOperation={oneOf:[ref('CurrentDurableOperation'),ref('RetainedUnversionedReportOperation'),ref('FutureDurableOperation')]};
 S.OperationPreparationAck=obj({operation:ref('CurrentDurableOperation'),requestHash:{type:'string',pattern:'^[a-f0-9]{64}$'}});
 S.OperationSummary=obj({sequence:{...integer,minimum:1},operationId:id,formatVersion:{...integer,minimum:1},inputHash:{type:'string',pattern:'^[a-f0-9]{64}$'},target:obj({kind:str,targetId:str,projectId:scope}),preparedAt:integer,result:obj({status:{enum:['unknown','confirmed']}})});
 S.OperationSummaryPage=obj({operations:{type:'array',maxItems:50,items:ref('OperationSummary')},nextAfter:{anyOf:[integer,{type:'null'}]}});
 S.DurableOperationReceipt=obj({operationId:id,snapshot:ref('OperationSnapshot'),source:{enum:['committed','recovered']}});
 const response=(schema,description)=>({description,headers:{'Cache-Control':{schema:{const:'no-store'}}},content:{'application/json':{schema}}});
 function route(path,method,name,output,statuses,body,maxBytes){
  doc.paths[path]??={};const parameters=[...(path.includes('{operationId}')?[{in:'path',name:'operationId',required:true,schema:id}]:[])];
  if(method==='post')for(const name of ['Origin','X-CSRF-Token'])parameters.push({in:'header',name,required:false,schema:str,description:'Required for Agent browser-session writes; existing exact same-origin and CSRF checks. Individual API bearer requests do not use browser CSRF.'});
  const operation={operationId:name,security:[{sessionCookie:[]},{individualApiBearer:[]}],parameters,description:'Agent-only, current same-principal credential, current target visibility and full current required permission set. Uses the same durable operation service as MCP. No grants, credential renewal, scheduler or external execution. Unknown result or missing receipt is never proof of nonapplication.',responses:{200:response(ref(output),'JSON; Cache-Control: no-store')}};
  for(const status of statuses)operation.responses[status]=response(ref('PublicError'),'Current request rejected or unavailable; retain original operation ID and recover the durable record before any explicit execution.');
  if(body)operation.requestBody={required:true,'x-max-utf8-bytes':maxBytes,content:{'application/json':{schema:body}}};
  operation['x-reachability']={importing:'503 import_in_progress',stopped:method==='get'?'read-only discovery and receipt recovery':'prepare denied; execute may return an already-confirmed original receipt but may not dispatch a mutation'};
  operation['x-permissions']={authority:'same authenticated Agent and operation owner',required:['view','current required operation permissions'],disclosure:'All filtering and receipt visibility use SQL-time current guards; list omits saved inputs and snapshots.'};
  doc.paths[path][method]=operation;return operation;
 }
 const list=route('/api/agent/operations','get','listAgentOperationSummaries','OperationSummaryPage',[400,401,403,405,503]);
 list.parameters.push({in:'query',name:'after',required:false,schema:{...integer,default:0}},{in:'query',name:'limit',required:false,schema:{type:'integer',minimum:1,maximum:50,default:20}});list.description+=' Only single after/limit query values are accepted; discovery never executes.';
 const prepare=route('/api/agent/operations','post','prepareAgentOperation','OperationPreparationAck',[400,401,403,405,409,413,415,503],ref('OperationPreparationInput'),73728);prepare.description+=' requestHash is SHA256 of JSON.stringify of the exact parsed request snapshot, for acknowledgment correlation only. Same ID with different normalized input conflicts. No query parameters.';
 route('/api/agent/operations/{operationId}','get','getAgentOperation','DurableOperation',[400,401,403,404,405,409,503]).description+=' Returns full original prepared input only after current authorization. No query parameters.';
 route('/api/agent/operations/{operationId}/execute','post','executeAgentOperation','DurableOperationReceipt',[400,401,403,404,405,409,413,415,503],obj({}),1024).description+=' Empty JSON object only; no replacement input or query. Reads the original receipt first and executes only the already-prepared original input.';
}
