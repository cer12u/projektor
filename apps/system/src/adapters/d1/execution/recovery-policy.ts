// @module execution
// @role private-d1
import {sql,type Sql,type OperationRowExpressions} from "../persistence/transaction";
import {issueVisibleSql} from "../work/transaction";
const q=(strings:TemplateStringsArray,...parts:Sql[]):Sql=>sql(strings.reduce((s,x,i)=>s+(i?parts[i-1].text:'')+x,''),...parts.flatMap(p=>p.values));
import {executionPermissions,executionKinds,reportKinds} from "../../../modules/execution/rules";
export function executionRecovery(tag:'execution'|'report',row:OperationRowExpressions){
 const {operationKind:k,routeJson:r,inputJson:i}=row,prefix=tag==='execution'?'execution.':'execution-report.',kinds=tag==='execution'?executionKinds:reportKinds;
 const recognized=sql(kinds.map(kind=>`${k.text}='${kind}'`).join(' OR '),...kinds.flatMap(()=>k.values));
 const supported=q`(${recognized}) AND json_extract(${r},'$.projectId')=${row.projectId} AND json_extract(${i},'$.operationId')=${row.operationId} AND json_extract(${r},'$.kind')=${sql("'"+tag+"'")} AND json_extract(${r},'$.issueId')=${row.targetId} AND ${sql("'"+prefix+"'")}||json_extract(${r},'$.action')=${k} AND NOT EXISTS(SELECT 1 FROM json_each(${r}) WHERE key NOT IN ('kind','projectId','issueId','action'))`;
 const visible=issueVisibleSql(row.projectId,row.targetId);
 return {supported,permissions:sql("'"+JSON.stringify(['view',...executionPermissions])+"'"),preparedVisible:visible,confirmedVisible:visible};
}
