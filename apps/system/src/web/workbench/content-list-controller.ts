// @module workbench
// @role controller
import {useEffect,useState} from 'react';
import type {BodyDocument} from "../../modules/work/content-contracts";
import {type IssueApi} from './issue-api';
export function useContentListController({api,project,epoch,open}:{api:IssueApi;project:string;epoch:number;open:(id:string)=>void}){
 const[page,setPage]=useState(1),[value,setValue]=useState<{documents:BodyDocument[];total:number;page:number;pageSize:number}|null>(null),[message,setMessage]=useState('');
 useEffect(()=>{let cancelled=false;setMessage('読み込み中…');void api.documents(project,page).then(v=>{if(!cancelled){setValue(v);setMessage('');}},()=>{if(!cancelled){setValue(null);setMessage('一覧を取得できません。権限と接続を確認してください。');}});return()=>{cancelled=true;};},[api,project,page,epoch]);
 const label=api.resource.kind==='wiki'?'Wiki':'コメント';
return {open,page,setPage,value,message,label};
}
