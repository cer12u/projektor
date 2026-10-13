// @module administration
// @role view
import type {Permission} from "../../modules/identity/dto";
import {managementPermissions,type ManagementHistory,type ManagementRecord} from './management-model';
import {permissionLabels,time} from './management-presentation';
export function PermissionInput({value,onChange,disabled}:{value:Permission[];onChange:(p:Permission[])=>void;disabled:boolean}){
 return <fieldset className="management-permissions" disabled={disabled}><legend>明示する権限</legend>{managementPermissions.map(p=><label key={p}><input type="checkbox" checked={value.includes(p)} onChange={e=>onChange(e.target.checked?[...value,p]:value.filter(v=>v!==p))}/>{permissionLabels[p]} <small>{p}</small></label>)}<p>権限は個別指定です。閲覧以外を使うには閲覧も必要です。すべて外すと、このProject / Workspaceの権限を取り消します。</p></fieldset>;
}

export function RecordSummary({record}:{record:ManagementRecord}){const s=record.snapshot;return <dl className="management-summary"><dt>固定主体ID</dt><dd>{s.principalId}</dd>{'credentialId'in s&&<><dt>固定資格ID</dt><dd>{s.credentialId}</dd></>}{'projectId'in s&&<><dt>対象Project / Workspace</dt><dd>{s.projectId}</dd></>}<dt>改訂</dt><dd>{s.revision}</dd>{'displayName'in s&&<><dt>表示名</dt><dd>{s.displayName}</dd><dt>種別 / 状態</dt><dd>{s.kind==='human'?'人':'Agent'} / {s.active===1?'有効':'無効'}</dd><dt>全体管理者属性</dt><dd>{s.globalAdministrator===1?'あり':'なし'}（表示のみ）</dd></>}{'expiresAt'in s&&<><dt>期限</dt><dd>{time(s.expiresAt)}</dd><dt>失効日時</dt><dd>{time(s.revokedAt)}</dd></>}{'permissions'in s&&<><dt>現在の明示権限</dt><dd>{s.permissions.map(p=>permissionLabels[p]).join('・')||'なし'}</dd></>}</dl>;}

export function InitialProjectHistory({projects}:{projects:NonNullable<ManagementHistory['initialProjects']>}){
 return <section aria-label="登録時の初期所属と権限"><h4>登録時に明示した所属と権限</h4>{projects.length===0?<p>所属なし</p>:<ul>{projects.map(p=><li key={p.projectId}><strong>{p.projectId}</strong>: {p.permissions.map(permission=>`${permissionLabels[permission]} (${permission})`).join('・')||'権限なし'}</li>)}</ul>}<p>登録時の記録です。現在の所属・権限は対象プロジェクトの管理画面で確認してください。</p></section>;
}
