// @module workbench
// @role view
import type {useProjectController} from './project-controller';
import type {DirectoryEntity} from '../../modules/work/directory-contracts';
const title=(entity:DirectoryEntity)=>entity.kind==='project'?'Project':'Workspace';
export function ProjectManagementView({model}:{model:ReturnType<typeof useProjectController>}){
 const {identity,context,edit,pendingId,latest,history,busy,message,storage,canRetry,locked,refresh,change,create,open,save,recover,transmit,hold,adopt,loadHistory}=model;
 const entity=edit?.base,scope=entity?(entity.kind==='workspace'?entity.scopeId:entity.id):null;
 return <section className="management" aria-label="Project・Workspace管理"><header className="section-heading"><div><h1>Project・Workspace</h1><p>仕事の作成先と名前を管理します。</p></div><a href="/">仕事に戻る</a></header>
  <div className="actions"><button className="secondary" disabled={busy} onClick={()=>void refresh()}>権限と最新版を再確認</button>{context?.canCreate&&<><button disabled={busy||!!pendingId} onClick={()=>create('workspace')}>Workspaceを作成</button><button disabled={busy||!!pendingId||context.workspaces.length===0} onClick={()=>create('project')}>Projectを作成</button></>}</div>
  {message&&<p role="status" className="notice">{message}</p>}{!storage&&<p role="alert" className="warning">端末への保存が利用できません。新しい操作の送信を停止しています。入力はこの画面のメモリに保持しています。</p>}
  {!context&&<p className="warning">現在の権限を確認するまで、保存済み情報と入力を非表示にしています。</p>}
  {pendingId&&!edit&&<p>保持した操作ID: {pendingId}</p>}
  {context&&<div className="management-grid"><nav className="management-list" aria-label="管理対象"><h2>Workspace</h2>{context.workspaces.map(item=><button className="secondary" key={item.id} disabled={busy||!!pendingId} onClick={()=>void open(item)}>{item.name}<small> · 改訂 {item.revision}</small></button>)}<h2>Project</h2>{context.projects.map(item=><button className="secondary" key={item.id} disabled={busy||!!pendingId} onClick={()=>void open(item)}>{item.name} · {item.key}<small> · 改訂 {item.revision}</small></button>)}{!context.projects.length&&!context.workspaces.length&&!context.canCreate&&<p>管理できる対象がありません。</p>}</nav>
   {edit&&<article className="editor"><h2>{entity?title(entity)+'を編集':(edit.draft.kind==='project'?'Project':'Workspace')+'を作成'}</h2>
    {entity&&<p className="issue-key">ID: {entity.id} · 改訂 {entity.revision}</p>}
    {scope&&identity.projects.some(p=>p.id===scope&&p.permissions.includes('view'))&&<p><a href={'/?'+new URLSearchParams({project:scope,content:entity?.kind==='workspace'?'wiki':'issue'}).toString()}>この作業領域を開く</a></p>}
    <form onSubmit={save}><label>名前<input aria-label="名前" value={edit.draft.name} maxLength={200} required disabled={locked} onChange={e=>change({name:e.target.value})}/></label>
     {edit.draft.kind==='project'&&<><label>Workspace<select aria-label="Workspace" value={edit.draft.workspaceId} disabled={locked||!!entity} required onChange={e=>change({workspaceId:e.target.value})}>{!context.workspaces.some(w=>w.id===edit.draft.workspaceId)&&<option value={edit.draft.workspaceId}>{edit.draft.workspaceId||'選択してください'}</option>}{context.workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label>キー<input aria-label="キー" value={edit.draft.key} maxLength={128} required disabled={locked||!!entity} onChange={e=>change({key:e.target.value})}/></label><label>URL名<input aria-label="URL名" value={edit.draft.slug} maxLength={128} required disabled={locked||!!entity} onChange={e=>change({slug:e.target.value})}/></label><label>説明<textarea aria-label="説明" value={edit.draft.description} maxLength={4000} rows={5} disabled={locked} onChange={e=>change({description:e.target.value})}/></label>{entity&&<p>作成先・キー・URL名は固定し、既存の参照を保持します。</p>}</>}
     <button disabled={locked||!edit.draft.name.trim()}>{busy?'処理中…':entity?'変更を保存':'作成'}</button></form>
    {scope&&<p><a href={'/management?'+new URLSearchParams({scope}).toString()}>この範囲の主体・権限管理で明示的に付与</a></p>}
    {!entity&&<p>作成で所属・閲覧・編集権限は追加されません。作成後に<a href="/management">主体・権限管理</a>で明示的に設定してください。</p>}
    {edit.pending&&<aside className="management-operation"><h3>結果を確認する操作</h3><p>操作ID: {edit.pending.command.input.operationId}</p><p>送信内容を固定して保持しています。未確定を未実行とは扱いません。</p><button disabled={busy} className="secondary" onClick={()=>void recover()}>操作結果を確認</button>{canRetry&&<><button disabled={busy||!storage} className="secondary" onClick={()=>void transmit(edit.pending!)}>同じ操作を再送</button>{entity&&<button disabled={busy} className="secondary" onClick={()=>void hold()}>未確定操作を保持して最新版と比較</button>}</>}</aside>}
    {latest&&<aside className="conflict-panel"><h3>最新版との比較</h3><p>改訂 {latest.revision} · 名前: {latest.name}</p>{latest.kind==='project'&&<pre>{latest.description}</pre>}<p>手入力は上の欄に保持しています。</p><button disabled={busy||!!edit.pending} onClick={adopt}>手入力を保持して最新版を基準にする</button></aside>}
    {edit.held.length>0&&<details><summary>保持した未確定操作</summary>{edit.held.map(item=><div key={item.command.input.operationId}><p>操作ID: {item.command.input.operationId}</p><button className="secondary" disabled={busy} onClick={()=>void recover(item)}>保持した操作の結果を確認</button></div>)}</details>}
    {entity&&<section className="history"><h3>変更履歴</h3><button className="secondary" disabled={busy} onClick={()=>void loadHistory()}>履歴を取得</button>{history?.history.map(row=><article key={row.revision}><p>改訂 {row.revision} · {row.actorId} · {row.recordedAt}</p><p>操作ID: {row.operationId}</p><p>変更前: {row.before?.name??'（新規作成）'}</p>{row.before?.kind==='project'&&<pre>{row.before.description}</pre>}<p>変更後: {row.after.name}</p>{row.after.kind==='project'&&<pre>{row.after.description}</pre>}</article>)}{history&&history.nextAfterRevision!==null&&<button className="secondary" disabled={busy} onClick={()=>void loadHistory(true)}>履歴の続きを取得</button>}</section>}
   </article>}
  </div>}
 </section>;
}
