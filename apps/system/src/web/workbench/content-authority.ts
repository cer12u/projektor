// @module workbench
// @role authority
import type {Identity} from "../../modules/identity/dto";
import {createPrincipalReader,type PrincipalReader} from '../session/access';
import {HttpError} from '../platform/index';
import {SubjectChanged} from '../session/access';
import {sessionRequest} from '../session/access';
import {captureAuthorityLease as authorityObservation,AuthorityChanged} from '../session/access';
/** Fences protected results against current principal, scope and target authority. */
export class ContentAuthority {
  private readonly principal:PrincipalReader;
  constructor(owner:string,identityChanged:(identity:Identity)=>void){this.principal=createPrincipalReader(owner,identityChanged);}
  private readonly resultLeases=new WeakMap<object,()=>boolean>();
  assertCurrent(value:object){if(!this.resultLeases.get(value)?.())throw new AuthorityChanged();}
  private readonly readDenials=new Set<(project:string,target:string)=>void>();
  private readonly targetVersions=new Map<string,number>();
  onReadDenied(listener:(project:string,target:string)=>void){this.readDenials.add(listener);return()=>{this.readDenials.delete(listener);};}
  private denyRead(project:string,target:string){const key=JSON.stringify([project,target]);this.targetVersions.set(key,(this.targetVersions.get(key)??0)+1);for(const listener of this.readDenials)listener(project,target);}
  async observe<T>(project:string|undefined,work:(identity:Identity)=>Promise<T>,target?:string):Promise<T>{return sessionRequest(async()=>{
    const key=JSON.stringify([project,target]),version=this.targetVersions.get(key)??0;
    const fence=()=>{if(target&&(this.targetVersions.get(key)??0)!==version)throw new AuthorityChanged();};
    const identity=await this.principal.read();fence();const authority=authorityObservation();
    if(project&&!identity.projects.some(p=>p.id===project&&p.permissions.includes('view')))throw new HttpError(403,'forbidden');
    let result:T;
    try{result=await work(identity);fence();}catch(error){
      if(error instanceof AuthorityChanged||(error instanceof HttpError&&error.status===401))throw error;
      try{const after=await this.principal.read();fence();if(project&&!after.projects.some(p=>p.id===project&&p.permissions.includes('view')))throw new HttpError(403,'forbidden');}
      catch(refresh){if(refresh instanceof AuthorityChanged||refresh instanceof SubjectChanged||(refresh instanceof HttpError&&[401,403].includes(refresh.status)))throw refresh;}
      if(!authority())throw new AuthorityChanged();
      // A denied protected target is local to that target, not a global logout
      // and never proof that an attempted mutation was not applied.
      if(error instanceof HttpError&&error.status===403&&project&&target)this.denyRead(project,target);
      throw error;
    }
    const after=await this.principal.read();fence();if(!authority())throw new AuthorityChanged();
    if(project&&!after.projects.some(p=>p.id===project&&p.permissions.includes('view')))throw new HttpError(403,'forbidden');
    if(result&&typeof result==='object')this.resultLeases.set(result,()=>authority()&&(!target||(this.targetVersions.get(key)??0)===version));
    return result;
  });}
  async checkCreationPermission(project:string):Promise<void>{return sessionRequest(async()=>{const identity=await this.principal.read();if(!identity.projects.some(p=>p.id===project&&p.permissions.includes('view')&&p.permissions.includes('edit')))throw new HttpError(403,'forbidden');});
  }

}
