import { denyOutbound } from '../test-support/offline.mjs';
// Local-only server for real-browser tests. No production credentials or deploy.
import { createServer } from 'node:http';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../',import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const issuer = 'https://ephemeral-browser-issuer.invalid';
const cookieName = 'projektor_test_session';

/**
 * startHarness() -> {base, ids, login, control, close}
 * login(playwrightContext, 'A'|'B', {renew:false, ttlSeconds:600}) installs an
 * HttpOnly SameSite=Strict fixture cookie. Renew keeps a still-active session;
 * fresh login always allocates a new session. No key or token is logged.
 * Private control actions: effects/inspect, authzVersion, revokeCurrentProject,
 * revokeOriginalProject, grantProject(actor,project), revokeMembership(actor),
 * revokeCredential(actor), expire(actor,expiresAtMs), moveResource(project),
 * deleteResource, revokeKey(keyId), sql(statement,args). Actor defaults to A.
 * The control service has no HTTP route on the public loopback listener.
 */
export async function startHarness() {
 const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
 const ids = Object.fromEntries(['workspace','epoch','actorA','actorB','issue','project','otherProject'].map(key => [key,randomUUID()]));
 Object.assign(ids,{actor:ids.actorA,originalProject:ids.project,editorId:'title'});
 const contexts = new WeakMap();
 let mf, privateControl, closed = false;
 const server = createServer(async (incoming,outgoing) => {
  const headers = {'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
   'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};
  try {
   if (incoming.headers.host !== new URL(base).host) {outgoing.writeHead(403,headers);outgoing.end('Forbidden');return;}
   const url = new URL(incoming.url,base);
   if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/machine/')) {
    const requestHeaders = new Headers();
    for (let index=0;index<incoming.rawHeaders.length;index+=2) requestHeaders.append(incoming.rawHeaders[index],incoming.rawHeaders[index+1]);
    const init = {method:incoming.method,headers:requestHeaders};
    // Keep streaming: ingress performs its own byte limit and body deadline.
    if (!['GET','HEAD'].includes(incoming.method)) {init.body = incoming;init.duplex='half';}
    const result = await mf.dispatchFetch(url.href,init);
    outgoing.writeHead(result.status,{...headers,...Object.fromEntries(result.headers)});
    if (result.body) for await (const chunk of result.body) outgoing.write(chunk);
    outgoing.end();return;
   }
   if (!['GET','HEAD'].includes(incoming.method)) {outgoing.writeHead(405,headers);outgoing.end('Method not allowed');return;}
   if (url.pathname === '/fixture.json') {
    outgoing.writeHead(200,{...headers,'content-type':mime['.json']});
    outgoing.end(JSON.stringify({workspace:ids.workspace,epoch:ids.epoch,issue:ids.issue,project:ids.project,originalProject:ids.project,otherProject:ids.otherProject,editorId:ids.editorId}));return;
   }
   let pathname = decodeURIComponent(url.pathname);
   if (pathname === '/') pathname = '/browser/index.html';
   // Browser assets and explicitly allowed browser-safe client modules only.
   if (!pathname.startsWith('/browser/') && !['/client/recovery.mjs','/client/issue-content.mjs','/client/access-policy.mjs'].includes(pathname)) {outgoing.writeHead(404,headers);outgoing.end('Not found');return;}
   const file = resolve(root,`.${pathname}`);
   if (!file.startsWith(resolve(root,'browser')+sep) && !['client/recovery.mjs','client/issue-content.mjs','client/access-policy.mjs'].map(path=>resolve(root,path)).includes(file)) {outgoing.writeHead(404,headers);outgoing.end('Not found');return;}
   if (!(await stat(file)).isFile()) throw Error('Not a file');
   outgoing.writeHead(200,{...headers,'content-type':mime[extname(file)] ?? 'application/octet-stream'});
   outgoing.end(incoming.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
   if (!outgoing.headersSent) outgoing.writeHead(error.code === 'ENOENT' ? 404 : 503,headers);
   outgoing.end(error.code === 'ENOENT' ? 'Not found' : 'Fixture unavailable');
  }
 });
 await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const base = `http://127.0.0.1:${server.address().port}`;
 try {
  mf = new Miniflare({cf:false,host:'127.0.0.1',port:0,workers:[
   {name:'app',fetchMock:denyOutbound(),modules:true,scriptPath:fileURLToPath(new URL('./fixture-worker.mjs',import.meta.url)),compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],modulesRules:[{type:'Text',include:['**/*.sql'],fallthrough:true}],bindings:{TEST_ISSUER:issuer,TEST_PUBLIC_JWK:JSON.stringify(publicKey.export({format:'jwk'})),TEST_ORIGIN:base},durableObjects:{WORKSPACE:{className:'BrowserFixtureWorkspace',useSQLite:true}}},
   {name:'control',fetchMock:denyOutbound(),modules:true,scriptPath:fileURLToPath(new URL('../transport-test/control-worker.mjs',import.meta.url)),compatibilityDate:'2026-07-30',durableObjects:{WORKSPACE:{className:'BrowserFixtureWorkspace',scriptName:'app',useSQLite:true}}}
  ]});
  await mf.ready;
  privateControl = await mf.getWorker('control');
  await call('seedFixture',ids);
 } catch (error) {
  await mf?.dispose();server.closeAllConnections();await new Promise(resolve => server.close(resolve));throw error;
 }
 async function call(action,...args) {
  const result = await privateControl.fetch('http://private-control/',{method:'POST',body:JSON.stringify({workspace:ids.workspace,action,args})});
  if (!result.ok) throw Error(`Private fixture control failed (${result.status})`);
  return result.json();
 }
 async function login(context, actorLabel='A', options={}) {
  if (!['A','B'].includes(actorLabel)) throw Error('Fixture actor must be A or B');
  const actor = actorLabel === 'A' ? ids.actorA : ids.actorB;
  const previous = contexts.get(context);
  if (options.renew && (!previous || previous.principalId !== actor)) throw Error('No matching fixture session to renew');
  const credentialId = options.renew ? previous.credentialId : randomUUID();
  const sessionId = options.renew ? previous.sessionId : randomUUID();
  const now = Math.floor(Date.now()/1000);
  const ttl = options.ttlSeconds ?? 600;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw Error('Invalid fixture TTL');
  const expiresAt = (now+ttl)*1000;
  const subject = `fixture-subject-${actorLabel}`;
  const result = await call('loginFixture',{actor,credentialId,sessionId,issuer,subject,expiresAt,renew:options.renew ?? false});
  if (result.error) throw Error(result.error.code);
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'projektor-local+jwt',kid:'ephemeral-test-key'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss:issuer,sub:subject,aud:'projektor-local-human',kind:'human',cid:credentialId,wid:ids.workspace,iat:now-10,nbf:now-10,exp:now+ttl})).toString('base64url');
  const token = `${header}.${payload}.${sign('RSA-SHA256',Buffer.from(`${header}.${payload}`),privateKey).toString('base64url')}`;
  // Secure cookies require HTTPS. This one is HTTP loopback-only, HttpOnly,
  // SameSite Strict and restricted to this short-lived test origin.
  await context.addCookies([{name:cookieName,value:token,url:base,httpOnly:true,secure:false,sameSite:'Strict'}]);
  contexts.set(context,result);
  return result;
 }
 return {
  base,ids,login,
  control:(action,...args) => call('fixtureControl',action,args),
  async close() {
   if (closed) return;closed=true;
   server.closeAllConnections();
   await new Promise(resolve => server.close(resolve));
   await mf.dispose();
  }
 };
}
