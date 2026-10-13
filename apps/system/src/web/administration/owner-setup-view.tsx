// @module administration
// @role view
import type {useOwnerSetupController} from './owner-setup-controller';
export function OwnerSetupView({model}:{model:ReturnType<typeof useOwnerSetupController>}){
  const {operation,status,busy,unknown,canIssue,blocked,message,begin,recover,retryIssue,save}=model;
  return <section className="login-card"><h2>所有者の初回パスワード設定</h2>
    <p>設定前に、このブラウザへ短時間の保護された証明を用意します。端末に保持するのは秘密ではない操作IDだけです。</p>
    {!operation&&<button disabled={busy||blocked} onClick={()=>void begin()}>既存ログインで所有者の初回設定を開始</button>}
    {operation&&<><p className="issue-key">初回設定操作ID: {operation}</p>{status?.state!=='completed'&&<button className="secondary" disabled={busy} onClick={()=>void recover()}>初回設定の状態を確認</button>}</>}
    {canIssue&&<button disabled={busy} onClick={()=>void retryIssue()}>同じ操作IDで初回設定を開始する</button>}
    {status?.state==='ready'&&<><p>設定対象: {status.principalId}</p><p>期限: {new Date(status.expiresAt*1000).toLocaleString()}</p>
      <form onSubmit={event=>void save(event)} action="/api/auth/password-setup/owner-initial/complete" method="post">
        <label htmlFor="owner-new-password">新しいパスワード<input id="owner-new-password" name="password" type="password" autoComplete="new-password" required minLength={12}/></label>
        <label htmlFor="owner-confirm-password">確認用パスワード<input id="owner-confirm-password" name="confirm" type="password" autoComplete="new-password" required/></label>
        <p>12文字以上、1024 UTF-8 bytes以内。入力は端末へ保存しません。</p><button disabled={busy||unknown}>初回パスワードを設定</button>
      </form></>}
    {status?.state==='completed'&&<a href="/">ログインへ</a>}
    {message&&<p role="alert">{message}</p>}
  </section>;
}
