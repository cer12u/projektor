// @module work
// @role private-d1
import {WORK_KINDS,WORK_PERMISSION_RULES} from "../../../modules/work/rules";
import {sql,type Sql,type OperationRowExpressions} from "../persistence/transaction";
const join=(parts:Sql[],by:string):Sql=>sql(parts.map(p=>`(${p.text})`).join(by),...parts.flatMap(p=>p.values));
const q=(strings:TemplateStringsArray,...parts:Sql[]):Sql=>sql(strings.reduce((s,x,i)=>s+(i?parts[i-1].text:'')+x,''),...parts.flatMap(p=>p.values));
// Only closed server policy constants reach this SQL literal helper.
const literal=(v:string)=>sql("'"+v.replaceAll("'","''")+"'");
export function workPermissionSql(kind:Sql,input:Sql):Sql {
 const rows=WORK_PERMISSION_RULES.map(r=>{const kinds=join(r.kinds.map(k=>q`${kind}=${literal(k)}`),' OR '),fields=r.fields?join(r.fields.map(f=>q`json_type(${input},${literal('$.'+f)}) IS NOT NULL`),' OR '):sql('1');return q`SELECT ${literal(r.permission)} value WHERE (${kinds}) AND (${fields})`;});
 return q`(SELECT json_group_array(value) FROM (SELECT 'view' value UNION ${sql(rows.map(r=>r.text).join(' UNION '),...rows.flatMap(r=>r.values))}))`;
}
export const issueExists=(project:Sql,target:Sql)=>q`EXISTS(SELECT 1 FROM issues t WHERE t.id=${target} AND t.project_id=${project})`;
export const issueAssigned=(project:Sql,target:Sql,principal:Sql)=>q`EXISTS(SELECT 1 FROM issues t WHERE t.id=${target} AND t.project_id=${project} AND t.assignee_id=${principal})`;
export function workParentVisible(project:Sql,parentKind:Sql,parentId:Sql):Sql {
 return q`((${parentKind}='issue' AND ${issueExists(project,parentId)}) OR (${parentKind}='wiki' AND EXISTS(SELECT 1 FROM content_documents p WHERE p.id=${parentId} AND p.kind='wiki' AND p.scope_id=${project})))`;
}
export function workTargetVisible(kind:Sql|string,project:Sql,target:Sql,parentKind:Sql,parentId:Sql,confirmed:boolean):Sql {
 const issue=issueExists(project,target),wiki=q`EXISTS(SELECT 1 FROM content_documents t WHERE t.id=${target} AND t.scope_id=${project} AND t.kind='wiki')`,parent=workParentVisible(project,parentKind,parentId),comment=q`EXISTS(SELECT 1 FROM content_documents t WHERE t.id=${target} AND t.scope_id=${project} AND t.kind='comment' AND t.parent_kind=${parentKind} AND t.parent_id=${parentId})`;
 const newIssue=confirmed?issue:q`NOT EXISTS(SELECT 1 FROM issues t WHERE t.id=${target} AND t.project_id<>${project})`;
 const newWiki=confirmed?wiki:q`NOT EXISTS(SELECT 1 FROM content_documents t WHERE t.id=${target} AND (t.scope_id<>${project} OR t.kind<>'wiki'))`;
 const newComment=confirmed?comment:q`NOT EXISTS(SELECT 1 FROM content_documents t WHERE t.id=${target} AND (t.scope_id<>${project} OR t.kind<>'comment' OR t.parent_kind<>${parentKind} OR t.parent_id<>${parentId}))`;
 const cases:Record<string,Sql>={'issue.create':newIssue,'issue.edit':issue,'wiki.create':newWiki,'wiki.edit':wiki,'comment.create':q`(${parent}) AND (${newComment})`,'comment.edit':q`(${parent}) AND (${comment})`};
 if(typeof kind==='string')return cases[kind]??sql('0');
 return q`CASE WHEN ${kind}='issue.create' THEN ${newIssue} WHEN ${kind}='issue.edit' THEN ${issue} WHEN ${kind}='wiki.create' THEN ${newWiki} WHEN ${kind}='wiki.edit' THEN ${wiki} WHEN ${kind}='comment.create' THEN (${parent}) AND (${newComment}) WHEN ${kind}='comment.edit' THEN (${parent}) AND (${comment}) ELSE 0 END`;
}
export function workRecovery(tag:keyof typeof WORK_KINDS,row:OperationRowExpressions){
 const {operationKind:k,projectId:p,targetId:t,routeJson:r,inputJson:i}=row,pk=q`json_extract(${r},'$.parentKind')`,pi=q`json_extract(${r},'$.parentId')`;
 const supported=q`(${join(WORK_KINDS[tag].map(kind=>q`${k}=${literal(kind)}`),' OR ')}) AND json_extract(${r},'$.projectId')=${p} AND json_extract(${i},'$.operationId')=${row.operationId} AND json_extract(${r},'$.kind')=${literal(tag)} AND CASE WHEN ${k} LIKE '%.create' THEN json_type(${r},'$.id') IS NULL ELSE json_extract(${r},'$.id')=${t} END AND NOT EXISTS(SELECT 1 FROM json_each(${r}) WHERE key NOT IN ('kind','projectId','id','parentKind','parentId')) AND CASE WHEN ${k} LIKE 'comment.%' THEN ${pk} IN ('issue','wiki') AND json_type(${r},'$.parentId')='text' ELSE json_type(${r},'$.parentKind') IS NULL AND json_type(${r},'$.parentId') IS NULL END`;
 return {supported,permissions:workPermissionSql(k,i),preparedVisible:workTargetVisible(k,p,t,pk,pi,false),confirmedVisible:workTargetVisible(k,p,t,pk,pi,true)};
}
