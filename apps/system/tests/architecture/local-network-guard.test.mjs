// @module verification
// @role local-network-guard-test
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const guard = fileURLToPath(new URL('../support/local-network-guard.cjs', import.meta.url));
const run = code => spawnSync(process.execPath, ['--require', guard, '-e', `(async()=>{${code}})().catch(error=>{console.error(error);process.exitCode=1})`], {encoding:'utf8', env:{PATH:process.env.PATH}, timeout:15000});
for (const [name, expression] of [
  ['TCP', "(await import('node:net')).connect(443,'192.0.2.1')"],
  ['TLS', "(await import('node:tls')).connect({host:'external.invalid',port:443})"],
  ['fetch', "await fetch('https://external.invalid/')"],
  ['lookup', "await (await import('node:dns/promises')).lookup('external.invalid')"],
  ['DNS resolver', "await (new (await import('node:dns/promises')).Resolver()).resolve4('external.invalid')"],
  ['UDP', "(await import('node:dgram')).createSocket('udp4').send('synthetic',53,'192.0.2.1')"],
]) test(name+' is blocked before network, even if the library catches the error', () => {
  const result = run(`try { ${expression}; } catch { console.log('caught'); } process.exit(0);`);
  assert.equal(result.status,86,result.stderr); assert.match(result.stdout,/caught/);
  assert.doesNotMatch(result.stdout+result.stderr,/external\.invalid|192\.0\.2\.1/);
});
test('loopback HTTP and DNS remain usable for actual local fixtures', () => {
  const result=run(`const {createServer}=await import('node:http'); const {lookup}=await import('node:dns/promises');
    const server=createServer((q,r)=>r.end('local')); await new Promise(r=>server.listen(0,'127.0.0.1',r));
    try { const response=await fetch('http://localhost:'+server.address().port); if(await response.text()!=='local')throw Error('body');
      if((await lookup('localhost')).address!=='127.0.0.1')throw Error('lookup'); }
    finally {server.closeAllConnections(); await new Promise(r=>server.close(r));}`);
  assert.equal(result.status,0,result.stderr);
});
test('loopback UDP remains usable',()=>{
  const result=run(`const {createSocket}=await import('node:dgram');const socket=createSocket('udp4');
    await new Promise(r=>socket.bind(0,'127.0.0.1',r));const received=new Promise(r=>socket.once('message',r));
    socket.send('local',socket.address().port,'127.0.0.1');if((await received).toString()!=='local')throw Error('body');socket.close();`);
  assert.equal(result.status,0,result.stderr);
});
test('fresh official local migrations and D1 run without hidden fetches; workerd outbound is closed', () => {
  const helper = fileURLToPath(new URL('../support/local-d1-fixture.mjs', import.meta.url));
  const result=run(`const {prepareLocalD1,verifyCanonicalLedger}=await import(${JSON.stringify(helper)});
    const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
    const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
    const temp=await mkdtemp(tmpdir()+'/projektor-hermetic-');let mf;
    try {const fixture=await prepareLocalD1(temp);
      mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default{async fetch(){return fetch('https://external.invalid/')}}",...fixture,host:'127.0.0.1',port:0,cf:false}));
      const db=await mf.getD1Database('DB');await verifyCanonicalLedger(db);console.log('canonical-local-D1-ready');
      await mf.dispatchFetch('http://localhost/');
    } finally {if(mf)await mf.dispose();await rm(temp,{recursive:true,force:true});}`);
  assert.match(result.stdout,/canonical-local-D1-ready/,result.stderr);
  assert.equal(result.status,86,result.stderr);
});
