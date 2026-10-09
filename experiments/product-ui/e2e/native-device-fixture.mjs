// TEST ONLY: actual entry/Store with a synthetic existing owner session and a
// private machine pairing preimage. Neither credential is exposed by UI controls.
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
const core=resolve(process.env.PROJEKTOR_CORE_SOURCE??resolve(import.meta.dirname,'../../atomic-command-poc'));
const {Miniflare,createFetchMock}=createRequire(resolve(core,'package.json'))('miniflare');
export async function startNativeDeviceFixture(){
 const ids=Object.fromEntries(['workspace','epoch','human','machine','credential','session','authEpoch','project','grant','machineCredential'].map(key=>[key,randomUUID()])),origin='https://native-owner-fixture.invalid',now=Date.now(),ownerSecret=randomBytes(32),pairingSecret=randomBytes(32),jar=new Map();
 const ownerToken=ids.session+'.'+ownerSecret.toString('base64url');jar.set('__Host-projektor_session',ownerToken);
 const mock=createFetchMock();mock.disableNetConnect();
 const mf=new Miniflare({cf:false,fetchMock:mock,name:'native-owner-ui',unsafeInspectDurableObjects:true,modules:true,modulesRoot:core,scriptPath:resolve(core,'service/entry.mjs'),compatibilityDate:'2024-09-23',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public','cache_option_enabled'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{APP_ORIGIN:origin,WORKSPACE_IDS:JSON.stringify([ids.workspace]),REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',JWT_SECRET:randomBytes(32).toString('hex'),APP_AUTH_CONFIG:JSON.stringify({version:1,workspaceId:ids.workspace,humanPrincipalId:ids.human,authEpoch:ids.authEpoch,policy:{idleMs:3600000,absoluteMs:7200000},nativeMachine:{principalId:ids.machine,maxLifetimeMs:3600000,maxRedeemLifetimeMs:600000,deviceSession:{accessLeaseMs:5000,refreshGraceMs:500,receiptRetentionMs:20000}}})},durableObjects:{WORKSPACE:{className:'WorkspaceService',useSQLite:true}}});
 try{
  await mf.ready;const admission=await mf.dispatchFetch(origin+'/v1/auth/csrf');if(admission.status!==200)throw Error('Owner fixture admission failed');
  const db=await mf.unsafeGetDurableObjectStorage('native-owner-ui','WorkspaceService',{name:ids.workspace});
  await db.exec('INSERT INTO workspace VALUES(?,?,1,0)',ids.workspace,ids.epoch);await db.exec('INSERT INTO project VALUES(?,?,1,0)',ids.project,'Owner device fixture');
  await db.exec("INSERT INTO membership VALUES(?,'human',0,1)",ids.human);await db.exec("INSERT INTO membership VALUES(?,'machine',0,1)",ids.machine);await db.exec('INSERT INTO credential VALUES(?,?,?,0,1,1)',ids.credential,ids.human,now+7200000);await db.exec("INSERT INTO app_auth_principal VALUES(?,?,'owner',1,1,NULL,NULL,NULL,0)",ids.human,ids.credential);
  await db.exec('INSERT INTO app_auth_session(id,principal_id,credential_id,auth_version,grant_generation,auth_epoch,current_hash,created_at,idle_expires_at,absolute_expires_at,rotated_at,revoked) VALUES(?,?,?,1,1,?,?,?,?,?,?,0)',ids.session,ids.human,ids.credential,ids.authEpoch,createHash('sha256').update(ownerSecret).digest('hex'),now,now+3600000,now+7200000,now);
  for(const actor of [ids.human,ids.machine]){await db.exec('INSERT INTO project_grant VALUES(?,?,1,1)',actor,ids.project);for(const scope of ['issue:read','issue:write','operations:read_own'])await db.exec('INSERT INTO principal_scope VALUES(?,?)',actor,scope);}
  for(const scope of ['issue:read','issue:write','operations:read_own'])await db.exec('INSERT INTO credential_scope VALUES(?,?)',ids.credential,scope);
  const proposal={origin,principalId:ids.machine,approval:{grantId:ids.grant,credentialId:ids.machineCredential,secretDigest:createHash('sha256').update(pairingSecret).digest('hex'),scopes:['issue:read','operations:read_own'],expiresAt:now+600000,redeemExpiresAt:now+300000,expectedGeneration:0}};
  return {ids,origin,proposal,
   browserCookie:()=>({name:'__Host-projektor_session',value:ownerToken,url:origin,httpOnly:true,secure:true,sameSite:'Strict'}),
   fetch:(input,init)=>mf.dispatchFetch(input,init),
   ownerFetch:async(input,init)=>{const response=await mf.dispatchFetch(input,{...init,headers:{...init.headers,cookie:[...jar].map(([name,value])=>name+'='+value).join(';'),...(init.method==='POST'?{origin,'sec-fetch-site':'same-origin'}:{})}});for(const line of response.headers.getSetCookie()){const [name,...parts]=line.split(';')[0].split('=');if(/Max-Age=0(?:;|$)/.test(line))jar.delete(name);else jar.set(name,parts.join('='));}return response;},
   async redeem(){const response=await mf.dispatchFetch(origin+'/v1/auth/machine-credentials/pairing/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grantId:ids.grant,secret:pairingSecret.toString('base64url')})});if(response.status!==200)throw Error('Synthetic machine pairing failed with status '+response.status);return (await response.json()).data;},
   assertPublic(value){const text=JSON.stringify(value);if(text.includes(pairingSecret.toString('base64url'))||text.includes(ownerToken)||text.includes('pn1_')||text.includes('ps1_'))throw Error('Private credential crossed the public owner boundary');},
   close:()=>mf.dispose(),
  };
 }catch(error){await mf.dispose();throw error;}
}
