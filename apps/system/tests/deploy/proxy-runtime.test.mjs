// @module verification
// @role deployment-contract
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import tls from 'node:tls';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

// Loopback-only proxy. It NEVER resolves/connects to the CONNECT destination.
// No production credential, external request, trust override or TLS bypass.
async function runProxyCase(t,tlsReject=false){
  const sockets=new Set(),events=[];let context;
  if(tlsReject){
    const dir=await mkdtemp(resolve(tmpdir(),'projektor-proxy-proof-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const key=resolve(dir,'key.pem'),cert=resolve(dir,'cert.pem');
    const made=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=api.cloudflare.com','-addext','subjectAltName=DNS:api.cloudflare.com'],{stdio:'ignore'});assert.equal(made.status,0);
    context=tls.createSecureContext({key:await readFile(key),cert:await readFile(cert)});
  }
  const server=http.createServer((req,res)=>{events.push({unexpectedPlainRequest:req.url});res.writeHead(403).end();});
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('connect',(req,socket)=>{
    events.push({connect:req.url,authorization:req.headers.authorization??null});
    if(!tlsReject){socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return;}
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:context});
    secure.on('error',()=>{});secure.on('data',()=>events.push({unexpectedAuthenticatedHttp:true}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
  const proxy='http://127.0.0.1:'+server.address().port;
  const code="fetch('https://api.cloudflare.com/client/v4/accounts/SYNTHETIC/read',{headers:{Authorization:'Bearer SYNTHETIC_NOT_A_CREDENTIAL'},redirect:'error',signal:AbortSignal.timeout(3000)}).then(()=>{process.exitCode=2}).catch(e=>{console.log(JSON.stringify({name:e.name,cause:e.cause?.code||null}));});";
  const child=spawn(process.execPath,['--use-env-proxy','--input-type=module','-e',code],{env:{PATH:process.env.PATH,HTTPS_PROXY:proxy,NO_PROXY:''},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
  assert.equal(exit,0);assert.equal(events.length,1);assert.deepEqual(events[0],{connect:'api.cloudflare.com:443',authorization:null});assert.equal(out.includes('SYNTHETIC_NOT_A_CREDENTIAL'),false);assert.equal(err.includes('SYNTHETIC_NOT_A_CREDENTIAL'),false);
  const result=JSON.parse(out);assert.equal(result.name,'TypeError');if(tlsReject)assert.equal(result.cause,'DEPTH_ZERO_SELF_SIGNED_CERT');
}
test('tested Node proxy flag sends HTTPS CONNECT only to the configured loopback proxy',async t=>runProxyCase(t));
test('the same HTTPS proxy path preserves default TLS certificate rejection',async t=>runProxyCase(t,true));
