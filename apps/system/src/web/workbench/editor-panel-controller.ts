// @module workbench
// @role controller
import {copyDraftText,downloadDraft} from './draft-export';
import type {Directory} from './directory-model';
import {HttpError} from '../platform/index';
import {type EditingResource} from "../../modules/work/content-contracts";
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {Identity} from "../../modules/identity/dto";
import {IssueEditor} from './editor';
import {type IssueHistory} from './editor-contracts';
export function useEditorPanelController({directory,editor,canEdit,identity,zone,identityChanged,openContent}:{directory:Directory|null;editor:IssueEditor;canEdit:boolean;identity:Identity;zone:string;identityChanged:(i:Identity)=>void;openContent:(r:EditingResource,id?:string)=>void}){
  const view=useSyncExternalStore(editor.subscribe,editor.snapshot),r=view.record,label=editor.api.resource.kind==='issue'?'Issue':editor.api.resource.kind==='wiki'?'Wiki':'コメント';
  const canView=identity.projects.some(p=>p.id===r.projectId&&p.permissions.includes('view'));
  const [historyRows,setHistory]=useState<IssueHistory[]>([]),[historyMessage,setHistoryMessage]=useState(''),[copyMessage,setCopyMessage]=useState('');
  const [historyAfter,setHistoryAfter]=useState<number|null>(null),[historyLoading,setHistoryLoading]=useState(false);
  const historyOwner=useRef(editor);historyOwner.current=editor;
  useEffect(()=>{setHistory([]);setEvents([]);setHistoryAfter(null);setHistoryMessage('');setHistoryLoading(false);},[editor,view.accessLost,canView]);
  const [events,setEvents]=useState<{revision:number;kind:string;time:import("../../modules/work/planning-contracts").TimeValue}[]>([]);
  const textRef=useRef<HTMLTextAreaElement>(null);
  async function copy(){try{await copyDraftText(r.text);setCopyMessage('入力をコピーしました。');}catch{textRef.current?.focus();textRef.current?.select();setCopyMessage('入力を選択しました。コピー操作を行ってください。');}}
  function download(){downloadDraft(r); }
  async function history(append=false){
    if(historyLoading)return;const owner=editor;setHistoryLoading(true);
    try{const result=await editor.api.history(r.projectId,r.targetId,append?historyAfter??0:0);if(historyOwner.current!==owner)return;editor.api.assertCurrent(result);
      setHistory(rows=>append?[...new Map([...rows,...result.history].map(row=>[row.revision,row])).values()].sort((a,b)=>a.revision-b.revision):result.history);
      setEvents(rows=>append?[...new Map([...rows,...result.resolutionEvents].map(row=>[row.revision,row])).values()].sort((a,b)=>a.revision-b.revision):result.resolutionEvents);
      const cursors=[result.nextAfterRevision,result.nextResolutionAfterRevision].filter((cursor):cursor is number=>cursor!==null);setHistoryAfter(cursors.length?Math.min(...cursors):null);setHistoryMessage('');
    }catch(error){if(historyOwner.current===owner){if(error instanceof HttpError&&[401,403].includes(error.status)){setHistory([]);setEvents([]);setHistoryAfter(null);}setHistoryMessage('履歴を取得できません。入力は保持しています。');}}finally{if(historyOwner.current===owner)setHistoryLoading(false);}
  }

return {directory,editor,canEdit,identity,zone,identityChanged,openContent,view,r,label,canView,historyRows,historyMessage,copyMessage,historyAfter,historyLoading,events,textRef,copy,download,history};
}
