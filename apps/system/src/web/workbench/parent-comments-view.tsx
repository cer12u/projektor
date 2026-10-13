// @module workbench
// @role view
import type {useParentCommentsController} from './parent-comments-controller';
import {scopeOf} from "../../modules/work/content-contracts";
import {ContentList} from './content-list';
export function ParentCommentsView({model}:{model:ReturnType<typeof useParentCommentsController>}){
const {document,open,canEdit,resource,api}=model;
return <section className="comments" aria-label="コメント"><div className="section-heading"><h2>コメント</h2><button disabled={!canEdit} onClick={()=>open(resource)}>新しいコメント</button></div><ContentList api={api} project={scopeOf(document)} epoch={document.revision} open={id=>open(resource,id)}/></section>;
}
