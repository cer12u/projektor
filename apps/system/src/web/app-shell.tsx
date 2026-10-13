// @module composition
// @role web-composition
import {Management} from './administration/index';
import {Workspace} from './workbench/index';
import {LoginForm} from './session/index';
import {useAppSession} from './session/index';
export function App(){
 const {identity,loading,busy,ready,message,attach,identityChanged,prepareLogin,reauth,login,logout}=useAppSession();
  return <main className={identity?'app-shell':'login-shell'}><header className="app-header"><a className="brand" href="/">PROJEKTOR</a>{identity&&<div className="account"><a href="/management">主体・権限管理</a><span>{identity.principal.displayName}<small>{identity.principal.kind==='human'?'人':'エージェント'} · {identity.principal.id}</small></span><button className="secondary" onClick={()=>void logout()} disabled={busy}>ログアウト</button></div>}</header>
    {loading?<p role="status">接続確認中…</p>:identity?location.pathname==='/management'?<Management key={identity.principal.id} identity={identity} identityChanged={identityChanged}/>:<Workspace key={identity.principal.id} identity={identity} reauth={reauth} identityChanged={identityChanged} onEditor={attach}/>:<LoginForm busy={busy} ready={ready} login={login} prepare={prepareLogin}/>}
    {message&&<p className="notice" role="alert">{message}</p>}
  </main>;
}