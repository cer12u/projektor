// @module work
// @role private-d1
import type {AuthDB} from "../primitives";
import type {Authenticated} from "../identity/authorization";
import {issueJson} from './issues';
import {validateIssueRoute,validateIssueListQuery} from "../../../modules/work/rules";
import {currentCredentialSql} from "../identity/authorization";
import {MutationError} from "../persistence/public";
import {sql} from "../primitives";
import {activeViewMembersSql} from "../identity/authorization";
import { permissionSql } from "../identity/authorization";
import type {IssueListQuery} from "../../../modules/work/public";
async function guardedRead(db:AuthDB,auth:Authenticated,project:string,data:{text:string;values:readonly(string|number|null)[]}){
 const credential=currentCredentialSql(auth),rights=permissionSql(auth,project,'view'),q=sql(`SELECT (${credential.text}) AS authenticated,(${rights.text}) AS permitted,CASE WHEN (${credential.text}) AND (${rights.text}) THEN (${data.text}) ELSE NULL END AS data`,...credential.values,...rights.values,...credential.values,...rights.values,...data.values);
 const row=await db.prepare(q.text).bind(...q.values).first<{authenticated:number;permitted:number;data:string|null}>();if(!row?.authenticated)throw new MutationError(401,'unauthenticated');if(!row.permitted||row.data===null)throw new MutationError(403,'forbidden');return JSON.parse(row.data) as unknown;
}
export async function listIssues(db:AuthDB,auth:Authenticated,project:string,query:IssueListQuery){
 validateIssueRoute(project);validateIssueListQuery(query);const where='i.project_id=? AND (?=0 OR i.assignee_id=?) AND (?=\'\' OR i.state=?) AND (?=\'\' OR instr(lower(i.title||char(32)||i.body),lower(?))>0)',values=[project,query.mine?1:0,auth.id,query.state,query.state,query.q,query.q],order='i.priority IS NULL ASC,i.priority DESC,i.created_at ASC,i.id ASC';
 const data=sql(`SELECT json_object('issues',json((SELECT json_group_array(json(entry)) FROM(SELECT ${issueJson('i')} AS entry FROM issues i WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?))),'total',(SELECT count(*) FROM issues i WHERE ${where}),'page',?,'pageSize',?,'order','priority')`,...values,query.pageSize,(query.page-1)*query.pageSize,...values,query.page,query.pageSize);return guardedRead(db,auth,project,data);
}
export async function listAssignees(db:AuthDB,auth:Authenticated,project:string){
 validateIssueRoute(project);const members=activeViewMembersSql(sql('?',project));
 return guardedRead(db,auth,project,sql(`SELECT json_object('principals',json((SELECT json_group_array(json(entry)) FROM(SELECT json_object('id',p.id,'kind',p.kind,'displayName',p.display_name) AS entry FROM (${members.text}) p ORDER BY p.display_name,p.id))))`,...members.values));
}
