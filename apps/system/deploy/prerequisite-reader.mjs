// @module deployment
// @role prerequisites
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {UUID,assertTarget} from './cloudflare-port.mjs';
import {validateDeploymentTarget} from './deployment-config.mjs';
import {guardEnvironment} from './credential-context.mjs';
import {verifyToolchain} from './wrangler-toolchain.mjs';

const ORIGIN='https://api.cloudflare.com';
const SETTINGS=['placement','usage_model','tags','tail_consumers','logpush','observability'];
const DOMAIN=['id','hostname','service','environment','zone_id','zone_name'];
const APP=['id','domain','type','session_duration','aud','allowed_idps','auto_redirect_to_identity'];
const OBJECTS=[{"type":"table","name":"directory_history"},{"type":"trigger","name":"directory_history_no_delete"},{"type":"trigger","name":"directory_history_no_update"},{"type":"table","name":"operation_intents"},{"type":"trigger","name":"operation_intents_no_delete"},{"type":"trigger","name":"operation_intents_no_replace"},{"type":"trigger","name":"operation_intents_no_update"},{"type":"index","name":"operation_intents_principal_sequence"},{"type":"table","name":"operation_results"},{"type":"trigger","name":"operation_results_immutable"},{"type":"trigger","name":"operation_results_match_intent"},{"type":"trigger","name":"owner_setup_context_binding_immutable"},{"type":"trigger","name":"owner_setup_context_no_extend"},{"type":"table","name":"owner_setup_contexts"},{"type":"index","name":"owner_setup_operation"},{"type":"table","name":"projects"},{"type":"trigger","name":"recipient_setup_binding_immutable"},{"type":"table","name":"recipient_setup_contexts"},{"type":"trigger","name":"recipient_setup_no_extend"},{"type":"index","name":"recipient_setup_operation"},{"type":"table","name":"workspaces"}];
const SQL="SELECT name FROM d1_migrations ORDER BY id; SELECT mode,epoch FROM write_gate WHERE id=1; PRAGMA quick_check; PRAGMA foreign_key_check; SELECT type,name,sql FROM sqlite_schema WHERE name IN ("+OBJECTS.map(r=>"'"+r.name+"'").join(',')+") ORDER BY name; SELECT json_extract(value,'$.ownerId') AS ownerId,json_extract(value,'$.issuer') AS issuer,json_extract(value,'$.audience') AS audience,json_extract(value,'$.subject') AS subject,json_extract(value,'$.closesAt') AS closesAt FROM auth_settings WHERE key='owner_web_bootstrap';";
const fail=(code,kind='protocol')=>{const e=Error(code);e.code=code;e.kind=kind;throw e;};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const requireValue=(ok,code='INVALID_PREREQUISITE_RESPONSE')=>{if(!ok)fail(code);};
const select=(v,keys)=>{requireValue(object(v));return Object.fromEntries(keys.map(k=>{requireValue(Object.hasOwn(v,k));return[k,v[k]];}));};
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const projectionHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const projectDomains=(rows,target,hostname)=>{requireValue(Array.isArray(rows)&&rows.every(r=>object(r)&&typeof r.service==='string'&&typeof r.hostname==='string'));return rows.filter(r=>r.service===target.worker||r.hostname===hostname).map(r=>{const p=select(r,DOMAIN);requireValue(DOMAIN.every(k=>typeof p[k]==='string'));return p;}).sort((a,b)=>a.id.localeCompare(b.id));};
export function assertProxyRuntime({version=process.versions.node,execArgv=process.execArgv}={}){
  requireValue(version==='24.19.0','READ_RUNTIME_UNREVIEWED');
  requireValue(execArgv.includes('--use-env-proxy')&&!execArgv.includes('--no-use-env-proxy'),'READ_PROXY_STARTUP_REQUIRED');
}
function accessTopology(app){
  requireValue(object(app));
  const domain=app.domain??null,domains=app.self_hosted_domains??[],destinations=app.destinations??[];
  requireValue((domain===null||typeof domain==='string')&&Array.isArray(domains)&&domains.every(d=>typeof d==='string')&&Array.isArray(destinations),'INVALID_ACCESS_TOPOLOGY');
  const normalized=destinations.map(d=>{
    requireValue(object(d),'INVALID_ACCESS_TOPOLOGY');const type=d.type??'public';
    requireValue(['public','worker','preview_worker','all_workers','all_preview_workers'].includes(type),'UNREVIEWED_ACCESS_DESTINATION');
    if(type==='public')requireValue(typeof d.uri==='string'&&d.uri.length>0,'INVALID_ACCESS_TOPOLOGY');
    if(type==='worker'||type==='preview_worker')requireValue(typeof d.worker_id==='string'&&d.worker_id.length>0,'INVALID_ACCESS_TOPOLOGY');
    if(d.overrides!==undefined)requireValue(Array.isArray(d.overrides)&&d.overrides.every(o=>object(o)&&o.behavior==='public'&&typeof o.path_pattern==='string'&&o.path_pattern.startsWith('/')),'INVALID_ACCESS_TOPOLOGY');
    return canonical({...d,type});
  }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {domain,self_hosted_domains:[...domains].sort(),destinations:normalized};
}
function relevantApp(app,hostname){
  const topology=accessTopology(app);
  // Worker/all-Worker destinations can protect this host independently of a
  // legacy domain. Include all such apps conservatively rather than guessing
  // the provider's opaque Worker ID mapping or silently omitting protection.
  if(topology.destinations.some(d=>d.type!=='public'))return true;
  const routes=[topology.domain,...topology.self_hosted_domains,...topology.destinations.map(d=>d.uri)].filter(v=>v!==null);
  return routes.some(route=>{
    const domain=route.replace(/^https?:\/\//,'').split('/')[0];
    const pattern=domain.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    return new RegExp('^'+pattern+'$','i').test(hostname);
  });
}
function deployment(result,version){
  requireValue(object(result)&&Array.isArray(result.deployments)&&result.deployments.length>0);
  for(const d of result.deployments)requireValue(UUID.test(d.id||'')&&Number.isFinite(Date.parse(d.created_on))&&Array.isArray(d.versions));
  const d=[...result.deployments].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
  requireValue(d.versions.length===1&&d.versions[0].version_id===version&&d.versions[0].percentage===100,'PREREQUISITE_VERSION_DRIFT');
  return {id:d.id,versionId:version};
}
function service(result,worker){
  requireValue(result?.id===worker&&result.default_environment?.environment==='production');
  const s=result.default_environment.script;
  const tags=s?.tags??[]; // Exact pinned Wrangler4.149 preUpload normalization (cli.js180425/180447).
  requireValue(object(s)&&typeof s.last_deployed_from==='string'&&Array.isArray(tags)&&tags.every(v=>typeof v==='string')&&typeof s.migration_tag==='string'&&typeof s.tag==='string');
  return {projection:'default_environment.script',origin:s.last_deployed_from,tags,migrationTag:s.migration_tag,scriptTag:s.tag};
}
function database(result,expectedSchema,databaseId,migrationNames){
  requireValue(Array.isArray(result)&&result.length===6);
  for(const r of result)requireValue(r.success===true&&Array.isArray(r.results)&&r.meta?.changed_db===false&&r.meta?.rows_written===0,'D1_READ_NOT_CERTIFIED');
  const [ledger,gate,check,fks,schema,owner]=result.map(r=>r.results);
  requireValue(ledger.length===migrationNames.length&&ledger.every((r,i)=>r.name===migrationNames[i]));
  requireValue(gate.length===1&&['stopped','open','importing'].includes(gate[0].mode)&&Number.isSafeInteger(gate[0].epoch));
  requireValue(check.length===1&&check[0].quick_check==='ok'&&fks.length===0,'DATABASE_INTEGRITY_FAILED');
  requireValue(schema.every(r=>typeof r.sql==='string'),'REQUIRED_SCHEMA_DEFINITIONS_MISSING');
  const definitions=schema.map(r=>({type:r.type,name:r.name,sql:r.sql.trim().replace(/\r\n/g,'\n')}));
  requireValue(projectionHash(definitions)===projectionHash(expectedSchema),'REQUIRED_SCHEMA_DEFINITIONS_CHANGED');
  requireValue(owner.length===1&&/^[A-Za-z0-9_-]{1,128}$/.test(owner[0].ownerId||'')&&/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(owner[0].issuer||'')&&/^[a-f0-9]{64}$/.test(owner[0].audience||'')&&UUID.test(owner[0].subject||'')&&Number.isSafeInteger(owner[0].closesAt),'OWNER_TRUST_METADATA_MISSING');
  return {ownerBootstrapHash:projectionHash(owner[0]),database:{id:databaseId,migrationNames:ledger.map(r=>r.name)},gate:{mode:gate[0].mode,epoch:gate[0].epoch}};
}

// Only the closed read set below is reachable. There is no generic caller URL,
// alternate auth, uploader, token renewal, credential store, or provider write.
export function createPrerequisiteReader({candidate,credentials,configuration,fetchImpl=globalThis.fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),runtime}={}){
  if(!configuration)fail('PRIVATE_DEPLOYMENT_NOT_CONFIGURED','configuration');
  const {target:configuredTarget,databaseId,hostname}=configuration;validateDeploymentTarget({format:1,...configuredTarget,databaseId,hostname,gate:configuration.gate});
  const WORKER=configuredTarget.worker,BASE='/client/v4/accounts/'+configuredTarget.account;
  async function ready(){assertProxyRuntime(runtime);await verifyToolchain(candidate);credentials.check();}
  async function inspect(target,currentVersion){
    assertTarget(target,configuredTarget);requireValue(UUID.test(currentVersion||''),'INVALID_VERSION_ID');
    await ready();
    return credentials.run(async env=>{
      guardEnvironment(env,{target:configuredTarget}); // The same approved proxy/CA/auth policy as official Wrangler.
      const deadline=now()+90_000;
      const schemaPolicy=JSON.parse(await readFile(new URL('./schema-contract.json',import.meta.url)));
      requireValue(schemaPolicy.format===1&&Array.isArray(schemaPolicy.migrations)&&schemaPolicy.migrations.length===21,'CANONICAL_SCHEMA_SOURCE_CHANGED');
      for(const [i,m]of schemaPolicy.migrations.entries())requireValue(typeof m.name==='string'&&m.name.startsWith(String(i+1).padStart(4,'0')+'_')&&/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(m.name)&&createHash('sha256').update(await readFile(resolve(candidate,'migrations',m.name))).digest('hex')===m.sha256,'CANONICAL_SCHEMA_SOURCE_CHANGED');
      const expectedSchema=schemaPolicy.objects;
      requireValue(Array.isArray(expectedSchema)&&projectionHash(expectedSchema.map(r=>({type:r.type,name:r.name})))===projectionHash(OBJECTS)&&expectedSchema.every(r=>typeof r.sql==='string'),'LOCAL_SCHEMA_EXPECTATION_MISSING');
      async function request(path,{body}={}){
        const url=ORIGIN+BASE+path;
        // Paths are generated exclusively by the fixed read operations below.
        requireValue(new URL(url).origin===ORIGIN&&url.startsWith(ORIGIN+BASE+'/'),'READ_TARGET_CHANGED');
        for(let attempt=0;attempt<=3;attempt++){
          if(now()>=deadline)fail('PREREQUISITE_DEADLINE','transient');
          let response;
          try{response=await fetchImpl(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10_000,deadline-now())))});}
          catch(error){
            // Fetch redirect failures carry a cause; they are terminal. Nothing
            // from the provider or thrown fetch error is logged or rethrown.
            if(/redirect/i.test(String(error?.cause?.message||error?.message||'')))fail('READ_REDIRECT_REJECTED','safety-stop');
            if(error?.name==='AbortError')fail('READ_CANCELLED','cancelled');
            const code=error?.cause?.code;
            if(typeof code==='string'&&/CERT|TLS|SELF_SIGNED/.test(code))fail('READ_TLS_REJECTED','safety-stop');
            // A generic fetch TypeError can hide a proxy denial. Retry only
            // known transient transport causes, never an opaque refusal.
            if(error?.name!=='TimeoutError'&&!(error?.name==='TypeError'&&['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET'].includes(code)))fail('READ_TRANSPORT_FAILED');
            if(attempt===3)fail('READ_RETRY_EXHAUSTED','transient');
            await sleep(1000*2**attempt);continue;
          }
          requireValue(response.url===url&&!response.redirected,'READ_RESPONSE_TARGET_CHANGED');
          if(response.status===401||response.status===403){await response.body?.cancel();fail('PREREQUISITE_AUTH_DENIED','auth-denied');}
          if(response.status>=300&&response.status<400){await response.body?.cancel();fail('READ_REDIRECT_REJECTED','safety-stop');}
          if([429,500,502,503,504].includes(response.status)){
            await response.body?.cancel();if(attempt===3)fail('READ_RETRY_EXHAUSTED','transient');
            await sleep(1000*2**attempt);continue;
          }
          requireValue(response.status===200&&response.headers.get('content-type')?.includes('application/json'),'UNEXPECTED_READ_STATUS_OR_TYPE');
          const chunks=[];let bytes=0;const reader=response.body?.getReader();requireValue(reader);
          try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4_000_000){await reader.cancel();fail('READ_RESPONSE_TOO_LARGE');}chunks.push(value);}}catch(error){if(error.code==='READ_RESPONSE_TOO_LARGE')throw error;fail('READ_BODY_FAILED');}
          let envelope;try{envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_READ_JSON');}
          if(envelope?.success!==true){if(envelope?.errors?.some?.(e=>[10000,10001,10004,9109].includes(e.code)))fail('PREREQUISITE_AUTH_DENIED','auth-denied');fail('UNSUCCESSFUL_READ_RESPONSE');}
          requireValue(Object.hasOwn(envelope,'result'));return envelope;
        }
      }
      async function pages(path){
        const rows=[];
        for(let page=1;page<=10;page++){
          const e=await request(path+'?page='+page+'&per_page=100');requireValue(Array.isArray(e.result));rows.push(...e.result);
          const info=e.result_info;
          // Public single-page APIs may omit result_info; only a short page can
          // then establish that this bounded read was complete.
          if(!info){requireValue(e.result.length<100,'PAGINATION_NOT_CERTIFIED');return rows;}
          requireValue(info.page===page&&Number.isSafeInteger(info.total_count)&&info.total_count>=rows.length&&Number.isSafeInteger(info.per_page)&&info.per_page===100,'PAGINATION_NOT_CERTIFIED');
          if(rows.length===info.total_count)return rows;
          requireValue(e.result.length>0,'PAGINATION_NOT_CERTIFIED');
        }
        fail('PREREQUISITE_PAGE_LIMIT');
      }
      async function scan(){
        const active=deployment((await request('/workers/scripts/'+WORKER+'/deployments')).result,currentVersion);
        const s=service((await request('/workers/services/'+WORKER)).result,WORKER);
        const settings=select((await request('/workers/scripts/'+WORKER+'/settings')).result,SETTINGS);
        requireValue(object(settings.placement)&&typeof settings.usage_model==='string'&&Array.isArray(settings.tags)&&Array.isArray(settings.tail_consumers)&&typeof settings.logpush==='boolean'&&object(settings.observability));
        const domains=projectDomains(await pages('/workers/domains'),configuredTarget,hostname);
        const apps=(await pages('/access/apps')).filter(app=>relevantApp(app,hostname));requireValue(apps.length>0&&apps.length<=5,'ACCESS_TARGET_SET_UNEXPECTED');
        const access=[];
        for(const app of apps){
          const selected={...select({...app,domain:app.domain??null},APP),...accessTopology(app)};requireValue(UUID.test(selected.id||'')&&selected.type==='self_hosted'&&(selected.domain===null||typeof selected.domain==='string')&&typeof selected.session_duration==='string'&&typeof selected.aud==='string'&&Array.isArray(selected.allowed_idps)&&typeof selected.auto_redirect_to_identity==='boolean');
          const policies=await pages('/access/apps/'+selected.id+'/policies');
          requireValue(policies.length>0&&policies.length<=50&&policies.every(p=>object(p)&&typeof p.id==='string'&&typeof p.decision==='string'&&Array.isArray(p.include)&&Array.isArray(p.exclude)&&Array.isArray(p.require)));
          access.push({...selected,policies});
        }
        access.sort((a,b)=>a.id.localeCompare(b.id));
        const db=database((await request('/d1/database/'+databaseId+'/query',{body:{sql:SQL}})).result,expectedSchema,databaseId,schemaPolicy.migrations.map(m=>m.name));
        const after=deployment((await request('/workers/scripts/'+WORKER+'/deployments')).result,currentVersion);
        requireValue(projectionHash(active)===projectionHash(after),'PREREQUISITE_SNAPSHOT_DRIFT');
        return {...db,service:s,security:{ownerBootstrapHash:db.ownerBootstrapHash,accessPoliciesHash:projectionHash(access),domainsHash:projectionHash(domains),workerSettingsHash:projectionHash(settings)},active};
      }
      const before=await scan(),after=await scan();
      requireValue(projectionHash(before)===projectionHash(after),'PREREQUISITE_SNAPSHOT_DRIFT');
      if(now()>=deadline)fail('PREREQUISITE_DEADLINE','transient');
      return {target:{...configuredTarget},observedAt:new Date(now()).toISOString(),currentVersion,...after,observationWindow:{strategy:'two equal bounded API scans, active deployment bracketed in each',notAtomicAcrossApis:true}};
    });
  }
  return Object.freeze({ready,inspect});
}
