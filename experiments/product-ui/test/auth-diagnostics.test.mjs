import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {CASES} from '../e2e/auth-diagnostics.mjs';
async function run(body,selection){
 const dir=await mkdtemp(join(tmpdir(),'auth-reporter-'));
 try{
  await mkdir(join(dir,'e2e'));const file=join(dir,'e2e/app-auth.test.mjs');await writeFile(file,"import {test} from 'node:test';\n"+body);
  return spawnSync(process.execPath,['--test','--test-timeout=2000','--test-reporter='+resolve(import.meta.dirname,'../e2e/auth-diagnostics.mjs'),file],{encoding:'utf8',timeout:10000,env:{...process.env,NODE_TEST_CONTEXT:undefined,PROJEKTOR_AUTH_CASES:'human',PROJEKTOR_AUTH_HUMAN_CASES:selection,GITHUB_ACTIONS:'true',GITHUB_STEP_SUMMARY:join(dir,'summary')}});
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('real Node reporter counts the exact three known cases',async()=>{
 const result=await run(CASES.human.map(name=>`test(${JSON.stringify(name)},()=>{});`).join('\n'));
 assert.equal(result.status,0);assert.match(result.stdout,/^# tests 3$/m);assert.match(result.stdout,/^# pass 3$/m);assert.match(result.stdout,/^# runner_failed false$/m);assert.match(result.stdout,/^# incomplete 0$/m);assert.match(result.stdout,/^::notice title=Auth browser summary::Auth browser human: expected=3 passed=3 failed=0 cancelled=0 skipped=0 todo=0 incomplete=0 runner_failed=false$/m);
});
test('real Node failure and skip cannot turn green or disclose unknown diagnostics',async()=>{
 const marker='PRIVATE_COOKIE_PASSWORD_BODY';
 const result=await run(`test(${JSON.stringify(CASES.human[0])},()=>{console.log('${marker}');});\ntest(${JSON.stringify(CASES.human[1])},{skip:true},()=>{});\ntest(${JSON.stringify(CASES.human[2])},()=>{console.log('@@PROJEKTOR_AUTH_PHASE '+JSON.stringify({id:'H03',phase:'issue_open',state:'fail'}));console.log('@@PROJEKTOR_AUTH_PHASE '+JSON.stringify({id:'H03',phase:'${marker}',state:'fail'}));console.log('@@PROJEKTOR_AUTH_PHASE '+JSON.stringify({id:'H03',phase:'cleanup',state:'pass',secret:'${marker}'}));console.log('@@PROJEKTOR_AUTH_PHASE '+JSON.stringify({id:'H03',phase:'cleanup',state:'pass'}));const e=new Error('${marker} /e2e/app-auth.test.mjs:1234567:7654321');e.name='TimeoutError';e.stack='TimeoutError: ${marker} /e2e/app-auth.test.mjs:1234567:7654321';throw e;});\ntest('${marker}',()=>{throw new Error('${marker}');});`);
 assert.notEqual(result.status,0);assert.match(result.stdout,/^# tests 3$/m);assert.match(result.stdout,/^# pass 1$/m);assert.match(result.stdout,/^# fail 1$/m);assert.match(result.stdout,/^# skipped 1$/m);assert.match(result.stdout,/^# runner_failed true$/m);assert.match(result.stdout,/Auth browser H03: phase=issue_open; category=TimeoutError\/testCodeFailure/);assert.match(result.stdout,/location=experiments\/product-ui\/e2e\/app-auth.test.mjs:4:1/);assert.ok(!result.stdout.includes('1234567'));assert.ok(!result.stdout.includes('7654321'));assert.ok(!result.stdout.includes(marker));assert.ok(!result.stderr.includes(marker));
});
test('an extra passing Node case is rejected by the strict runner gate',async()=>{
 const result=await run(CASES.human.map(name=>`test(${JSON.stringify(name)},()=>{});`).join('\n')+"\ntest('UNEXPECTED_PRIVATE_NAME',()=>{});");
 assert.equal(result.status,0);assert.match(result.stdout,/^# pass 3$/m);assert.match(result.stdout,/^# runner_failed true$/m);assert.ok(!result.stdout.includes('UNEXPECTED_PRIVATE_NAME'));
});

test('H01-only counts one case and only fixed witness IDs survive failure output',async()=>{
 const prefix='@@PROJEKTOR_AUTH_PHASE ';
 const packets=[{id:'H01',phase:'firsttab_editor',state:'timeout'},{id:'H01',phase:'witness_peer_signal_seen',state:'pass'},{id:'H01',phase:'witness_root_unknown',state:'pass'},{id:'H01',phase:'witness_root_PRIVATE',state:'pass'},{id:'H01',phase:'witness_editor_visible',state:'pass',secret:'PRIVATE'},{id:'H02',phase:'witness_root_ready',state:'pass'},{id:'H01',phase:'cleanup',state:'pass'}];
 const body=`test(${JSON.stringify(CASES.human[0])},()=>{${packets.map(value=>`console.log(${JSON.stringify(prefix+JSON.stringify(value))});`).join('')}throw new Error('PRIVATE');});`;
 const failed=await run(body,'H01');
 assert.notEqual(failed.status,0);assert.match(failed.stdout,/expected=1 passed=0 failed=1 cancelled=0 skipped=0 todo=0 incomplete=0 runner_failed=false/);
 assert.match(failed.stdout,/phase=firsttab_editor;.*witnesses=witness_peer_signal_seen,witness_root_unknown/);
 for(const denied of ['PRIVATE','witness_editor_visible','witness_root_ready'])assert.ok(!failed.stdout.includes(denied));
 const pass=await run(`test(${JSON.stringify(CASES.human[0])},()=>{});`,'H01');
 assert.equal(pass.status,0);assert.match(pass.stdout,/^# tests 1$/m);assert.match(pass.stdout,/^# pass 1$/m);assert.match(pass.stdout,/expected=1 passed=1 failed=0 cancelled=0 skipped=0 todo=0 incomplete=0 runner_failed=false/);
 const extra=await run(CASES.human.map(name=>`test(${JSON.stringify(name)},()=>{});`).join('\n'),'H01');
 assert.match(extra.stdout,/^# runner_failed true$/m);assert.match(extra.stdout,/^# tests 1$/m);
 const invalid=await run(`test(${JSON.stringify(CASES.human[0])},()=>{});`,'H02');
 assert.notEqual(invalid.status,0);assert.ok(!invalid.stdout.includes('# pass 1'));
});
