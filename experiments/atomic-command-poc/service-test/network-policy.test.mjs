import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare} from 'miniflare';
import {denyOutbound} from '../test-support/offline.mjs';
test('all fixture constructors explicitly disable optional external Request.cf metadata',()=>{
 for(const path of ['workerd/command.test.mjs','workerd/my-issues.test.mjs','transport-test/http.test.mjs','transport-test/my-issues-http.test.mjs','browser-test/server.mjs','service-test/http.test.mjs']){
  const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');assert.match(source,/cf:false/,path);assert.match(source,/fetchMock:/,path);
 }
});
test('unmocked worker HTTP is denied by mock dispatcher before any network connection',async()=>{
 const mock=denyOutbound(),denials=[];const dispatch=mock.dispatch.bind(mock);mock.dispatch=(options,handler)=>{try{const observed=Object.create(handler);observed.onError=error=>{denials.push(error.code);return handler.onError(error);};return dispatch(options,observed);}catch(error){denials.push(error.code);throw error;}};
 const mf=new Miniflare({cf:false,fetchMock:mock,modules:true,script:`export default {async fetch(){try{const result=await fetch('https://unmocked.example.invalid/');return new Response(JSON.stringify({status:result.status,body:await result.text()}));}catch{return new Response('outbound denied',{status:200});}}};`});
 try{const r=await mf.dispatchFetch('http://fixture.test/');assert.equal(r.status,200);const body=await r.text();if(body!=='outbound denied'){const blocked=JSON.parse(body);assert.equal(blocked.status,500);assert.match(blocked.body,/fetch failed/); }assert.deepEqual(denials,['UND_MOCK_ERR_MOCK_NOT_MATCHED']);}finally{await mf.dispose();}
});
