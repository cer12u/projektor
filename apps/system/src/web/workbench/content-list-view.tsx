// @module workbench
// @role view
import type {useContentListController} from './content-list-controller';

export function ContentListView({model}:{model:ReturnType<typeof useContentListController>}){
const {open,page,setPage,value,message,label}=model;
return <section className="content-list" aria-label={label+'一覧'}><h2>{label}一覧</h2>{message&&<p role="status">{message}</p>}{value&&<><p data-testid="content-count">{value.total} 件 · {page} / {Math.max(1,Math.ceil(value.total/value.pageSize))}</p>{value.documents.length===0?<p>{label}はまだありません。</p>:<ul>{value.documents.map(d=><li key={d.id}><button className="secondary content-preview" onClick={()=>open(d.id)}>{d.title||d.body.slice(0,100)||'（空の本文）'}</button><span>改訂 {d.revision} · {d.id.slice(0,14)}…</span></li>)}</ul>}<div className="actions"><button className="secondary" disabled={page<=1||!!message} onClick={()=>setPage(p=>p-1)}>前の{label}ページ</button><button className="secondary" disabled={page*value.pageSize>=value.total||!!message} onClick={()=>setPage(p=>p+1)}>次の{label}ページ</button></div></>}</section>;
}
