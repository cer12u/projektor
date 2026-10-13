// @module workbench
// @role adapter
import {onAuthorityChanged,currentIdentity as latestIdentity,captureCredentialLease,type AuthorityLease} from '../session/access';
import type {IssueApi} from './issue-api';
import type {EditRecord} from './edit-contracts';
/** Owns subscriptions and cross-tab refresh signals for one editor lifetime. */
export class EditorLifecycle {
  private releaseReadDenial:()=>void;private releaseAuthority:()=>void;private visibleCredential:AuthorityLease=()=>false;
  private channel:BroadcastChannel|null=null;
  constructor(api:IssueApi,project:string,record:()=>EditRecord,active:()=>boolean,loseAccess:()=>void,refresh:()=>Promise<void>){
    this.releaseReadDenial=api.onReadDenied((scope,target)=>{if(active()&&scope===record().projectId&&target===api.documentId(record().targetId))loseAccess();});
    this.releaseAuthority=onAuthorityChanged(()=>{const i=latestIdentity();if(active()&&api.documentId(record().targetId)&&(!i||i.principal.id!==api.owner||!i.projects.some(p=>p.id===record().projectId&&p.permissions.includes('view'))||!this.visibleCredential()))loseAccess();});
    if(typeof BroadcastChannel!=='undefined'){this.channel=new BroadcastChannel('projektor-editor-events');this.channel.onmessage=e=>{const v=e.data as {kind?:string;owner?:string;id?:string;projectId?:string;revision?:number};
      if(v.kind==='confirmed'&&v.owner===api.owner&&api.storageTarget(v.id??'')===record().targetId&&v.projectId===project)void refresh();};}
  }
  recordVisibleCredential(){this.visibleCredential=captureCredentialLease();}
  announce(owner:string,projectId:string,id:string,revision:number){this.channel?.postMessage({kind:'confirmed',owner,projectId,id,revision});}
  dispose(){this.releaseReadDenial();this.releaseAuthority();this.channel?.close();this.channel=null;}
}
