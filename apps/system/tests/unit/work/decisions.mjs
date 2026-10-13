// @module verification
// @role work-application-regression
// Hypotheses: resolution is recomputed on Done→Done, reopening leaves resolution, stale imported
// status choices are selected in SQL, or saved execution bypasses the ordinary application.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const dir=resolve('.local/work-decisions');await mkdir(dir,{recursive:true});
const entry=`export * from './src/modules/work/decisions';export {createWorkContent} from './src/modules/work/application';export {createPreparedOperations} from './src/apps/prepared-operations/application';export {decodePreparedCommand,describePreparedCommand} from './src/apps/prepared-operations/commands';`;
const built=await build({stdin:{contents:entry,resolveDir:process.cwd()},outfile:dir+'/unit.mjs',bundle:true,platform:'node',format:'esm',metafile:true});
const unit=await import(pathToFileURL(dir+'/unit.mjs').href),inputs=Object.keys(built.metafile.inputs).filter(p=>p!=='<stdin>');
assert(!inputs.some(p=>p.includes('/adapters/')||(p.includes('/apps/')&&!p.includes('/apps/prepared-operations/'))),inputs.join('\n'));
const id='I_'+'1'.repeat(64),base={kind:'edit',projectId:'P',issueId:id,input:{operationId:'state',revision:7,state:'Done'}};
const state=(status,metadata=null)=>({current:{id,revision:7,state:status,metadata},statusDefinitions:[]});
const transition=(next,current)=>unit.decideIssueChange({...base,input:{...base.input,state:next}},state(current)).plan.transition;
assert.equal(transition('Done','Todo').resolution,'stamp');
assert.equal(transition('Done','Done').resolution,'preserve');
assert.equal(transition('Todo','Done').resolution,'clear');
assert.equal(transition('Canceled','Done').resolutionEvent,'reopened');
assert.equal(transition('Done','Todo').resolutionEvent,'resolved');
assert.equal(transition('Done','Done').resolutionEvent,null);
assert.equal(transition('Todo','Backlog').resolutionEvent,null);
assert.deepEqual(unit.decideIssueChange(base,{...state('Todo'),current:{...state('Todo').current,revision:8}}),{kind:'reject',reason:'revision_conflict'});
assert.deepEqual(unit.decideIssueChange(base,state('Todo',{})),{kind:'reject',reason:'status_definition_unavailable'});
const imported={...state('Todo',{}),statusDefinitions:[{id:'done-1',key:'done'}]};
assert.deepEqual(unit.decideIssueChange(base,imported).plan.transition.status,{kind:'replace',id:'done-1',key:'done'});
assert.equal(unit.decideIssueChange(base,{...imported,statusDefinitions:[...imported.statusDefinitions,{id:'done-2',key:'done'}]}).kind,'reject');
const related=unit.decideIssueChange({...base,input:{operationId:'related',revision:7,parentId:id,typeId:'type',assigneeId:'agent',priority:null}}).plan;
assert.deepEqual(related.related,[{kind:'workspace_type',id:'type'},{kind:'acyclic_parent',id},{kind:'eligible_assignee',id:'agent'}]);
assert.deepEqual(related.permissions.sort(),['assign','edit']);assert.equal(related.priorityKey,'none');
const commits=[],inspections=[],outcome={application:'confirmed',disclosure:'allowed',source:'committed',receipt:{operationId:'state',snapshot:{id}}};
let inspection={kind:'state',state:state('Todo')};
const port={async inspectIssueChange(command){inspections.push(command);return inspection;},async commitIssueChange(command,plan,fence){commits.push({command,plan,fence});return outcome;},async rejectIssueChange(){throw new Error('Unexpected rejection');}};
const work=unit.createWorkContent(port);
assert.deepEqual(await work.changeIssue(base),outcome);assert.equal(commits[0].plan.transition.resolution,'stamp');
const fence={operationId:'state',formatVersion:1,kind:'issue.edit',projectId:'P',targetId:id,routeJson:'{}',inputJson:'{}',hash:'x',permissions:['view','transition']};
let durable={operationId:'state',formatVersion:1,route:{kind:'issue',projectId:'P',id},input:base.input,result:{status:'unknown'}};
const journal={async get(){return durable;},async executionFence(){return fence;}};
const sameWork={...work,async changeIssue(command,proof){const result=await work.changeIssue(command,proof);durable={...durable,result:{status:'confirmed',snapshot:result.receipt.snapshot}};return result;}};
const operations=unit.createPreparedOperations(journal,sameWork,{});
assert.equal((await operations.execute('state')).receipt.source,'committed');
assert.deepEqual(commits[1].plan,commits[0].plan);assert.deepEqual(commits[1].fence,fence);
const priorInspections=inspections.length;
assert.equal((await operations.execute('state')).receipt.source,'recovered');assert.equal(inspections.length,priorInspections,'receipt recovery never replans');
durable={...durable,formatVersion:999};assert.equal((await operations.execute('state')).receipt.source,'recovered');
durable={...durable,result:{status:'unknown'}};await assert.rejects(()=>operations.execute('state'),e=>e.failure.code==='operation_format_unsupported');
inspection={kind:'outcome',outcome:{application:'unknown',disclosure:'denied',operationId:'state',failure:{kind:'forbidden',code:'forbidden'}}};
assert.deepEqual(await work.changeIssue(base),inspection.outcome);assert.equal(commits.length,2,'denied state cannot dispatch');
// Negative control: a local compiler transform corrupts the actual pure transition branch.
await build({stdin:{contents:entry,resolveDir:process.cwd()},outfile:dir+'/mutant.mjs',bundle:true,platform:'node',format:'esm',plugins:[{name:'resolution-control',setup(b){b.onLoad({filter:/modules\/work\/decisions\.ts$/},async a=>({contents:(await readFile(a.path,'utf8')).replace("current.state==='Done'?'preserve':'stamp'","'preserve'"),loader:'ts'}));}}]});
const mutant=await import(pathToFileURL(dir+'/mutant.mjs').href);
assert.throws(()=>assert.equal(mutant.decideIssueChange(base,state('Todo')).plan.transition.resolution,'stamp'));
const report={status:'passed',actualD1:false,providerRequests:0,negativeControlDetected:true,sourceHashes:Object.fromEntries(await Promise.all([...inputs,'tests/unit/work/decisions.mjs'].map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])))};
await writeFile(dir+'/result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
