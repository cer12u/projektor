// @module workbench
// @role view
import type {ContentHistory,HistoryIssueSnapshot} from "../../modules/work/content-contracts";
import {displayTime} from './planning-time';
import {ReferenceList} from './references';

const attributes=['priority','assigneeId','state','schedule','parentId','typeId'] as const;
type Attribute=typeof attributes[number];
const labels:Record<Attribute,string>={priority:'優先度',assigneeId:'担当',state:'状態',schedule:'予定',parentId:'親Issue',typeId:'種別'};
function attributeValue(snapshot:HistoryIssueSnapshot|null|undefined,field:Attribute,zone:string):string{
  const value=snapshot?.[field];
  if(value===undefined)return'記録なし';
  if(value===null)return'未設定';
  if(field==='schedule')return(['start','end','due'] as const).map(key=>`${{start:'開始',end:'終了',due:'期限'}[key]}: ${displayTime(snapshot?.schedule?.[key]??null,zone)}`).join(' · ');
  const scalar=typeof value==='string'||typeof value==='number'?String(value):'記録なし';
  if(field==='assigneeId'){
    const person=snapshot?.assignee;
    return person&&person.id===value?`${person.displayName} · ${person.kind==='human'?'人':'API主体'} · ${person.id}`:scalar;
  }
  return scalar;
}
export function HistoryEntry({history:h,zone}:{history:ContentHistory;zone:string}){
  return <div><p>改訂 {h.revision} · {h.actorName||h.actorId||'記録なし'}{h.actorId&&h.actorId!==h.actorName?' · '+h.actorId:''} · {h.kind}</p>
    {attributes.filter(field=>h.changedFields?.includes(field)).map(field=><section key={field} aria-label={labels[field]+'の変更'}><h3>{labels[field]}</h3><p>変更前: {attributeValue(h.before,field,zone)}</p><p>変更後: {attributeValue(h.after,field,zone)}</p></section>)}
    {h.beforeTitle!==undefined&&<p>旧タイトル: {h.beforeTitle??'（なし）'}</p>}{h.afterTitle!==undefined&&<p>新タイトル: {h.afterTitle}</p>}<p>更新前</p><pre>{h.beforeBody??'（新規作成）'}</pre><p>更新後</p><pre>{h.afterBody}</pre><ReferenceList references={h.beforeReferences} label="変更前の関連リンク"/><ReferenceList references={h.afterReferences} label="変更後の関連リンク"/>
  </div>;
}
