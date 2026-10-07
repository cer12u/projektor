import { spawnSync } from 'node:child_process';
import { readFileSync,writeFileSync,readdirSync,mkdirSync,realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
mkdirSync(root+'/evidence',{recursive:true});
const results=[];
for(const [name,file] of [['node','test/command.test.mjs'],['workerd','workerd/command.test.mjs']]){
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap',file],{cwd:root,encoding:'utf8'});
 writeFileSync(root+`/evidence/${name}.tap`,run.stdout+run.stderr);
 const field=name=>Number(run.stdout.match(new RegExp('^# '+name+' (\\d+)','m'))?.[1]??0);
 results.push({name,exitCode:run.status,tests:field('tests'),pass:field('pass'),fail:field('fail'),skipped:field('skipped'),cancelled:field('cancelled'),logSha256:sha(root+`/evidence/${name}.tap`)});
}
const workerdBin=realpathSync(root+'/node_modules/.bin/workerd');
const version=spawnSync(workerdBin,['--version'],{encoding:'utf8'});
const pkg=name=>JSON.parse(readFileSync(root+`/node_modules/${name}/package.json`,'utf8')).version;
const result={generatedAt:new Date().toISOString(),baselineCommit:'da17a4512ac36641a9abd724d3924f639277df33',node:process.version,platform:process.platform,arch:process.arch,miniflare:pkg('miniflare'),workerdPackage:pkg('workerd'),workerdRuntime:version.stdout.trim(),workerdBinarySha256:sha(root+'/node_modules/@cloudflare/workerd-linux-64/bin/workerd'),lockSha256:sha(root+'/package-lock.json'),compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],results,limitations:['No production deployment or provider authentication','Local HTTP to workerd RPC duplicates, not real network retry scheduling','Injected post-commit RPC response loss, not packet loss','Clean runtime restart only, not kill/power/disk failure','Storage API failure outside callback not injected in actual runtime','Original title-command PoC scope; capability-v0.4 resource/history ACL extensions not implemented','Migration, full UI, external delivery and production capacity untested','Prepared GitHub workflow has not run for this candidate']};
writeFileSync(root+'/TEST-RESULTS.json',JSON.stringify(result,null,2)+'\n');
const walk=dir=>readdirSync(root+'/'+dir,{withFileTypes:true}).filter(e=>!['node_modules','.git','evidence'].includes(e.name)).flatMap(e=>e.isDirectory()?walk((dir?dir+'/':'')+e.name):[(dir?dir+'/':'')+e.name]);
const files=walk('').filter(p=>p!=='SHA256SUMS').sort();
writeFileSync(root+'/SHA256SUMS',files.map(p=>sha(root+'/'+p)+'  '+p).join('\n')+'\n');
console.log(JSON.stringify(result,null,2));process.exitCode=results.every(r=>r.exitCode===0&&r.tests>0&&r.tests===r.pass)?0:1;
