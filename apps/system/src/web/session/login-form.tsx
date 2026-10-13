// @module browser-session
// @role view
import type {FormEvent} from 'react';
import type {LoginInput} from './session-contracts';
export function LoginForm({busy,ready,prepare,login}:{busy:boolean;ready:boolean;prepare:()=>void;login:(input:LoginInput,clear:()=>void)=>Promise<void>}) {
 function submit(event:FormEvent<HTMLFormElement>) {
  event.preventDefault();const form=event.currentTarget,data=new FormData(form);
  void login({loginId:data.get('username'),password:data.get('password')},()=>form.reset());
 }
 return <section className="login-card"><h1>ログイン</h1><p>Issueの作成と編集を続けるためにログインしてください。</p>{!ready&&<button className="secondary" onClick={prepare}>ログインを準備</button>}<form onSubmit={submit}><label htmlFor="username">ID<input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64}/></label><label htmlFor="password">パスワード<input id="password" name="password" type="password" autoComplete="current-password" required/></label><button type="submit" disabled={busy||!ready}>{busy?'ログイン中…':'ログイン'}</button></form></section>;
}
