// @module verification
// @role browser-regression
import {build} from 'esbuild';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';import {writeFile,mkdir} from 'node:fs/promises';
const root=fileURLToPath(new URL("../../../",import.meta.url));
await mkdir('.local/evidence',{recursive:true});
const bundled=await build({entryPoints:[root+'/src/web/workbench/history-entry.tsx'],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic'});
const {HistoryEntry}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const history={revision:3,actorName:'<editor>',actorId:'ACTOR',kind:'issue.edit',beforeBody:'original',afterBody:'updated',changedFields:['priority','assigneeId','state','schedule'],before:{priority:4,assigneeId:'OLD',assignee:{id:'OLD',displayName:'Older',kind:'agent'},state:'Todo',schedule:{start:{kind:'date',date:'2026-10-12'},end:null,due:{kind:'unknown'}}},after:{priority:null,assigneeId:null,state:'Done',schedule:{start:{kind:'instant',at:'2026-10-12T00:05:06Z'},end:null,due:null}},beforeReferences:[],afterReferences:[]};
const html=renderToStaticMarkup(createElement(HistoryEntry,{history,zone:'Asia/Tokyo'}));
for(const value of ['&lt;editor&gt;','ACTOR','Older · API主体 · OLD','変更前: 4','変更後: 未設定','Todo','Done','日付のみ','時刻不明（過去記録）','09時05分06秒','Asia/Tokyo','original','updated','変更前の関連リンク','変更後の関連リンク'])assert(html.includes(value),value);
assert(!html.includes('<editor>'));await writeFile('.local/evidence/history-render.html',html+'\n');console.log(JSON.stringify({candidate:root,level:'actual React server rendering of HistoryEntry; no browser/DOM interactions',passed:true}));
