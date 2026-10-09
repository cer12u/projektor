// TEST ONLY. The real app-auth entry, schema, KDF and Store run in workerd.
// Host-only inspection/approval is never exposed through the browser fetch port.
import {randomUUID,randomBytes} from 'node:crypto';
import {Miniflare,createFetchMock} from 'miniflare';
const origin='https://app-auth-fixture.invalid';
const scopes=['operations:read_own','issue:read','issue:write','comment:write','history:read','progress:write','issue:transition'];
export async function startAppAuthHarness({accessLeaseMs=300000,onStage=()=>{}}={}){
 const ids=Object.fromEntries(['workspace','epoch','actor','credential','issue','project','authEpoch'].map(key=>[key,randomUUID()]));
 ids.actorA=ids.actor;
 const controlSecret=randomBytes(32).toString('hex');
 const mock=createFetchMock();mock.disableNetConnect();
 const mf=new Miniflare({cf:false,name:'app-auth-product',unsafeInspectDurableObjects:true,modules:true,
  modulesRoot:new URL('../',import.meta.url).pathname,scriptPath:new URL('../service-test/app-auth-entry-fixture.mjs',import.meta.url).pathname,
  compatibilityDate:'2024-09-23',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public','cache_option_enabled'],
  modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],fetchMock:mock,
  bindings:{FIXTURE_CONTROL_SECRET:controlSecret,APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',
   JWT_SECRET:randomBytes(32).toString('hex'),
   APP_AUTH_CONFIG:JSON.stringify({version:1,workspaceId:ids.workspace,humanPrincipalId:ids.actor,authEpoch:ids.authEpoch,
    policy:{idleMs:600000,absoluteMs:3600000,accessLeaseMs,rotationIntervalMs:2000,retryGraceMs:1000,receiptMs:120000}})},
  durableObjects:{WORKSPACE:{className:'AppAuthFixtureWorkspace',useSQLite:true}}});
 onStage('runtime-start');await mf.ready;onStage('runtime-ready');
 const admission=await mf.dispatchFetch(origin+'/v1/auth/csrf');onStage('initial-http-'+admission.status);if(admission.status!==200)throw Error('Fixture app auth admission failed: '+await admission.text());
 async function hostControl(input){const r=await mf.dispatchFetch(origin+'/__fixture/control',{method:'POST',headers:{'content-type':'application/json','x-fixture-control':controlSecret},body:JSON.stringify(input)});if(!r.ok)throw Error('Host fixture control failed: '+r.status);return r.json();}
 const db={exec:(sql,...args)=>hostControl({action:'sql',sql,args})};
 onStage('store-open');await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);
 await db.exec('INSERT INTO project VALUES(?,?,1,0)',ids.project,'App session fixture project');
 await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",ids.actor);
 await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',ids.actor,ids.project);
 await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.actor,Number.MAX_SAFE_INTEGER);
 for(const scope of scopes){await db.exec('INSERT INTO principal_scope VALUES(?,?)',ids.actor,scope);await db.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,scope);}
 await db.exec("INSERT INTO app_auth_principal(principal_id,credential_id,role,auth_version,grant_generation,disabled) VALUES(?,?,'owner',0,0,0)",ids.actor,ids.credential);
 const seeded=await hostControl({action:'seedIssue',command:{schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId:randomUUID(),commandType:'Issue.Create',entityId:ids.issue,expectedVersion:0,payload:{projectId:ids.project,title:'App session fixture issue',description:'Synthetic editable content',assigneeId:ids.actor,priority:'P1',parentId:null,initialStatus:'ready'}}});
 if(!seeded.data)throw Error('Canonical fixture seed failed: '+JSON.stringify(seeded));
 onStage('seed-complete');
 async function approveGrant({grantId,fingerprint,purpose='enroll'}){
  const row=(await db.exec('SELECT role,auth_version,grant_generation FROM app_auth_principal WHERE principal_id=?',ids.actor))[0];
  return hostControl({action:'approve',plan:{grantId,principalId:ids.actor,role:row.role,purpose,
   expectedAuthVersion:row.auth_version,generation:row.grant_generation+1,secretDigest:fingerprint,expiresAt:Date.now()+600000}});
 }
 async function control(action,...args){
  if(['armBodyBarrier','bodyBarrierState','releaseBodyBarrier'].includes(action))return hostControl({action});
  if(action==='sql')return db.exec(args[0],...(args[1]??[]));
  if(action==='expireSessionLease')return db.exec('UPDATE app_auth_session SET rotated_at=?',Date.now()-10000);
  if(action==='expireSessionAbsolute')return db.exec('UPDATE app_auth_session SET absolute_expires_at=0');
  if(action==='revokeSession')return db.exec('UPDATE app_auth_session SET revoked=1');
  if(action==='revokeMembership')return db.exec('UPDATE membership SET revoked=1 WHERE principal_id=?',ids.actor);
  if(action==='inspect')return (await db.exec('SELECT (SELECT count(*) FROM operation) AS operations,(SELECT count(*) FROM identity_binding) AS identityBindings,(SELECT count(*) FROM app_auth_session) AS sessions,(SELECT count(*) FROM app_auth_grant WHERE consumed_operation_id IS NOT NULL) AS consumedGrants'))[0];
  throw Error('Unknown host-only app-auth fixture control');
 }
 let closed=false;
 return {base:origin,ids,approveGrant,control,
  fetch:(input,init)=>{if(new URL(input instanceof URL?input.href:typeof input==='string'?input:input.url).pathname.startsWith('/__fixture/'))return Promise.resolve(new Response(null,{status:404}));return mf.dispatchFetch(input,init);},
  async close(){if(closed)return;closed=true;await mf.dispose();}};
}
