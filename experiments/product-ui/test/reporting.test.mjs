import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import reporter from '../e2e/github-reporter.mjs';
import {CASES,PREFIX,phase} from '../e2e/trace.mjs';
async function report(events){let output='';for await(const line of reporter((async function*(){yield*events;})()))output+=line;return output;}
test('custom reporter never forwards raw errors, hostile names, headers, editor text or URLs',async()=>{
  const out=await report([
    {type:'test:stdout',data:{message:'Cookie: secret\n'+PREFIX+'{"id":"C01","phase":"fixture_start","state":"start"}\n'}},
    {type:'test:fail',data:{name:'private editor text',details:{error:{message:'Authorization: secret'}}}},
    {type:'test:stderr',data:{message:'https://secret.invalid/private\n'+PREFIX+'{"id":"C01","phase":"private","state":"fail"}\n'}},
  ]);
  assert.match(out,/C01 fixture_start start/);for(const value of ['Cookie','secret','private','Authorization'])assert.ok(!out.includes(value));
});
test('fragmented safe phase markers survive reporter stream chunking',async()=>{
  const message=PREFIX+'{"id":"C02","phase":"create_save","state":"timeout"}\n';
  const out=await report([{type:'test:stdout',data:{message:message.slice(0,9)}},{type:'test:stdout',data:{message:message.slice(9)}}]);
  assert.match(out,/C02 create_save timeout/);
});
test('real Node reporter emits column-zero GitHub annotation and preserves a failing exit',()=>{
  const dir=mkdtempSync(join(tmpdir(),'projektor-reporter-'));
  try{
    const file=join(dir,'failure.test.mjs');
    writeFileSync(file,`import {test} from 'node:test';test(${JSON.stringify(CASES[0])},()=>{process.stdout.write(${JSON.stringify(PREFIX+'{"id":"C01","phase":"create_project","state":"fail"}\n')});throw Error('SECRET_COOKIE_SENTINEL');});`);
    const result=spawnSync(process.execPath,['--test','--test-timeout=2000','--test-reporter='+resolve('e2e/github-reporter.mjs'),file],{encoding:'utf8',env:{...process.env,NODE_TEST_CONTEXT:undefined,GITHUB_ACTIONS:'true'},timeout:10000});
    assert.equal(result.status,1);assert.match(result.stdout,/^::error title=UI E2E diagnostic::UI E2E C01 create_project fail$/m);
    assert.ok(!result.stdout.includes('# ::'));assert.ok(!result.stdout.includes('SECRET_COOKIE_SENTINEL'));assert.ok(!result.stderr.includes('SECRET_COOKIE_SENTINEL'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('bounded phase fails rather than treating a stuck operation as success',async()=>{
  const start=Date.now();await assert.rejects(phase({name:CASES[0]},'fixture_start',()=>new Promise(()=>{}),15),/UI_TEST_PHASE_TIMEOUT C01 fixture_start/);
  assert.ok(Date.now()-start<500);
});
test('late fixture acquisition after timeout is closed rather than leaked into an ended test',async()=>{
  const {resourcePhase}=await import('../e2e/trace.mjs');let release,closes=0;
  const pending=resourcePhase({name:CASES[0]},'fixture_start',()=>new Promise(r=>release=r),'fixture_close',async value=>{assert.equal(value,'late fixture');closes++;},15);
  await assert.rejects(pending,/UI_TEST_PHASE_TIMEOUT/);release('late fixture');
  await new Promise(r=>setTimeout(r,10));assert.equal(closes,1);
});
test('cleanup failure does not replace the first failing phase with a later successful close',async()=>{
  const out=await report([
    {type:'test:stdout',data:{message:PREFIX+'{"id":"C01","phase":"context_close","state":"timeout"}\n'+PREFIX+'{"id":"C01","phase":"fixture_close","state":"pass"}\n'}},
    {type:'test:fail',data:{name:CASES[0]}},
  ]);
  assert.match(out,/C01 context_close fail/);
});
test('reporter final summary gives exact static failed IDs without depending on capped pass notices',async()=>{
  const events=CASES.map((name,index)=>({type:[2,3,10].includes(index)?'test:fail':'test:pass',data:{name}}));
  const out=await report(events);assert.match(out,/summary passed=14 failed=3 incomplete=0 runner_failed=false failed_ids=C03,C04,C11/);
  const incomplete=await report([{type:'test:pass',data:{name:CASES[0]}}]);assert.match(incomplete,/passed=1 failed=0 incomplete=16/);
});
test('phase and Node failure duplicates produce one case annotation plus one final summary',async()=>{
  const previous=process.env.GITHUB_ACTIONS;process.env.GITHUB_ACTIONS='true';
  try{
    const out=await report([
      {type:'test:stdout',data:{message:PREFIX+'{"id":"C01","phase":"draft_protect","state":"timeout"}\n'+PREFIX+'{"id":"C01","phase":"scenario_body","state":"fail"}\n'}},
      {type:'test:fail',data:{name:CASES[0]}},{type:'test:fail',data:{name:CASES[0]}},
    ]);
    assert.equal((out.match(/^::error /gm)||[]).length,2);
    assert.match(out,/::error title=UI E2E diagnostic::UI E2E C01 draft_protect fail/);
  }finally{if(previous===undefined)delete process.env.GITHUB_ACTIONS;else process.env.GITHUB_ACTIONS=previous;}
});
test('suite cleanup failure is not hidden by seventeen passing cases',async()=>{
  const out=await report([...CASES.map(name=>({type:'test:pass',data:{name}})),{type:'test:stdout',data:{message:PREFIX+'{"id":"S00","phase":"browser_close","state":"fail"}\n'}}]);
  assert.match(out,/passed=17 failed=0 incomplete=0 runner_failed=true/);
});

test('Wiki C13–C17 cases are individually reported and unknown case IDs remain suppressed',async()=>{assert.equal(CASES.length,17);const events=CASES.map((name,index)=>({type:index>=12?'test:fail':'test:pass',data:{name}}));for(let n=13;n<=17;n++)events.unshift({type:'test:stdout',data:{message:PREFIX+JSON.stringify({id:'C'+n,phase:'scenario_body',state:'fail'})+'\n'}});events.unshift({type:'test:stdout',data:{message:PREFIX+JSON.stringify({id:'C18',phase:'scenario_body',state:'fail'})+'\n'}});const out=await report(events);assert.match(out,/passed=12 failed=5 incomplete=0 runner_failed=false failed_ids=C13,C14,C15,C16,C17/);for(let n=13;n<=17;n++)assert.match(out,new RegExp('C'+n+' scenario_body fail'));assert.ok(!out.includes('C18'));});
test('Wiki diagnostic phases are allowlisted and never forward raw lock codes or response details',async()=>{const out=await report([{type:'test:stdout',data:{message:PREFIX+JSON.stringify({id:'C13',phase:'wiki_editor_ready',state:'fail'})+'\n'+PREFIX+JSON.stringify({id:'C13',phase:'wiki_http_403',state:'fail'})+'\n'+PREFIX+JSON.stringify({id:'C13',phase:'wiki_lock_binding',state:'fail'})+'\n'+PREFIX+JSON.stringify({id:'C13',phase:'PRIVATE_DRAFT_SENTINEL',state:'fail'})+'\n'+PREFIX+JSON.stringify({id:'C13',phase:'wiki_lock_other',state:'fail',body:'SECRET_KEY_SENTINEL'})+'\n'}}]);assert.match(out,/wiki_editor_ready fail/);assert.match(out,/wiki_http_403 fail/);assert.match(out,/wiki_lock_binding fail/);assert.ok(!out.includes('PRIVATE_DRAFT_SENTINEL'));assert.ok(!out.includes('SECRET_KEY_SENTINEL'));});
