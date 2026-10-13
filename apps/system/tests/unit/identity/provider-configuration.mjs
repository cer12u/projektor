// @module verification
// @role identity-provider-configuration
// Hypothesis: deployment-configurable issuers accidentally reuse another tenant's keys or allow SSRF.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const dir=await mkdtemp(join(tmpdir(),'projektor-provider-config-')),originalFetch=globalThis.fetch,urls=[],results=[];
const hash=x=>createHash('sha256').update(x).digest('hex');
try{
 await build({entryPoints:['src/adapters/external-identity/access-assertion.ts','src/adapters/external-identity/owner-access-assertion.ts'],outdir:dir,bundle:true,format:'esm',platform:'node',outExtension:{'.js':'.mjs'}});
 const {verifyAccessAssertion,validAccessIssuer}=await import(pathToFileURL(join(dir,'access-assertion.mjs'))),{ownerConfiguration,verifyOwner}=await import(pathToFileURL(join(dir,'owner-access-assertion.mjs')));
 const issuers=['https://tenant-one.cloudflareaccess.com','https://tenant-two.cloudflareaccess.com'],keys=await Promise.all(issuers.map(()=>generateKeyPair('RS256',{extractable:true}))),jwks=await Promise.all(keys.map(async k=>({...await exportJWK(k.publicKey),kid:'same-kid',alg:'RS256',use:'sig'}))),audience='a'.repeat(64),now=Math.floor(Date.now()/1000);
 globalThis.fetch=async(url,options)=>{urls.push(String(url));const index=issuers.findIndex(i=>String(url)===i+'/cdn-cgi/access/certs');assert(index>=0);assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(options.headers?.Authorization,undefined);return Response.json({keys:[jwks[index]]});};
 const sign=(issuer,key)=>new SignJWT({iss:issuer,aud:[audience],sub:'synthetic-subject',type:'app',iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'same-kid'}).sign(key.privateKey);
 await verifyAccessAssertion(await sign(issuers[0],keys[0]),{issuer:issuers[0],audience},now);assert.equal(urls.length,1);
 await assert.rejects(verifyAccessAssertion(await sign(issuers[1],keys[0]),{issuer:issuers[1],audience},now),e=>e.code==='unauthenticated');assert.equal(urls.length,2,'new configured issuer fetches its own keys even for same kid');
 const accepted=await verifyAccessAssertion(await sign(issuers[1],keys[1]),{issuer:issuers[1],audience},now);assert.equal(accepted.issuer,issuers[1]);assert.equal(urls.length,2);results.push({name:'configured issuer cache cannot accept prior tenant key with same kid',passed:true});
 const before=urls.length;
 for(const issuer of ['http://tenant-one.cloudflareaccess.com','https://Tenant-one.cloudflareaccess.com','https://tenant-one.cloudflareaccess.com/','https://tenant-one.cloudflareaccess.com:443','https://user@tenant-one.cloudflareaccess.com','https://tenant-one.cloudflareaccess.com.attacker.invalid','https://x.y.cloudflareaccess.com','https://-x.cloudflareaccess.com','https://127.0.0.1','https://tenant-one.cloudflareaccess.com\n']){
  assert.equal(validAccessIssuer(issuer),false);await assert.rejects(verifyAccessAssertion('ignored',{issuer,audience},now),e=>e.code==='federation_configuration_invalid');
  const bad={ownerId:'configured-owner',issuer,audience,subject:'11111111-1111-4111-8111-111111111111',closesAt:now+60};assert.throws(()=>ownerConfiguration(JSON.stringify(bad)));await assert.rejects(verifyOwner('ignored',bad));
 }
 assert.equal(urls.length,before);results.push({name:'malicious and noncanonical issuer origins rejected before fetch',passed:true});
 const owner=ownerConfiguration(JSON.stringify({ownerId:'another-configured-owner',issuer:issuers[0],audience,subject:'11111111-1111-4111-8111-111111111111',closesAt:now+60}));assert.equal(owner.ownerId,'another-configured-owner');results.push({name:'trusted bootstrap metadata supplies explicit target without personal source constant',passed:true});
 const ownerToken=await new SignJWT({iss:owner.issuer,aud:[audience],sub:owner.subject,email:'synthetic@example.invalid',type:'app',iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'same-kid'}).sign(keys[0].privateKey);assert.equal((await verifyOwner(ownerToken,owner)).subject,owner.subject);
 const redirectedFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid'}});await assert.rejects(verifyOwner(ownerToken,owner));globalThis.fetch=redirectedFetch;results.push({name:'owner verifier validates trusted configuration again and never follows redirected keys',passed:true});
 await mkdir('.local/evidence',{recursive:true});const paths=['src/adapters/external-identity/access-assertion.ts','src/adapters/external-identity/owner-access-assertion.ts'];await writeFile('.local/evidence/identity-provider-configuration.json',JSON.stringify({passed:true,externalRequests:0,transport:'synthetic fetch, actual JOSE signatures and cache',results,sourceHashes:Object.fromEntries(await Promise.all(paths.map(async p=>[p,hash(await readFile(p))])))},null,2)+'\n');console.log(JSON.stringify({passed:true,groups:results.length,externalRequests:0}));
}finally{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
