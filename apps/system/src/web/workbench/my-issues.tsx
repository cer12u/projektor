// @module workbench
// @role composition
import {useMyIssuesController} from './my-issues-controller';
import {MyIssuesView} from './my-issues-view';
import {type IssueApi} from './issue-api';
export function MyIssues({api,project,open,onZone}:{api:IssueApi;project:string;open:(id:string)=>void;onZone:(zone:string)=>void}){return <MyIssuesView model={useMyIssuesController({api,project,open,onZone})}/>;}
