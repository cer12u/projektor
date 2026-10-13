// @module workbench
// @role controller
import {useEffect,useState,useSyncExternalStore,type FormEvent} from 'react';
import {type Schedule} from "../../modules/work/planning-contracts";
import type {Identity} from "../../modules/identity/dto";
import type {IssueEditor} from './editor';
import {type Issue} from './editor-contracts';
import {attributeChanges,scheduleDraft,type TimeDraft} from './attribute-draft';
export function useIssueAttributesController({editor,issue,identity,disabled,zone}:{editor:IssueEditor;issue:Issue;identity:Identity;disabled:boolean;zone:string}){
 const [people,setPeople]=useState<{id:string;kind:string;displayName:string}[]>([]),[message,setMessage]=useState('');
 const draft=useSyncExternalStore(editor.subscribe,editor.snapshot).record.attributes??{},priority=draft.priority??issue.priority?.toString()??'',assignee=draft.assigneeId??issue.assigneeId??'',state=draft.state??issue.state,schedule=draft.schedule??scheduleDraft(issue.schedule,zone),times=schedule.times;
 const setTime=(key:keyof Schedule,value:TimeDraft)=>editor.inputAttributes({schedule:{...schedule,times:{...times,[key]:value}}});
 const rights=identity.projects.find(p=>p.id===issue.projectId)?.permissions??[];

 useEffect(()=>{let live=true;void editor.api.assignees(issue.projectId).then(r=>{if(live)setPeople(r.principals);}).catch(()=>setMessage('担当候補を取得できません。'));return()=>{live=false;};},[editor,issue.projectId]);
 async function save(event:FormEvent){event.preventDefault();setMessage('');try{const attributes={priority:draft.priority,assigneeId:draft.assigneeId,state:draft.state,schedule:draft.schedule};const changes=attributeChanges(attributes,issue,rights);if(!Object.keys(changes).length){setMessage('現在の権限で保存できる変更はありません。未保存の入力は保持しています。');return;}await editor.saveAttributes(changes);}catch(error){setMessage(error instanceof Error?error.message:'入力を確認してください。');}}
return {editor,issue,identity,disabled,zone,people,message,draft,priority,assignee,state,schedule,times,setTime,rights,save};
}
