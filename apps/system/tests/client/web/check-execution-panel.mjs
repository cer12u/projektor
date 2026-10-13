// @module verification
// @role browser-regression
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as hooks from '../../support/workspace-fixture/hooks.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const importBundle=async(options)=>{const b=await build({bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',...options});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
const {useIssueExecutionController,IssueApi,recordIdentity}=await importBundle({stdin:{contents:`export {useIssueExecutionController} from './src/web/workbench/issue-execution-controller';export {IssueApi} from './src/web/workbench/issue-api';export {recordIdentity} from './src/web/session/identity-observation';`,resolveDir:root},plugins:[{name:'controlled-hooks',setup(b){b.onResolve({filter:/^react$/},()=>({path:pathToFileURL(root+'/tests/support/workspace-fixture/hooks.mjs').href,external:true}));}}]});
const {IssueExecutionView}=await importBundle({entryPoints:[root+'/src/web/workbench/issue-execution-view.tsx']});
const full={principal:{id:'OWNER',kind:'human',displayName:'Owner'},authentication:'session',csrfToken:'synthetic',projects:[{id:'P',permissions:['view']}]};
let identity=full;const api=new IssueApi('OWNER',()=>{}),props={api,ownerId:'OWNER',projectId:'P',issueId:'ISSUE',zone:'UTC'};
const attempt={attemptId:'ATTEMPT',principalId:'AGENT',issueId:'ISSUE',projectId:'P',startOperationId:'START',startedAt:1700000000,updatedAt:1700000001,expiresAt:1700001000,leaseVersion:3,storedState:'interrupted',state:'interrupted',endedAt:1700000001,endReason:'disconnected',renewIntervalSeconds:30,leaseSeconds:60};
const report={sequence:1,principalId:'AGENT',operationId:'REPORT',issueId:'ISSUE',projectId:'P',attemptId:'ATTEMPT',kind:'completed',message:'A completed result <script>',failureReason:null,references:[{kind:'link',url:'javascript:alert(1)',label:'Unsafe artifact'},{kind:'library',libraryFileId:'LIBRARY_ORIGINAL',versionId:'FIXED_VERSION',url:'https://example.com/artifact'}],recordedAt:1700000001};
const confirmation={sequence:1,principalId:'AGENT',operationId:'CONFIRM',issueId:'ISSUE',projectId:'P',attemptId:'ATTEMPT',leaseVersion:3,outcome:'applied',externalOperationId:'EXTERNAL',references:[],message:'External effect verified',recordedAt:1700000002,newAttemptId:'NEXT_ATTEMPT'};
const event=(sequence,snapshot=report)=>({sequence,principalId:'AGENT',operationId:'EVENT_'+sequence,attemptId:'ATTEMPT',kind:'execution-report.completed',recordedAt:1700000001,snapshot});
const current={execution:attempt,reports:[report],confirmations:[confirmation]};
let paths=[],response=async path=>Response.json(path.endsWith('/execution-reports')?current:{events:[event(1)],nextAfter:1});
globalThis.fetch=async(path,options={})=>{assert(!options.method||options.method==='GET','read-only execution UI');if(path==='/api/auth/me')return Response.json(identity);paths.push(path);return response(path);};
const tick=()=>new Promise(r=>setTimeout(r,0));
async function render(){let model;for(let i=0;i<30;i++){hooks.begin();model=useIssueExecutionController(props);hooks.flush();await tick();if(!hooks.changed())return model;}throw Error('did not settle');}
const html=model=>renderToStaticMarkup(createElement(IssueExecutionView,{model}));
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
recordIdentity(full);let model=await render();let shown=html(model);
for(const marker of ['Agentの実行・報告','中断','切断','AGENT','A completed result &lt;script&gt;','反映済み','EXTERNAL','NEXT_ATTEMPT','LIBRARY_ORIGINAL','FIXED_VERSION','全試行の報告・再開履歴'])assert(shown.includes(marker),marker);
assert(!shown.includes('href="javascript:'));assert(shown.includes('href="https://example.com/artifact"'));assert(shown.includes('完了報告とIssueの解決状態は別'));
assert(paths.includes('/api/projects/P/issues/ISSUE/execution-reports'));assert(paths.includes('/api/projects/P/issues/ISSUE/execution-reports/history?after=0'));
response=async path=>{assert(path.endsWith('?after=1'));return Response.json({events:[event(1),event(2,{confirmation,importedReport:report,nextAction:'existing_result_imported',execution:attempt}),event(3,{confirmation,nextAction:'execute_new_attempt',attempt:{...attempt,attemptId:'NEXT_ATTEMPT'}})],nextAfter:null});};
await model.load(true);model=await render();assert.deepEqual(model.events.map(e=>e.sequence),[1,2,3]);assert.equal(model.nextAfter,null);shown=html(model);assert(shown.includes('既存結果を取込み済み'));assert(shown.includes('新しい試行で実行'));assert(!shown.includes('実行履歴の続きを表示'));
response=async()=>Response.json({error:'forbidden'},{status:403});await model.load();model=await render();assert.equal(model.reports,null);assert.equal(model.events.length,0);assert(!html(model).includes('A completed result'));
response=async path=>Response.json(path.endsWith('/execution-reports')?current:{events:[event(1)],nextAfter:1});await model.load();model=await render();assert(model.reports);
const pending=deferred();response=()=>pending.promise;const late=model.load();await tick();identity={...full,principal:{...full.principal,id:'OTHER'}};recordIdentity(identity);props.ownerId='OTHER';props.api=new IssueApi('OTHER',()=>{});response=async path=>Response.json(path.endsWith('/execution-reports')?{execution:null,reports:[],confirmations:[]}:{events:[],nextAfter:null});model=await render();pending.resolve(Response.json(current));await late;model=await render();assert(!html(model).includes('A completed result'));assert(!html(model).includes('ATTEMPT'));
// Same-principal permission loss clears already displayed records immediately.
identity=full;recordIdentity(full);props.ownerId='OWNER';props.api=api;response=async path=>Response.json(path.endsWith('/execution-reports')?current:{events:[event(1)],nextAfter:1});model=await render();assert(model.reports);identity={...full,projects:[]};recordIdentity(identity);model=await render();assert.equal(model.reports,null);assert.equal(model.events.length,0);
hooks.reset();
console.log('PASS execution panel: actual React rendering, controller and real IssueApi/session authority with controlled HTTP; current report, safe artifacts, reconciliation/restart, cursor pagination, 403, late subject switch, permission loss. Not a browser or D1 run.');
