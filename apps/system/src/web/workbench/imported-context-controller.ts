// @module workbench
// @role controller
import {useEffect,useRef,useState} from 'react';
import {scopeOf,type BodyDocument,type EditingResource} from "../../modules/work/content-contracts";
import {type IssueChanges} from './editor-contracts';
import type {IssueEditor} from './editor';
import type {AttributeDraft} from './attribute-draft';
import {SourceView,Directory} from './directory-model';
export function useImportedContextController({document,resource,open,editor,directory,canEdit,draft={}}:{draft?:AttributeDraft;document:BodyDocument;resource:EditingResource;open:(r:EditingResource,id?:string)=>void;editor:IssueEditor;directory:Directory|null;canEdit:boolean}){
 const [source,setSource]=useState<SourceView|null>(null),[message,setMessage]=useState('');
 const scope=scopeOf(document),version=useRef(0);
 useEffect(()=>{version.current++;setSource(null);setMessage('');return()=>{version.current++;};},[editor,document.id,scope]);
 async function load(page=1){const current=++version.current;try{const value=await editor.api.source<SourceView>(scope,document.id,page);if(current!==version.current)return;editor.api.assertCurrent(value);setSource(value);setMessage('');}catch{if(current!==version.current)return;setSource(null);setMessage('移行原記録はこの本文では取得できません。');}}
 const workspaceId=document.workspaceId??directory?.projects.find(p=>p.id===document.projectId)?.workspaceId,definitionScope=workspaceId?'workspace:'+workspaceId:null;
 const current=document as BodyDocument&{parentId?:string|null;typeId?:string|null;number?:number|null;createdById?:string|null;statusId?:string|null;priorityKey?:string|null};
 const parent=draft.parentId??current.parentId??'',type=draft.typeId??current.typeId??'';
 async function save(changes:IssueChanges){await editor.saveAttributes(changes);}
return {document,resource,open,editor,directory,canEdit,source,message,load,definitionScope,current,parent,type,save};
}
