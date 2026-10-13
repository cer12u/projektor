// @module identity
// @role maintenance-spi
/** Explicit subject mapping only, invoked from controlled import composition. */
import type {AuthDB} from "../primitives";
import {ApiError} from "../../protocol-errors";
import {isPermission} from "../../../modules/identity/public";
export interface IdentityImport {subjects:readonly {id:string;kind:'human'|'agent';displayName:string;loginId:string|null;active:boolean;globalAdministrator:boolean}[];permissions:readonly {principalId:string;scopeId:string;permissions:readonly string[]}[]}
export async function importIdentityDataset(db:AuthDB,data:IdentityImport):Promise<void>{
 for(const s of data.subjects){const existingRights=await db.prepare('SELECT project_id,permission FROM memberships WHERE principal_id=?').bind(s.id).all<{project_id:string;permission:string}>();if(existingRights.results.some(r=>!data.permissions.some(p=>p.principalId===s.id&&p.scopeId===r.project_id&&p.permissions.includes(r.permission))))throw new ApiError(409,'unmapped_existing_permission');await db.prepare('INSERT OR IGNORE INTO principals VALUES(?,?,?,?,?,1)').bind(s.id,s.kind,s.displayName,s.loginId,s.active?1:0).run();const row=await db.prepare('SELECT kind,display_name,login_id,active FROM principals WHERE id=?').bind(s.id).first<{kind:string;display_name:string;login_id:string|null;active:number}>();if(!row||row.kind!==s.kind||row.display_name!==s.displayName||row.login_id!==s.loginId||row.active!==(s.active?1:0))throw new ApiError(409,'import_subject_mismatch');await db.prepare('UPDATE principal_management SET global_administrator=? WHERE principal_id=?').bind(s.globalAdministrator?1:0,s.id).run();}
 for(const p of data.permissions)for(const permission of p.permissions)await db.prepare('INSERT OR IGNORE INTO memberships VALUES(?,?,?)').bind(p.principalId,p.scopeId,permission).run();
}

/** Identity mappings are validated before the importer opens its write gate. */
export function validateIdentityImport(data:IdentityImport):void{
 const subjectIds=new Set(data.subjects.map(s=>s.id)),identifier=/^[A-Za-z0-9_-]{1,128}$/;
 if(new Set(data.subjects.map(s=>s.id)).size!==data.subjects.length||new Set(data.permissions.map(p=>p.principalId+':'+p.scopeId)).size!==data.permissions.length)throw new ApiError(400,'duplicate_mapping');
 for(const p of data.permissions){if(!subjectIds.has(p.principalId))throw new ApiError(400,'subject_mapping_missing');if(!identifier.test(p.principalId)||!(/^[A-Za-z0-9_-]{1,128}$/.test(p.scopeId)||/^workspace:[a-fA-F0-9-]{36}$/.test(p.scopeId))||p.permissions.some(v=>!isPermission(v))||new Set(p.permissions).size!==p.permissions.length||(p.permissions.length&&!p.permissions.includes('view')))throw new ApiError(400,'explicit_permission_mapping_required');}
 for(const s of data.subjects){if(!identifier.test(s.id)||!['human','agent'].includes(s.kind)||typeof s.active!=='boolean'||typeof s.globalAdministrator!=='boolean'||(s.kind==='agent'&&(s.loginId!==null||s.globalAdministrator))||(s.kind==='human'&&(typeof s.loginId!=='string'||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s.loginId))))throw new ApiError(400,'explicit_subject_mapping_required');}
}
