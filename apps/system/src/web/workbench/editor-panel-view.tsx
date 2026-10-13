// @module workbench
// @role view
import type {useEditorPanelController} from './editor-panel-controller';
import {ReferenceEditor,ReferenceList} from './references';
import {sameReferences} from "../../modules/work/reference-contracts";
import {draftReferences} from './edit-state';
import {ImportedContext} from './imported-context';

import {bodyLimit,blankBodyAllowed} from "../../modules/work/content-contracts";
import {unsavedRecord} from './edit-state';
import {IssueAttributes} from './issue-attributes';
import {HistoryEntry} from './history-entry';
import {displayTime} from './planning-time';
import {isIssue} from './content-response-validation';
import {labels} from './editor-status';
import {IssueExecutionPanel} from './issue-execution';
import {ParentComments} from './parent-comments';
export function EditorPanelView({model}:{model:ReturnType<typeof useEditorPanelController>}){
const {directory,editor,canEdit,identity,zone,identityChanged,openContent,view,r,label,canView,historyRows,historyMessage,copyMessage,historyAfter,historyLoading,events,textRef,copy,download,history}=model;
  if(!canView||view.accessLost)return <aside className="warning" role="alert"><p>現在の閲覧許可を確認できないため内容を非表示にしています。入力は元の主体の下書きに保持しています。</p>{canView&&<button className="secondary" onClick={()=>void editor.refresh()}>閲覧許可を再確認</button>}</aside>;
return <article className="editor" aria-busy={!view.ready}>
    <header className="editor-heading"><div><p className="eyebrow">{r.projectId} / {label}</p><h1>{!r.base?'新しい'+label:label+'を編集'}</h1>{r.base&&<p className="issue-key">{r.base.id}</p>}</div><span className={'save-state state-'+r.status} data-testid="save-state" role="status">{r.status==='clean'&&!r.base?'未作成':labels[r.status]}</span></header>
    {!view.storageAvailable&&<aside className="warning" role="alert">端末への下書き保存が使えません。閉じる前に入力をコピー、または操作IDを含む下書きをダウンロードしてください。自動再送は停止しています。</aside>}
    {r.message&&<p className={'notice '+(['blocked','invalid','conflict'].includes(r.status)?'warning':'')} role="status" data-testid="editor-message">{r.message}</p>}
    <div className="edit-meta"><span>取得した改訂: <strong data-testid="base-revision">{r.base?.revision??'未作成'}</strong>{r.base?.revisionOrigin==='new-import-baseline'?' · 移行後の保存基準':r.base?.revisionOrigin==='source-version'?' · 元のWiki版から継続':''}</span><span>{view.writes?'端末に保存中…':view.storageAvailable?(unsavedRecord(r)?'下書きを端末に保持':'確認した本文を表示'):'メモリに保持'}</span><span>UTF-8: {new TextEncoder().encode(r.text).length} / {bodyLimit(editor.api.resource)} bytes</span></div>
    {r.latest&&<aside className="conflict-panel"><h2>最新版と比較して解決</h2><p>最新版: 改訂 {r.latest.revision}。下の手入力は変更していません。</p><label htmlFor="latest-body">最新版の本文<textarea id="latest-body" value={r.latest.body} readOnly rows={7}/></label><ReferenceList references={r.latest.references} label="最新版の関連リンク"/><div className="actions"><button disabled={!!r.pending} onClick={()=>void editor.resolve(false)}>手入力を保持して解決</button><button className="secondary" disabled={!!r.pending} onClick={()=>void editor.resolve(true)}>最新版を採用</button></div><p>手入力を保持した場合は、内容を確認して保存してください。</p></aside>}
    {editor.api.resource.kind!=='comment'&&<label htmlFor="document-title">タイトル<input id="document-title" value={r.title??r.base?.title??''} onChange={e=>editor.inputTitle(e.target.value)} disabled={!view.ready||!canEdit}/></label>}
    <label className="body-label" htmlFor="issue-body">{r.latest?'手入力の本文':'本文'}<textarea id="issue-body" ref={textRef} value={r.text} onChange={e=>editor.input(e.target.value)} rows={12} disabled={!view.ready||!canEdit} spellCheck={false}/></label>
    {editor.api.resource.kind!=='comment'&&<ReferenceEditor source={r.base?.id??r.targetId} references={draftReferences(r)} onChange={values=>editor.inputReferences(values)} disabled={!view.ready||!canEdit}/> }
    {Object.entries(r.fields).map(([name,value])=><p className="field-error" role="alert" key={name}>{name}: {value}</p>)}
    <div className="actions"><button onClick={()=>void editor.save()} disabled={!view.ready||!canEdit||!!r.pending||!!r.latest||(!blankBodyAllowed(editor.api.resource)&&!r.text.trim())||(r.text===r.base?.body&&(r.title??'')===(r.base?.title??'')&&sameReferences(draftReferences(r),r.base?.references))}>{r.status==='saving'?'保存中…':'保存'}</button><button className="secondary" onClick={()=>void copy()}>入力をコピー</button><button className="secondary" onClick={download}>下書きをダウンロード</button>{r.base&&<button className="secondary" onClick={()=>void editor.refresh()}>最新版を再取得</button>}</div>
    {copyMessage&&<p role="status">{copyMessage}</p>}
    {!canEdit&&<p className="warning">このプロジェクトの編集権限がありません。</p>}
    {r.pending&&<details className="operation" open={r.status!=='saving'}><summary>進行中の操作 · 送信 {r.pending.attempts} / 4 回</summary><p className="issue-key">操作ID: <span data-testid="operation-id">{r.pending.operationId}</span></p><p>送信内容は固定しています。追加入力は上の本文に残ります。</p><pre>{r.pending.changes?JSON.stringify(r.pending.changes,null,2):r.pending.body}</pre><ReferenceList references={r.pending.references} label="固定した送信参照"/><div className="actions"><button className="secondary" disabled={r.status==='saving'||r.pending.phase==='rejected'} onClick={()=>void editor.recover()}>操作結果を確認</button>{['blocked','conflict'].includes(r.status)&&canView&&<button className="secondary" onClick={()=>void editor.continueAfterDenied()}>{r.pending.phase==='rejected'?'未反映の作成操作を終了して入力の修正を続ける':'未確定操作を保留して最新版で続ける'}</button>}{r.status==='blocked'&&r.pending.phase!=='rejected'&&r.pending.attempts<4&&<button className="secondary" onClick={()=>void editor.retrySameOperation()}>同じ操作を手動で再送</button>}</div></details>}
    {!!r.heldOperations?.length&&<details className="operation" open><summary>保持した操作の記録</summary><p>保存済みとは扱っていません。自動再送しません。現在の入力と別に、元の主体の下書きへ保持しています。</p>{r.heldOperations.map(op=><div key={op.operationId}><p>操作ID: {op.operationId} · 元の改訂: {op.revision}</p><pre>{op.changes?JSON.stringify(op.changes,null,2):op.body}</pre><ReferenceList references={op.references} label="保留した送信参照"/>{op.phase==='rejected'?<p>作成前に拒否され、未反映と確認済みです。</p>:<button className="secondary" onClick={()=>void editor.checkHeldOperation(op.operationId)}>保留した操作の結果を確認</button>}</div>)}</details>}
    {isIssue(r.base)&&r.base.schedule&&<IssueAttributes editor={editor} issue={r.base} identity={identity} zone={zone} disabled={!view.ready||!canView||!!r.pending||!!r.latest}/> }
    {r.base&&(editor.api.resource.kind==='issue'||r.base.metadata)&&<ImportedContext key={r.base.id} document={r.base} resource={editor.api.resource} draft={r.attributes} open={openContent} editor={editor} directory={directory} canEdit={view.ready&&canView&&canEdit&&!r.pending&&!r.latest}/> }
    {r.base&&editor.api.resource.kind==='issue'&&<IssueExecutionPanel key={identity.principal.id+':'+r.projectId+':'+r.base.id} api={editor.api} projectId={r.projectId} issueId={r.base.id} ownerId={identity.principal.id} zone={zone}/>}
    {r.base&&<details className="history"><summary onClick={()=>void history()}>更新履歴を確認</summary>{historyMessage&&<p role="status">{historyMessage}</p>}{historyLoading&&<p role="status">履歴を読み込み中…</p>}{historyAfter!==null&&<button className="secondary" disabled={historyLoading} onClick={()=>void history(true)}>続きを表示</button>}{events.map(e=><p key={e.revision} data-testid="resolution-event">改訂 {e.revision} · {e.kind==='resolved'?'解決':'再開'} · {displayTime(e.time,zone)}</p>)}{historyRows.map(h=><HistoryEntry key={h.revision} history={h} zone={zone}/>)}</details>}
    {r.base&&editor.api.resource.kind!=='comment'&&<ParentComments document={r.base} kind={editor.api.resource.kind} identity={identity} identityChanged={identityChanged} open={openContent} canEdit={canEdit}/>}
  </article>;
}
