// @module workbench
// @role controller
import {useEffect,useMemo,useRef,useState} from 'react';
import type {ExecutionReports,ReportHistory} from '../../modules/execution/public';
import {onAuthorityChanged} from '../session/access';
import type {IssueApi} from './issue-api';
export interface ExecutionPanelProps {api:IssueApi;projectId:string;issueId:string;ownerId:string;zone:string}
export function useIssueExecutionController({api,projectId,issueId,ownerId,zone}:ExecutionPanelProps){
 const owner=useMemo(()=>({}),[api,projectId,issueId,ownerId]),active=useRef(owner);active.current=owner;
 const generation=useRef(0),busy=useRef(false);
 const [state,setState]=useState<{owner:object;reports:ExecutionReports|null;events:ReportHistory['events'];nextAfter:number|null;loading:boolean;message:string}>({owner,reports:null,events:[],nextAfter:null,loading:false,message:''});
 const visible=state.owner===owner?state:{owner,reports:null,events:[],nextAfter:null,loading:false,message:''};
 function clear(message=''){generation.current++;busy.current=false;setState({owner,reports:null,events:[],nextAfter:null,loading:false,message});}
 async function load(append=false){
  if(busy.current||active.current!==owner)return;
  if(append&&visible.nextAfter===null)return;
  busy.current=true;const version=++generation.current;
  const current=()=>active.current===owner&&generation.current===version;
  setState(s=>({...s,owner,loading:true,message:''}));
  try{
   if(append){const history=await api.executionHistory(projectId,issueId,visible.nextAfter!);if(!current())return;api.assertCurrent(history);
    setState(s=>({...s,events:[...new Map([...s.events,...history.events].map(e=>[e.sequence,e])).values()].sort((a,b)=>a.sequence-b.sequence),nextAfter:history.nextAfter,loading:false}));
   }else{
    const reports=await api.executionReports(projectId,issueId);if(!current())return;api.assertCurrent(reports);
    const history=await api.executionHistory(projectId,issueId);if(!current())return;api.assertCurrent(reports);api.assertCurrent(history);
    setState({owner,reports,events:history.events,nextAfter:history.nextAfter,loading:false,message:''});
   }
  }catch{if(current())clear('実行記録を取得できません。現在の閲覧許可を確認して再取得してください。');}
  finally{if(current())busy.current=false;}
 }
 useEffect(()=>{
  clear();
  const unsubscribe=onAuthorityChanged(()=>clear('本人・権限が変わったため実行記録を非表示にしました。再取得してください。'));
  const denied=api.onReadDenied((project,target)=>{if(project===projectId&&target===issueId)clear('閲覧が拒否されたため実行記録を非表示にしました。');});
  void load();
  return()=>{generation.current++;busy.current=false;unsubscribe();denied();};
 // Each identity/target gets a fresh request lifetime. Display is fenced during render, before effects run.
 },[owner]);
 return {...visible,zone,load};
}
