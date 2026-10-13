// @module work
// @role private-d1
import {sql,type D1OperationDefinition} from '../persistence/transaction';
import {directoryPolicy,directoryPermissions} from '../../../modules/work/public';
/** Closed directory authority, evaluated inside every journal read and registration. */
export function directoryOperationDefinitions():readonly D1OperationDefinition[]{
 return (['project','workspace'] as const).map(kind=>({routeTag:kind,operationKinds:[`directory.${kind}.create`,`directory.${kind}.edit`],recovery:row=>{
  const create=sql(`${row.operationKind.text}=?`,...row.operationKind.values,`directory.${kind}.create`);
  const relation=sql(`${row.projectId.text}=${kind==='workspace'?"'workspace:'||":''}${row.targetId.text}`,...row.projectId.values,...row.targetId.values);
  const exists=sql(`EXISTS(SELECT 1 FROM ${kind==='project'?'projects':'workspaces'} d WHERE d.id=${row.targetId.text})`,...row.targetId.values);
  const workspace=kind==='project'?sql(`EXISTS(SELECT 1 FROM workspaces WHERE id=json_extract(${row.inputJson.text},'$.workspaceId'))`,...row.inputJson.values):sql('1');
  const shape=sql(`json_extract(${row.routeJson.text},'$.kind')=?
   AND json_extract(${row.inputJson.text},'$.operationId')=${row.operationId.text}
   AND NOT EXISTS(SELECT 1 FROM json_each(${row.routeJson.text}) WHERE key NOT IN ('kind','id'))
   AND CASE WHEN (${create.text}) THEN json_type(${row.routeJson.text},'$.id') IS NULL
     ELSE json_extract(${row.routeJson.text},'$.id')=${row.targetId.text} END`,
   ...row.routeJson.values,kind,...row.inputJson.values,...row.operationId.values,...row.routeJson.values,...create.values,...row.routeJson.values,...row.routeJson.values,...row.targetId.values);
  return {supported:sql(`(${relation.text}) AND (${shape.text})`,...relation.values,...shape.values),authority:sql(`CASE WHEN (${create.text}) THEN ? ELSE ? END`,...create.values,directoryPolicy.create,directoryPolicy.edit),
   permissions:sql(`CASE WHEN (${create.text}) THEN ? ELSE ? END`,...create.values,JSON.stringify(directoryPermissions('create')),JSON.stringify(directoryPermissions('edit'))),
   preparedVisible:sql(`CASE WHEN (${create.text}) THEN (${workspace.text}) ELSE (${exists.text}) END`,...create.values,...workspace.values,...exists.values),confirmedVisible:exists};
 }}));
}
