import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { openStore,migrate } from '../src/core.mjs';
export const ids={workspace:'10000000-0000-4000-8000-000000000001',epoch:'10000000-0000-4000-8000-000000000002',actor:'10000000-0000-4000-8000-000000000003',credential:'10000000-0000-4000-8000-000000000004',issue:'10000000-0000-4000-8000-000000000005',project:'10000000-0000-4000-8000-000000000006'};
export const now=1800000000000;
export const actor={principalId:ids.actor,actorKind:'machine',credentialId:ids.credential,authMethod:'synthetic-fixture-only',credentialExpiresAt:now+3600000,workspaceId:ids.workspace,authenticatedAt:now,requestId:'fixture-request'};
export const command=(overrides={})=>({schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:ids.issue,expectedVersion:7,payload:{title:'新しい title'},...overrides});
export const restRequest=body=>({workspaceId:body.workspaceId,entityId:body.entityId,idempotencyKey:body.operationId,body});
export function fixture(){
 const dir=mkdtempSync(new URL('../evidence/db-',import.meta.url).pathname);const path=join(dir,'fixture.sqlite');const db=openStore(path);migrate(db);
 db.prepare('INSERT INTO workspace VALUES(?,?,1,0)').run(ids.workspace,ids.epoch);
 db.prepare('INSERT INTO membership VALUES(?,?,0,1)').run(ids.actor,'machine');
 db.prepare('INSERT INTO credential VALUES(?,?,?,0,1,1)').run(ids.credential,ids.actor,actor.credentialExpiresAt);
 db.prepare('INSERT INTO project_grant VALUES(?,?,1,1)').run(ids.actor,ids.project);
 db.prepare('INSERT INTO issue VALUES(?,?,?,7,0)').run(ids.issue,ids.project,'original title');
 db.prepare('INSERT INTO issue_fts VALUES(?,?)').run(ids.issue,'original title');
 return {db,path,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
export function snapshot(db){return Object.fromEntries(['workspace','issue','activity','issue_fts','outbox','operation'].map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all().map(r=>({...r}))]));}
