import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {configuration} from '../service/config.mjs';
const valid=()=>({APP_ORIGIN:'https://app.example',REQUEST_TIMEOUT_MS:'5000',BODY_TIMEOUT_MS:'1000',WORKSPACE_IDS:JSON.stringify([randomUUID()]),PROVIDER_CONFIG:'{}',WORKSPACE:{idFromName(){},get(){}}});
test('production origin, finite request budgets and bounded unique registry required',()=>{
 assert.equal(configuration(valid()).deadline,5000);
 for(const patch of [{APP_ORIGIN:'http://app.example'},{APP_ORIGIN:'https://app.example/'},{APP_ORIGIN:'https://user:password@app.example'},{REQUEST_TIMEOUT_MS:'Infinity'},{REQUEST_TIMEOUT_MS:'0'},{BODY_TIMEOUT_MS:'6000'},{WORKSPACE_IDS:'[]'},{WORKSPACE_IDS:JSON.stringify(Array.from({length:11},randomUUID))},{WORKSPACE_IDS:JSON.stringify(['not-a-workspace'])},{WORKSPACE:null}])assert.throws(()=>configuration({...valid(),...patch}),{code:'SERVICE_CONFIG_INVALID'});
 const id=randomUUID();assert.throws(()=>configuration({...valid(),WORKSPACE_IDS:JSON.stringify([id,id])}));
});
