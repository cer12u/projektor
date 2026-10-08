// TEST ONLY. Exact product entry/verifier/Store; ephemeral synthetic provider.
// Host-only control uses Miniflare storage inspection, never a public SQL/RPC route.
import {createServer} from 'node:http';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Miniflare,createFetchMock} from 'miniflare';
const issuer='https://ephemeral-session-provider.invalid',origin='https://session-fixture.invalid';
const scopes=['operations:read_own','issue:read','issue:write','comment:write','history:read','progress:write','issue:transition'];
const identifiers=()=>Object.fromEntries(['workspace','epoch','actorA','actorB','issue','project','otherProject'].map(k=>[k,randomUUID()]));
export async function startHarness({bootstrapMode='one'}={}){
 const ids=identifiers(),second=identifiers();Object.assign(ids,{actor:ids.actorA,originalProject:ids.project,editorId:'title',secondWorkspace:second.workspace,secondActorA:second.actorA});
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'ephemeral-test',alg:'RS256',use:'sig'};
 const mock=createFetchMock();mock.disableNetConnect();mock.get(issuer).intercept({path:'/certs'}).reply(200,JSON.stringify({keys:[jwk]}),{headers:{'content-type':'application/json'}}).persist();
 const mf=new Miniflare({cf:false,name:'product',unsafeInspectDurableObjects:true,modules:true,modulesRoot:new URL('../',import.meta.url).pathname,scriptPath:new URL('../service/entry.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],fetchMock:mock,bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace,second.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',PROVIDER_CONFIG:JSON.stringify({issuer,jwksUrl:issuer+'/certs',humanAudience:'fixture-human',machineAudience:'fixture-machine',jwksCacheMs:60000,jwksTimeoutMs:500})},durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});
 const storage=f=>mf.unsafeGetDurableObjectStorage('product','WorkspaceService',{name:f.workspace});
 await mf.ready;
 for(const f of [ids,second]){
  const db=await storage(f);await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',f.workspace,f.epoch);
  for(const p of [f.project,f.otherProject])await db.exec('INSERT INTO project VALUES(?,?,1,0)',p,'Content fixture project');
  for(const a of [f.actorA,f.actorB]){
   await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",a);
   for(const scope of scopes)await db.exec('INSERT INTO principal_scope VALUES(?,?)',a,scope);
   for(const p of [f.project,f.otherProject])await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',a,p);
  }
  await db.exec('INSERT INTO issue VALUES(?,?,?,7,0)',f.issue,f.project,'original title');await db.exec('INSERT INTO issue_fts VALUES(?,?)',f.issue,'original title');
 }
 async function setBootstrapMode(mode){if(!['zero','one','multi'].includes(mode))throw Error('Invalid fixture mode');for(const f of [ids,second]){const db=await storage(f);await db.exec('UPDATE membership SET revoked=?',mode==='zero'||mode==='one'&&f===second?1:0);}}
 await setBootstrapMode(bootstrapMode);
 const contexts=new WeakMap();let base,closed=false;
 const server=createServer(async(incoming,outgoing)=>{
  try{
   if(incoming.headers.host!==new URL(base).host){outgoing.writeHead(403);outgoing.end();return;}
   const u=new URL(incoming.url,base);
   if(!u.pathname.startsWith('/v1/')&&!u.pathname.startsWith('/machine/')){outgoing.writeHead(404);outgoing.end();return;}
   const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
   // Loopback proxy maps only its exact verified test origin. Foreign Origins remain foreign.
   if(headers.get('origin')===base)headers.set('origin',origin);
   const init={method:incoming.method,headers};if(!['GET','HEAD'].includes(incoming.method)){init.body=incoming;init.duplex='half';}
   const response=await mf.dispatchFetch(origin+u.pathname+u.search,init);
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));if(response.body)for await(const chunk of response.body)outgoing.write(chunk);outgoing.end();
  }catch{if(!outgoing.headersSent)outgoing.writeHead(503);outgoing.end();}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});base=`http://127.0.0.1:${server.address().port}`;
 async function login(context,label='A',{renew=false,ttlSeconds=600}={}){
  if(!['A','B'].includes(label)||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>86400)throw Error('Invalid synthetic login');
  const old=contexts.get(context);if(renew&&old?.label!==label)throw Error('No matching synthetic session');
  const now=Math.floor(Date.now()/1000),expiresAt=(now+ttlSeconds)*1000,subject='fixture-'+label;
  const credentials={};
  for(const f of [ids,second]){
   const db=await storage(f),actor=f['actor'+label],credential=renew?old.credentials[f.workspace]:randomUUID();
   if(renew){const row=(await db.exec('SELECT * FROM credential WHERE id=?',credential))[0];if(!row||row.revoked||row.expires_at<=Date.now())throw Error('Session unavailable');await db.exec('UPDATE credential SET expires_at=? WHERE id=?',expiresAt,credential);}
   else{await db.exec('DELETE FROM identity_binding WHERE issuer=? AND subject=?',issuer,subject);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',credential,actor,expiresAt);for(const scope of scopes)await db.exec('INSERT INTO credential_scope VALUES(?,?)',credential,scope);await db.exec("INSERT INTO identity_binding VALUES(?,?,?,?,'human')",issuer,subject,credential,actor);}
   credentials[f.workspace]=credential;
  }
  const head=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:issuer,sub:subject,aud:['fixture-human'],type:'app',iat:now-10,nbf:now-10,exp:now+ttlSeconds})).toString('base64url');
  const token=`${head}.${payload}.${sign('RSA-SHA256',Buffer.from(`${head}.${payload}`),privateKey).toString('base64url')}`;
  await context.addCookies([{name:'CF_Authorization',value:token,url:base,httpOnly:true,secure:false,sameSite:'Strict'}]);
  contexts.set(context,{label,credentials});return {principalId:ids['actor'+label],credentialId:credentials[ids.workspace],sessionId:credentials[ids.workspace],expiresAt};
 }
 async function control(action,...args){const db=await storage(ids),actor=label=>label==='B'?ids.actorB:label==='A'||label===undefined?ids.actorA:label;
  if(action==='sql')return db.exec(args[0],...(args[1]??[]));
  if(action==='bootstrapMode')return setBootstrapMode(args[0]);
  if(action==='revokeCurrentProject'||action==='revokeOriginalProject'){const p=action==='revokeOriginalProject'?ids.project:(await db.exec('SELECT project_id FROM issue WHERE id=?',ids.issue))[0].project_id;return db.exec('UPDATE project_grant SET can_read=0 WHERE principal_id=? AND project_id=?',actor(args[0]),p);}
  if(action==='grantProject')return db.exec('INSERT INTO project_grant VALUES(?,?,1,1) ON CONFLICT(principal_id,project_id) DO UPDATE SET can_read=1,can_write=1',actor(args[0]),args[1]??ids.project);
  if(action==='revokeMembership')return db.exec('UPDATE membership SET revoked=1 WHERE principal_id=?',actor(args[0]));
  if(action==='revokeCredential')return db.exec('UPDATE credential SET revoked=1 WHERE principal_id=?',actor(args[0]));
  if(action==='expire')return db.exec('UPDATE credential SET expires_at=? WHERE principal_id=?',args[1]??0,actor(args[0]));
  if(action==='moveResource')return db.exec('UPDATE issue SET project_id=? WHERE id=?',args[0]??ids.otherProject,ids.issue);
  if(action==='deleteResource')return db.exec('UPDATE issue SET deleted=1 WHERE id=?',ids.issue);
  if(action==='revokeKey')return db.exec('UPDATE draft_key SET revoked=1 WHERE key_id=?',args[0]);
  if(action==='authzVersion')return (await db.exec('SELECT revision FROM query_state'))[0].revision;
  if(action==='effects'||action==='inspect'){const out={issue:(await db.exec('SELECT * FROM issue WHERE id=?',ids.issue))[0],workspace:(await db.exec('SELECT * FROM workspace'))[0]};for(const t of ['activity','outbox','operation','draft_key'])out[t]=(await db.exec(`SELECT count(*) AS n FROM ${t}`))[0].n;return out;}
  throw Error('Unknown private fixture control');
 }
 return {base,ids,login,control,setBootstrapMode,async close(){if(closed)return;closed=true;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await mf.dispose();}};
}
