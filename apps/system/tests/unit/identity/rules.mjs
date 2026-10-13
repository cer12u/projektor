// @module verification
// @role identity-rules
// Hypothesis: extraction accidentally lengthens setup authority or broadens normalized management input.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const directory=await mkdtemp(join(tmpdir(),'projektor-identity-rules-'));
const results=[];
const check=(name,run)=>{run();results.push({name,passed:true});};
try{
 await build({entryPoints:['src/modules/identity/rules.ts'],outfile:join(directory,'rules.mjs'),bundle:true,format:'esm',platform:'node'});
 const r=await import(pathToFileURL(join(directory,'rules.mjs')));
 const now=1000;
 for(const [name,bounds,expected] of [['context',[1100,1900,1800],1100],['bootstrap',[1900,1100,1800],1100],['assertion',[1900,1800,1100],1100],['grant',[9000,9000,9000],2800]])check(`${name} deadline is an absolute cap`,()=>assert.equal(r.ownerSetupExpiry(...bounds,now),expected));
 check('expired exact boundary denies rather than creating a renewed grant',()=>assert.throws(()=>r.ownerSetupExpiry(1000,1900,1900,now)));
 check('negative control: maximum or sliding source expiry violates the earliest deadline',()=>assert.notEqual(Math.max(1100,1900,1800,now+1800),r.ownerSetupExpiry(1100,1900,1800,now)));
 const command={operationId:'op',kind:'management.membership.set',targetId:'agent',projectId:'project',input:{revision:1,permissions:['view','edit','view']}};
 check('normalization has one deterministic permission set',()=>assert.deepEqual(r.parseManagementCommand(command).input.permissions,['edit','view']));
 check('actor or arbitrary command fields cannot enter normalization',()=>assert.throws(()=>r.parseManagementCommand({...command,actorId:'owner'})));
 check('credential changes require explicit GLOBAL authority context',()=>assert.throws(()=>r.parseManagementCommand({...command,kind:'management.credential.revoke',input:{revision:1}})));
 const principal={principalId:'new_agent',kind:'agent',displayName:'Agent',loginId:null,globalAdministrator:false,projects:[{projectId:'project',permissions:['view','edit']}]};
 check('Agent cannot acquire global administration by registration input',()=>assert.throws(()=>r.normalizePrincipalProvision({...principal,globalAdministrator:true})));
 check('non-view grants are not implicitly expanded',()=>assert.throws(()=>r.normalizePrincipalProvision({...principal,projects:[{projectId:'project',permissions:['edit']}]})));
 check('registration authority field is rejected at external decoder',()=>assert.throws(()=>r.parsePrincipalRegistration({operationId:'op',...principal})));
 check('typed registration contains normalized principal and exact operation ID',()=>{const {globalAdministrator,...input}=principal;const parsed=r.parsePrincipalRegistration({operationId:'op',...input});assert.equal(parsed.operationId,'op');assert.equal(parsed.principal.globalAdministrator,false);});
 check('password rejects malformed unicode and short input',()=>{assert.throws(()=>r.passwordInput('short'));assert.throws(()=>r.passwordInput('aaaaaaaaaaaa\ud800'));assert.throws(()=>r.passwordInput('a'.repeat(1025)));assert.equal(r.passwordInput('a'.repeat(12)),'a'.repeat(12));});
 const inputs=['src/modules/identity/rules.ts','src/modules/identity/public.ts','src/modules/change-outcomes.ts'];
 const hashes=Object.fromEntries(await Promise.all(inputs.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
 await mkdir('.local/evidence',{recursive:true});await writeFile('.local/evidence/identity-rules.json',JSON.stringify({passed:true,runtime:'pure rules, no DB or provider',results,hashes},null,2)+'\n');
 console.log(JSON.stringify({passed:true,groups:results.length}));
}finally{await rm(directory,{recursive:true,force:true});}
