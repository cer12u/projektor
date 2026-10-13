// @module workbench
// @role view
import type {useWorkspaceController} from './workspace-controller';
import {contentIdPattern} from "../../modules/work/content-contracts";
import {ContentList} from './content-list';
import {MyIssues} from './my-issues';

import {EditorPanel} from './editor-panel';
export function WorkspaceView({model}:{model:ReturnType<typeof useWorkspaceController>}){
const {identity,identityChanged,allowed,directory,selection,editor,openId,setOpenId,listEpoch,api,issueApi,zone,setZone,canView,canEdit,visibleDrafts,choose,selectContent,selectProject,listDrafts,open,label}=model;
return <section className="workspace" aria-label="本文の作業領域">
    <nav className="workspace-nav" aria-label="本文を選ぶ"><label>プロジェクト<select value={selection.project} onChange={e=>selectProject(e.target.value)}>{!allowed.some(p=>p.id===selection.project)&&<option value={selection.project} disabled>{selection.project} · 閲覧権限なし</option>}{allowed.map(p=><option key={p.id} value={p.id}>{directory?.projects.find(v=>v.id===p.id)?.name??directory?.workspaces.find(v=>v.scopeId===p.id)?.name??p.id}{p.id.startsWith('workspace:')?' · workspace Wiki':''}</option>)}</select></label><button className="secondary" disabled={selection.project.startsWith('workspace:')} onClick={()=>selectContent({kind:'issue'})}>Issues</button><button className="secondary" onClick={()=>selectContent({kind:'wiki'})}>Wiki</button><button onClick={()=>selectContent(selection.resource)}>新しい{label}</button><button className="secondary" onClick={()=>void listDrafts()}>自分の下書き</button>
      <form onSubmit={open}><label htmlFor="issue-id">{label} ID</label><div className="inline"><input id="issue-id" value={openId} onChange={e=>setOpenId(e.target.value)} placeholder={api.prefix+'…'} pattern={contentIdPattern(api.resource)} required/><button className="secondary">開く</button></div></form>
    </nav>
    {visibleDrafts.length>0&&<aside className="draft-list"><h2>自分の下書き</h2>{visibleDrafts.map(d=><button className="secondary" key={d.targetId+d.unitId} onClick={()=>void choose(d.projectId,d.resource??{kind:'issue'},d.targetId,d.unitId)}>{d.resource?.kind??'issue'} · {d.targetId} · {d.unitId}</button>)}</aside>}
    {canView&&selection.resource.kind==='issue'&&<MyIssues api={issueApi} project={selection.project} open={id=>selectContent({kind:'issue'},id)} onZone={setZone}/>}
    {canView&&selection.resource.kind==='wiki'&&<ContentList api={api} project={selection.project} epoch={listEpoch} open={id=>selectContent(selection.resource,id)}/>}
    {canView&&selection.resource.kind==='comment'&&<><p className="parent-context">{selection.resource.parentKind==='issue'?'Issue':'Wiki'} · {selection.resource.parentId}<button className="secondary" onClick={()=>{const v=selection.resource;if(v.kind==='comment')selectContent({kind:v.parentKind},v.parentId);}}>親の本文へ戻る</button></p><ContentList api={api} project={selection.project} epoch={listEpoch} open={id=>selectContent(selection.resource,id)}/></>}
    {!canView?<p className="warning" role="alert">閲覧権限がないため、この作業領域の内容を非表示にしています。未保存の入力は元の主体の下書きに保持しています。</p>:editor?<EditorPanel directory={directory} editor={editor} identity={identity} zone={zone} canEdit={canEdit} identityChanged={identityChanged} openContent={selectContent}/>:<p role="status">編集状態を読み込み中…</p>}
  </section>;
}
