// @module workbench
// @role composition
import {useContentListController} from './content-list-controller';
import {ContentListView} from './content-list-view';
import {type IssueApi} from './issue-api';
export function ContentList({api,project,epoch,open}:{api:IssueApi;project:string;epoch:number;open:(id:string)=>void}){return <ContentListView model={useContentListController({api,project,epoch,open})}/>;}
