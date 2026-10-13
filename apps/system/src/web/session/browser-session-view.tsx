// @module browser-session
// @role view
import type {useBrowserSessionController} from './browser-session-controller';

export function BrowserSessionView({model}:{model:ReturnType<typeof useBrowserSessionController>}){
const {nonce,ticket,setTicket,busy,message,identity,failed,prepare,redeem}=model;
return <main className="login-shell"><header className="app-header"><a className="brand" href="/">PROJEKTOR</a></header><section className="login-card"><h1>API主体でブラウザを開く</h1>{identity?<><p role="status">{identity.principal.displayName} · {identity.principal.id} で接続しました。</p><a href="/">作業画面へ</a></>:<><p>このブラウザのnonceを認証済みクライアントへ渡し、返された引換券を入力してください。</p>{nonce&&<label htmlFor="browser-nonce">ブラウザnonce<input id="browser-nonce" readOnly value={nonce}/></label>}<form onSubmit={event=>void redeem(event)}><label htmlFor="browser-ticket">引換券<input id="browser-ticket" type="password" autoComplete="off" spellCheck={false} value={ticket} onChange={event=>setTicket(event.target.value)} required pattern="[A-Za-z0-9_-]{43}"/></label><button disabled={busy||!nonce||failed}>{busy?'接続中…':'引換える'}</button></form>{failed&&<><button className="secondary" disabled={busy} onClick={()=>void prepare()}>新しい交換を準備</button><a href="/">現在のセッションを確認</a></>}</>}{message&&<p role="alert">{message}</p>}</section></main>;
}
