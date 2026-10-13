// @module browser-session
// @role authority
import type {Identity} from "../../modules/identity/dto";
import type {PrincipalReader} from './session-contracts';
import {request} from './http-client';
import {HttpError} from '../platform/index';
import {SubjectChanged} from './subject-changed';
import {identityObservation,recordIdentity,latestIdentity,AuthorityChanged} from './identity-observation';
/** Correlates a /me response to the current UI authority and expected principal. */
export class PrincipalObservation {
  constructor(readonly owner:string,private identityChanged:(identity:Identity)=>void){}
  async read():Promise<Identity>{const current=identityObservation(),result=await request<Identity>('/api/auth/me');let i=result;if(current()){recordIdentity(i);this.identityChanged(i);}else{const latest=latestIdentity();if(latest===null)throw new HttpError(401,'unauthenticated');if(latest===undefined)throw new AuthorityChanged();i=latest;}if(i.principal.id!==this.owner)throw new SubjectChanged(i);return i;}

}

export function createPrincipalReader(owner:string,identityChanged:(identity:Identity)=>void):PrincipalReader {
  return new PrincipalObservation(owner,identityChanged);
}
