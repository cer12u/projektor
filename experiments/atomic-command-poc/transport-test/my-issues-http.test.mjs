import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:net';
import {Miniflare} from 'miniflare';
const issuer='https://ephemeral-issuer.invalid';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
let mf,base,control;
before(async()=>{
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 base=`http://127.0.0.1:${port}`;
 mf=new Miniflare({host:'127.0.0.1',port,workers:[
  {name:'app',modules:true,scriptPath:new URL('./fixture-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{TEST_ISSUER:issuer,TEST_PUBLIC_JWK:JSON.stringify(publicKey.export({format:'jwk'})),TEST_ORIGIN:base},durableObjects:{WORKSPACE:{className:'FixtureWorkspace',useSQLite:true}}},
  {name:'control',modules:true,scriptPath:new URL('./control-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-07-30',durableObjects:{WORKSPACE:{className:'FixtureWorkspace',scriptName:'app',useSQLite:true}}}
 ]});base=(await mf.ready).origin;control=await mf.getWorker('control');
});
after(async()=>{await mf?.dispose();});
function jwt(claims,header={}) {const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'projektor-local+jwt',kid:'ephemeral-test-key',...header})).toString('base64url');const p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${sign('RSA-SHA256',Buffer.from(`${h}.${p}`),privateKey).toString('base64url')}`;}
async function fixture(kind='machine') {
 const ids=Object.fromEntries(['workspace','epoch','actor','credential','issue','project'].map(k=>[k,randomUUID()]));
 const call=async(action,...args)=>(await control.fetch('http://private-control/',{method:'POST',body:JSON.stringify({workspace:ids.workspace,action,args})})).json();
 const now=Math.floor(Date.now()/1000);
 await call('seed',ids,kind,issuer,(now+3600)*1000);
 const claims={iss:issuer,sub:'fixture-subject',aud:`projektor-local-${kind}`,kind,cid:ids.credential,wid:ids.workspace,iat:now-10,nbf:now-10,exp:now+600};
 const token=jwt(claims);
 const path=`/${kind==='machine'?'machine/':''}v1/workspaces/${ids.workspace}`;
 const command={schemaVersion:1,workspaceId:ids.workspace,workspaceEpoch:ids.epoch,operationId:randomUUID(),commandType:'Issue.UpdateTitle',entityId:ids.issue,expectedVersion:7,payload:{title:'new title'}};
 async function request(c=command,t=token,extra={}) {return fetch(`${base}${path}/commands`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':c.operationId,...(kind==='machine'?{authorization:`Bearer ${t}`}:{cookie:`projektor_test_session=${t}`,origin:base,'x-projektor-csrf':'same-origin'}),...extra},body:JSON.stringify(c)});}
 async function lookup(t=token) {return fetch(`${base}${path}/operations/${command.operationId}?workspaceEpoch=${ids.epoch}`,{headers:kind==='machine'?{authorization:`Bearer ${t}`}:{cookie:`projektor_test_session=${t}`}});}
 async function effects(n=1) {assert.equal((await call('sql','SELECT version FROM issue'))[0].version,7+n);for(const table of ['activity','outbox','operation'])assert.equal((await call('sql',`SELECT COUNT(*) AS n FROM ${table}`))[0].n,n);}
 return {ids,call,claims,token,command,request,lookup,effects,path};
}

for(const kind of ['human','machine'])test(`My Issues ${kind} authenticated empty HTTP200 and private count/list`,async()=>{
 const f=await fixture(kind),headers=kind==='machine'?{authorization:`Bearer ${f.token}`}:{cookie:`projektor_test_session=${f.token}`};
 const url=`${base}${f.path}/my-issues?workspaceEpoch=${f.ids.epoch}`;
 let r=await fetch(url,{headers});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual((await r.json()).data,{items:[],nextCursor:null,total:0});
 await f.call('sql','INSERT INTO issue_queue VALUES(?,?,?,?,?,0)',[f.ids.issue,f.ids.actor,'ready',0,1000]);
 r=await fetch(url,{headers});let data=await r.json();assert.equal(data.data.total,1);assert.equal(data.data.items[0].assignee_kind,kind);assert.equal(data.meta.actorId,f.ids.actor);
 for(const suffix of ['&limit=0','&limit=101','&limit=01','&limit=1.5','&limit=1&limit=2','&status=open','&assigneeId=me','&workspaceEpoch='+f.ids.epoch])assert.equal((await fetch(url+suffix,{headers})).status,400);
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{method:'POST',headers})).status,405);
 await f.call('sql','UPDATE issue_queue SET restricted_read=1');r=await fetch(url,{headers});assert.equal((await r.json()).data.total,0);
 assert.equal((await fetch(`${base}${f.path}/issues/${f.ids.issue}?workspaceEpoch=${f.ids.epoch}`,{headers})).status,404);
 await f.call('sql','INSERT INTO issue_read_grant VALUES(?,?,1)',[f.ids.issue,f.ids.actor]);assert.equal((await f.request()).status,403);
 await f.call('sql','UPDATE credential SET revoked=1');assert.equal((await fetch(url,{headers})).status,403);
});
