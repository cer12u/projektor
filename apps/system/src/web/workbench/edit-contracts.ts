// @module workbench
// @role contracts
import type {ContentReference} from "../../modules/work/reference-contracts";
import type {BodyDocument,EditingResource} from "../../modules/work/content-contracts";
import type {IssueChanges} from './editor-contracts';
import type {AttributeDraft} from './attribute-draft';
export type SaveState='clean'|'dirty'|'saving'|'unknown'|'conflict'|'reauth'|'blocked'|'invalid';
export interface Pending {
  owner:string;operationId:string;projectId:string;issueId?:string;resourceKey?:string;body:string;title?:string;references?:ContentReference[];revision?:number;changes?:IssueChanges;
  nonApplication?:'pre_dispatch';attempts:number;queries:number;lastAttemptAt:number;createdAt:number;phase:'prepared'|'sending'|'unknown'|'unconfirmed'|'auth'|'rejected'|'confirmed';
}
export interface EditRecord{schema:1;owner:string;targetId:string;unitId:string;projectId:string;resource?:EditingResource;text:string;title?:string;references?:ContentReference[];attributes?:AttributeDraft;heldOperations?:Pending[];base:BodyDocument|null;pending:Pending|null;latest:BodyDocument|null;status:SaveState;updatedAt:number;message:string;fields:Record<string,string>}

export type Journal=Omit<Pending,'body'>&{body?:string};
