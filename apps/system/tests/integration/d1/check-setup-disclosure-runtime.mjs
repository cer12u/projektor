// @module verification
// @role setup-disclosure-runtime
// A completed setup's input comparison must not disclose a receipt after its authority is lost.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareLocalD1,verifyCanonicalLedger} from '../../support/local-d1-fixture.mjs';
const root=await mkdtemp(join(tmpdir(),'projektor-setup-disclosure-'));
let mf;
const matching='a'.repeat(64),different='b'.repeat(64);
const source=`
import {passwordSetupPhase,preparePasswordSetupValue} from './src/adapters/d1/identity/password-setup-completion';
export default {async fetch(request,env){
 const c=await request.json(),db=env.DB.withSession('first-primary');
 try{const value=c.phase?await passwordSetupPhase(db,c.hash,'complete',c.input):await preparePasswordSetupValue(db,c.hash,'complete',c.input,'',c.bound===false?{text:'0',values:[]}:undefined);return Response.json(value);}
 catch(error){return Response.json({error:error.code},{status:error.status??500});}
}};`;
try{
 await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'setup-disclosure-fixture.ts'},outfile:join(root,'worker.mjs'),bundle:true,format:'esm',platform:'neutral',external:['cloudflare:*','node:*']});
 const fixture=await prepareLocalD1(root);
 mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:join(root,'worker.mjs'),contents:await readFile(join(root,'worker.mjs'),'utf8')}],modulesRoot:root,compatibilityDate:'2026-10-09',...fixture,host:'127.0.0.1',port:0,cf:false,logRequests:false}));
 await mf.ready;const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);
 const sql=(q,...args)=>db.prepare(q).bind(...args).run();
 async function seed(id,{active=1,version=2,expired=false,revoked=false,bound=false}={}){
  const hash=id.padEnd(64,'0');
  await sql('INSERT INTO principals VALUES(?,\'human\',?,?,?,?)',id,id,id,active,version);
  await sql(`INSERT INTO password_setup_rights(id,principal_id,token_hash,purpose,target_auth_version,issued_at,expires_at,consumed_at,revoked_at,completed_operation_id,input_hash,completed_auth_version,completion_snapshot)
   VALUES(?,?,?,'initial',1,unixepoch()-100,unixepoch()+?,unixepoch()-50,?,'complete',?,2,?)`,id,id,hash,expired?-1:600,revoked?1:null,matching,JSON.stringify({principalId:id,authVersion:2,configured:true}));
  await sql('UPDATE password_setup_states SET latest_right_id=? WHERE principal_id=?',id,id);
  if(bound)await sql(`INSERT INTO owner_setup_contexts(context_hash,csrf_hash,created_at,expires_at,owner_id,operation_id,right_id,issuer,audience,subject) VALUES(?,?,unixepoch()-100,unixepoch()+600,?,'complete',?,'issuer','audience','subject')`,'c'.repeat(64),'d'.repeat(64),id,id);
  return hash;
 }
 const call=async(hash,input,phase,bound)=>{const response=await mf.dispatchFetch('https://setup.invalid',{method:'POST',body:JSON.stringify({hash,input,phase,bound})});return{status:response.status,body:await response.json()};};
 const live=await seed('live');
 for(const phase of [true,false]){
  assert.equal((await call(live,matching,phase)).status,200);
  assert.deepEqual(await call(live,different,phase),{status:409,body:{error:'operation_input_mismatch'}});
 }
 for(const [name,options]of [['expired',{expired:true}],['revoked',{revoked:true}],['disabled',{active:0}],['reset',{version:3}],['bound',{bound:true}]]){
  const hash=await seed(name,options);
  for(const phase of [true,false])for(const input of [matching,different])assert.deepEqual(await call(hash,input,phase),{status:403,body:{error:'setup_result_unavailable'}},`${name}, phase=${phase}, matching=${input===matching}`);
 }
 for(const input of [matching,different])assert.deepEqual(await call(live,input,false,false),{status:403,body:{error:'setup_result_unavailable'}},'lost protected-context binding');
 assert.equal(await db.prepare('SELECT count(*) n FROM passwords').first('n'),0);
 assert.equal(await db.prepare('SELECT count(*) n FROM password_setup_audit').first('n'),0);
 console.log(JSON.stringify({passed:true,runtime:'local workerd and canonical D1',cases:26,externalRequests:0}));
}finally{if(mf)await mf.dispose();await rm(root,{recursive:true,force:true});}
