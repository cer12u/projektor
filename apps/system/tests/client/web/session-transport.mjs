// @module verification
// @role browser-regression
// Actual request/login code and Node fetch against loopback HTTP redirects.
// Does not prove browser, TLS, Cloudflare or credential storage behavior.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('.local/evidence',{recursive:true});
const outfile='.local/session-transport.mjs';
await build({stdin:{contents:"export {request} from './src/web/session/access';export {requestLogin} from './src/web/session/session-client';export {recordIdentity,latestIdentity,onAuthenticationLost} from './src/web/session/identity-observation';export {HttpError} from './src/web/platform/index';",resolveDir:process.cwd(),loader:'ts'},outfile,bundle:true,platform:'node',format:'esm'});
const {request,requestLogin,recordIdentity,latestIdentity,onAuthenticationLost,HttpError}=await import('../../../'+outfile);
const actualFetch=globalThis.fetch,calls=[];let redirected=0,login=0;
const server=createServer((req,res)=>{req.resume();if(req.url==='/api/auth/login'){login++;res.writeHead(307,{Location:'/capture'});res.end();return;}if(req.url==='/capture'){redirected++;res.end('{}');return;}if(req.url==='/api/expired'){res.writeHead(401,{'Content-Type':'text/html'});res.end('<html>expired</html>');return;}res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'unavailable',operationId:'ORIGINAL_OPERATION',application:'unknown'}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
globalThis.fetch=(path,options)=>{calls.push({path,redirect:options.redirect,credentials:options.credentials});return actualFetch(base+path,options);};
const report={scope:'actual bundled Session transport/login with Node fetch on isolated loopback and selected controlled error bodies; not browser',results:[]};const pass=name=>report.results.push({name,passed:true});
try{
 await assert.rejects(()=>requestLogin({loginId:'synthetic',password:'Synthetic-Only!'},'synthetic-csrf'),TypeError);assert.equal(login,1);assert.equal(redirected,0);assert.equal(calls[0].redirect,'error');pass('password login307 fails without forwarding body to redirect target');
 await assert.rejects(()=>request('/api/auth/login',{method:'POST',body:'synthetic',redirect:'follow',credentials:'include'}),TypeError);assert.equal(redirected,0);assert.equal(calls.at(-1).redirect,'error');assert.equal(calls.at(-1).credentials,'same-origin');pass('callers cannot override redirect rejection or same-origin credentials');
 const before=calls.length;for(const path of ['https://outside.invalid/api/auth/login','//outside.invalid/api/auth/login','/\\outside.invalid/api','/api/\\outside.invalid','/api/\nwrong'])await assert.rejects(()=>request(path),/invalid_api_path/);assert.equal(calls.length,before);pass('absolute, protocol-relative, backslash and control-character paths are rejected before fetch');
 await assert.rejects(()=>request('/api/projects/P/issue-operations/ORIGINAL_OPERATION'),e=>e instanceof HttpError&&e.status===503&&e.operationId==='ORIGINAL_OPERATION'&&e.application==='unknown');pass('correlated application unknown survives error decoding without nonapplication claim');
 recordIdentity({principal:{id:'A',kind:'human'},authentication:'session',projects:[]});let lost=0;const off=onAuthenticationLost(()=>lost++);try{await assert.rejects(()=>request('/api/expired'),e=>e instanceof HttpError&&e.status===401&&e.application==='unknown');assert.equal(lost,1);assert.equal(latestIdentity(),null);}finally{off();}pass('non-JSON401 still immediately clears current authority and remains unknown');
 globalThis.fetch=async()=>Response.json({error:'unavailable',operationId:{bad:true},application:'not_applied'},{status:503});await assert.rejects(()=>request('/api/check'),e=>e instanceof HttpError&&e.operationId===undefined&&e.application===undefined&&e.mutationOutcome===undefined);pass('malformed correlation and unproved application claims are not promoted');
 report.passed=true;
}finally{globalThis.fetch=actualFetch;await new Promise(resolve=>server.close(resolve));for(const path of ['src/web/session/http-client.ts','src/web/session/session-client.ts','src/web/platform/http-errors.ts']){report.hashes??={};report.hashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');}await writeFile('.local/evidence/session-transport.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
