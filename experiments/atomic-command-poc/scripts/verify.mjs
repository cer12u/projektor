// Reproducible local acceptance ledger. Browser acceptance must be explicitly run.
import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,readdirSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
mkdirSync(root+'/evidence',{recursive:true});
const suites=[['node','test'],['workerd','workerd'],['transport','transport-test'],['client','client-test'],['service','service-test']].map(([name,dir])=>[name,readdirSync(root+'/'+dir).filter(f=>f.endsWith('.test.mjs')).map(f=>dir+'/'+f)]);
suites.push(['release',readdirSync(root+'/release').filter(f=>f.endsWith('.test.mjs')).map(f=>'release/'+f)]);
suites.push(['browser-fixture',['browser-test/fixture-authz.test.mjs']]);
if(process.env.RUN_BROWSER==='1')suites.push(['browser',['browser-test/browser.test.mjs','browser-test/my-issues.test.mjs','browser-test/issue-content.test.mjs']]);
const results=[];
for(const [name,files] of suites){
 const run=spawnSync(process.execPath,[...(name==='release'?['--experimental-vm-modules']:[]),'--test','--test-reporter=tap',...files],{cwd:root,encoding:'utf8'});
 const path=`evidence/service-boundary-${name}.tap`;writeFileSync(root+'/'+path,run.stdout+run.stderr);
 const field=name=>Number(run.stdout.match(new RegExp('^# '+name+' (\\d+)','m'))?.[1]??0);
 results.push({name,exitCode:run.status,tests:field('tests'),pass:field('pass'),fail:field('fail'),skipped:field('skipped'),cancelled:field('cancelled'),evidence:path,sha256:sha(root+'/'+path)});
}
const result={generatedAt:new Date().toISOString(),baselineCommit:'69e9e2ca6876c95808dd09968beb7358545cfe5a',candidateCommit:null,node:process.version,compatibilityDate:'2026-07-30',results,browserAcceptance:process.env.RUN_BROWSER==='1'?'SEE_RESULTS':'NOT_RUN_LOCAL; pending exact-commit approved isolated CI',limitations:['Access human/service-token adapter tested using mocked HTTP JWKS; actual provider not verified','Fresh zero-base SQLite schema only; populated-store migration not implemented','I1 Issue create/body/comments/assignment/priority implemented; Wiki integration and later capability gates remain separate','MCP pure adapter tested; production MCP transport not integrated','No production deployment, canonical record write, cutover or legacy removal']};
writeFileSync(root+'/TEST-RESULTS.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));process.exitCode=results.every(r=>r.exitCode===0&&r.tests>0&&r.tests===r.pass)?0:1;
