// @module workbench
// @role controller
import {useEffect,useState,type FormEvent} from 'react';
import {type Issue} from './editor-contracts';
import {type IssueApi} from './issue-api';
import {urlState,changeIssueQuery} from './planning-location';
export function useMyIssuesController({api,project,open,onZone}:{api:IssueApi;project:string;open:(id:string)=>void;onZone:(zone:string)=>void}){
 const [query,setQuery]=useState(urlState),[search,setSearch]=useState(query.q),[items,setItems]=useState<Issue[]>([]),[total,setTotal]=useState(0),[message,setMessage]=useState(''),[serial,setSerial]=useState(0),[loading,setLoading]=useState(false);
 function update(change:Partial<typeof query>){setQuery(changeIssueQuery(project,query,change));}
 useEffect(()=>{const restore=()=>{const q=urlState();setQuery(q);setSearch(q.q);};window.addEventListener('popstate',restore);const channel=new BroadcastChannel('projektor-editor-events');channel.onmessage=()=>setSerial(v=>v+1);return()=>{window.removeEventListener('popstate',restore);channel.close();};},[]);
 useEffect(()=>{onZone(query.zone);},[query.zone,onZone]);
 useEffect(()=>{let live=true;setLoading(true);const p={q:query.q,state:query.state,mine:query.mine,page:query.page,pageSize:query.pageSize,order:'priority' as const};void api.list(project,p).then(r=>{if(live){setItems(r.issues);setTotal(r.total);setMessage('');}}).catch(()=>{if(live){setItems([]);setMessage('一覧を取得できません。条件と接続を確認してください。');}}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[api,project,query.q,query.state,query.mine,query.page,query.pageSize,serial]);
 function filter(e:FormEvent){e.preventDefault();update({q:search,page:'1'});}
 const pages=Math.max(1,Math.ceil(total/Number(query.pageSize)));
return {open,query,search,setSearch,items,total,message,setSerial,loading,update,filter,pages};
}
