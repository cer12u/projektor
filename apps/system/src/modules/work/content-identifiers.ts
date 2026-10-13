// @module work
// @role public-value-policy
import type {BodyDocument, EditingResource} from './content-model';
export const resourceKey=(r:EditingResource)=>r.kind==='comment'?`comment:${r.parentKind}:${r.parentId}`:r.kind;
export const idPrefix=(r:Pick<EditingResource,'kind'>)=>r.kind==='issue'?'I_':r.kind==='wiki'?'W_':'C_';
export const uuidPattern='[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}';
export const contentIdPattern=(r:Pick<EditingResource,'kind'>)=>`(?:${idPrefix(r)}[a-f0-9]{64}|${uuidPattern})`;
export const validContentId=(r:Pick<EditingResource,'kind'>,value:string)=>new RegExp('^'+contentIdPattern(r)+'$').test(value);
export const scopeOf=(d:BodyDocument)=>d.scopeId??d.projectId??(d.workspaceId?'workspace:'+d.workspaceId:'');
