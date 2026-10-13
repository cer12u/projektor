// @module work
// @role private-d1
import type {AuthDB,Sql} from '../primitives';
import {sql} from '../primitives';
import type {Authenticated} from '../identity/authorization';
import {currentCredentialSql,currentGlobalAdministratorSql,authorityValid} from '../identity/authorization';
import {MutationError} from '../persistence/public';
import type {Json} from '../persistence/public';
import {readMutationReceipt,type MutationAdapter,type MutationCommand,type MutationTarget,type ReadPolicyFor} from '../persistence/transaction';
import {digest} from '../../crypto/sha256';
import {DIRECTORY_INPUT_LIMIT,DIRECTORY_KINDS,directoryPolicy,directoryPermissions} from '../../../modules/work/public';
import type {DirectoryChange,DirectoryQuery,DirectoryEntity,DirectoryHistory} from '../../../modules/work/public';
export function directoryJson(kind:'project'|'workspace',alias:string):string {
 const common=`'kind','${kind}','id',${alias}.id,'name',${alias}.name,'revision',${alias}.revision`;
 return `json_object(${common},${kind==='workspace'?`'scopeId','workspace:'||${alias}.id`:`'workspaceId',${alias}.workspace_id,'key',${alias}.key,'slug',${alias}.slug,'description',${alias}.description`})`;
}
export function directoryManagerSql(auth:Authenticated,scope:Sql):Sql {
 return authorityValid(auth,directoryPolicy.edit,scope,JSON.stringify(directoryPermissions('edit')));
}
const table=(kind:'project'|'workspace')=>kind==='project'?'projects':'workspaces';
const scope=(kind:'project'|'workspace',id:string)=>kind==='project'?id:'workspace:'+id;
function snapshot(t:MutationTarget):Sql {const kind=t.kind.includes('.workspace.')?'workspace':'project';return sql(`SELECT ${directoryJson(kind,'d')} FROM ${table(kind)} d WHERE d.id=?`,t.targetId);}
function visibility(auth:Authenticated,t:MutationTarget,confirmed:boolean):Sql {
 const kind=t.kind.includes('.workspace.')?'workspace':'project',create=t.kind.endsWith('.create');
 const rights=create?currentGlobalAdministratorSql(auth):directoryManagerSql(auth,sql('?',scope(kind,t.targetId)));
 const exists=confirmed||!create?sql(`EXISTS(SELECT 1 FROM ${table(kind)} WHERE id=?)`,t.targetId):sql('1');
 return sql(`(${rights.text}) AND (${exists.text})`,...rights.values,...exists.values);
}
export const directoryPolicies=(auth:Authenticated):ReadPolicyFor=>kind=>(DIRECTORY_KINDS as readonly string[]).includes(kind)?{authority:kind.endsWith('.create')?directoryPolicy.create:directoryPolicy.edit,visible:t=>visibility(auth,t,true)}:undefined;
export async function directoryMutationCommand(auth:Authenticated,x:DirectoryChange):Promise<MutationCommand>{
 const {operationId,...input}=x.input,h=await digest(JSON.stringify([auth.id,operationId]));
 const id=x.action==='edit'?x.id:x.kind==='project'?'P_'+h:[h.slice(0,8),h.slice(8,12),'4'+h.slice(13,16),'a'+h.slice(17,20),h.slice(20,32)].join('-');
 return {kind:`directory.${x.kind}.${x.action}`,operationId,targetId:id,projectId:scope(x.kind,id),input:input as Json};
}
export async function prepareDirectory(auth:Authenticated,x:DirectoryChange){
 const command=await directoryMutationCommand(auth,x),edit=x.action==='edit',t=table(x.kind),input=x.input;
 const adapter:MutationAdapter={authority:edit?directoryPolicy.edit:directoryPolicy.create,permissions:directoryPermissions(x.action),commandPolicy:{canonicalMaxBytes:DIRECTORY_INPUT_LIMIT,certifyPreDispatchDenial:!edit},visible:c=>visibility(auth,c,false),
 preconditions:c=>[
  {reason:edit?'revision_conflict':'directory_exists',valid:edit?sql(`EXISTS(SELECT 1 FROM ${t} WHERE id=? AND revision=?)`,c.targetId,x.input.revision):sql(`NOT EXISTS(SELECT 1 FROM ${t} WHERE id=?)`,c.targetId)},
  ...(x.kind==='project'&&x.action==='create'?[{reason:'workspace_unavailable',valid:sql('EXISTS(SELECT 1 FROM workspaces WHERE id=?)',x.input.workspaceId)},{reason:'project_key_or_slug_conflict',valid:sql('NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=? AND (key=? OR slug=?))',x.input.workspaceId,x.input.key,x.input.slug)}]:[])
 ],
 updates:c=>[{expectedChanges:1,statement:x.action==='edit'?sql(`UPDATE ${t} SET before_snapshot=${directoryJson(x.kind,t)},revision=revision+1${'name'in input?',name=?':''}${'description'in input?',description=?':''} WHERE id=? AND revision=?`,...('name'in input?[input.name!]:[]),...('description'in input?[input.description!]:[]),c.targetId,x.input.revision):x.kind==='workspace'?sql("INSERT INTO workspaces(id,name,source_json) VALUES(?,?,'{}')",c.targetId,x.input.name):sql("INSERT INTO projects(id,workspace_id,key,slug,name,description,source_json) VALUES(?,?,?,?,?,?,'{}')",c.targetId,x.input.workspaceId,x.input.key,x.input.slug,x.input.name,x.input.description)}],
 history:c=>[{expectedChanges:1,statement:sql(`INSERT INTO directory_history(kind,target_id,revision,operation_id,actor_id,recorded_at,before_snapshot,after_snapshot) SELECT ?,d.id,d.revision,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),d.before_snapshot,${directoryJson(x.kind,'d')} FROM ${t} d WHERE d.id=?`,x.kind,c.operationId,c.principalId,c.targetId)}],snapshot,current:snapshot};
 return {command,adapter,policyFor:directoryPolicies(auth)};
}
async function authorized<T>(db:AuthDB,auth:Authenticated,x:DirectoryQuery,data:Sql):Promise<T>{
 const credential=currentCredentialSql(auth),rights=directoryManagerSql(auth,sql('?',scope(x.kind,x.id)));
 const q=sql(`SELECT (${credential.text}) authenticated,(${rights.text}) permitted,CASE WHEN (${credential.text}) AND (${rights.text}) THEN (${data.text}) END data`,...credential.values,...rights.values,...credential.values,...rights.values,...data.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;data:string|null}>();
 if(!row?.authenticated)throw new MutationError(401,'unauthenticated');if(!row.permitted)throw new MutationError(403,'forbidden');if(row.data===null)throw new MutationError(404,'not_found');return JSON.parse(row.data) as T;
}
export function readDirectoryEntity(db:AuthDB,auth:Authenticated,x:DirectoryQuery):Promise<DirectoryEntity>{return authorized(db,auth,x,snapshot({kind:`directory.${x.kind}.edit`,targetId:x.id,projectId:scope(x.kind,x.id)}));}
export function readDirectoryHistory(db:AuthDB,auth:Authenticated,x:DirectoryQuery&{afterRevision?:number;limit?:number}):Promise<DirectoryHistory>{
 const after=x.afterRevision??0,limit=x.limit??20;
 return authorized(db,auth,x,sql(`WITH page AS(SELECT * FROM directory_history WHERE kind=? AND target_id=? AND revision>? ORDER BY revision LIMIT ?) SELECT json_object('history',json((SELECT json_group_array(json_object('revision',revision,'operationId',operation_id,'actorId',actor_id,'recordedAt',recorded_at,'before',json(before_snapshot),'after',json(after_snapshot))) FROM page)),'nextAfterRevision',CASE WHEN EXISTS(SELECT 1 FROM directory_history WHERE kind=? AND target_id=? AND revision>COALESCE((SELECT max(revision) FROM page),?)) THEN (SELECT max(revision) FROM page) ELSE NULL END) FROM ${table(x.kind)} WHERE id=?`,x.kind,x.id,after,limit,x.kind,x.id,after,x.id));
}
export function readDirectoryResult(db:AuthDB,auth:Authenticated,operationId:string){return readMutationReceipt(db,auth,operationId,directoryPolicies(auth));}
