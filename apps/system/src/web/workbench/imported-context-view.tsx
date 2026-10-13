// @module workbench
// @role view
import type {useImportedContextController} from './imported-context-controller';

export function ImportedContextView({model}:{model:ReturnType<typeof useImportedContextController>}){
const {document,resource,open,editor,directory,canEdit,source,message,load,definitionScope,current,parent,type,save}=model;
return <section aria-label="Issueの親と種別・原記録">
  {current.number!=null&&<p>Issue番号: {current.number} · 作成者: {current.createdById??'未設定'} · 種別ID: {current.typeId??'未設定'} · 優先度: {current.priorityKey??'数値設定'}</p>}
  {resource.kind==='issue'&&current.parentId&&<button className="secondary" onClick={()=>open({kind:'issue'},current.parentId!)}>親Issueを開く · {current.parentId}</button>}
  {document.metadata&&<details><summary>移行時の原属性を確認</summary><pre>{JSON.stringify(document.metadata,null,2)}</pre></details>}
  {resource.kind==='issue'&&<div className="attribute-grid"><label>親Issue ID<input aria-label="親Issue ID" disabled={!canEdit} value={parent} onChange={e=>editor.inputAttributes({parentId:e.target.value})}/></label><button className="secondary" disabled={!canEdit} onClick={()=>void save({parentId:parent||null})}>親を保存</button><label>種別<select aria-label="種別" disabled={!canEdit} value={type} onChange={e=>editor.inputAttributes({typeId:e.target.value})}><option value="">未設定</option>{directory?.definitions.filter(d=>d.scopeId===definitionScope&&d.sourceTable==='task_types').map(d=><option key={String(d.record.id)} value={String(d.record.id)}>{String(d.record.name??d.record.key??d.record.id)}</option>)}</select></label><button className="secondary" disabled={!canEdit} onClick={()=>void save({typeId:type||null})}>種別を保存</button></div>}
  {document.metadata&&<details><summary onClick={()=>void load()}>移行前の記録を読む</summary><p>原activity・Wiki改訂・解決記録・ゲート拒否監査です。ゲート拒否は元の運用監査記録であり、新しいIssue改訂ではありません。原ID・元の時刻値を保持し、新しい保存操作の履歴とは別に表示します。</p>{message&&<p role="status">{message}</p>}{source&&<><details><summary>移行時の原レコード</summary><pre>{JSON.stringify(source.record,null,2)}</pre></details>{source.history.map(h=><article key={h.sourceTable+h.sourceId}><p>{h.sourceTable} · {h.sourceId} · {h.actorName??'原記録の作者IDを参照'}</p><pre>{JSON.stringify(h.record,null,2)}</pre></article>)}<button disabled={source.page===1} onClick={()=>void load(source.page-1)}>前の原記録</button><span> {source.page} / {Math.max(1,Math.ceil(source.historyTotal/10))} </span><button disabled={source.page*10>=source.historyTotal} onClick={()=>void load(source.page+1)}>次の原記録</button></>}</details>}
 </section>;
}
