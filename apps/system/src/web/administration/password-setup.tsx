// @module administration
// @role composition
import {usePasswordSetupController} from './password-setup-controller';
import {useOwnerSetupController} from './owner-setup-controller';
import {PasswordSetupView} from './password-setup-view';
import {useRecipientSetupController} from './recipient-setup-controller';
import {RecipientSetupView} from './recipient-setup-view';
import {OwnerSetupView} from './owner-setup-view';
function LegacySetup(){return <PasswordSetupView model={usePasswordSetupController()}/>;}
function ContextSetup(){return <main className="login-shell"><header className="app-header"><a className="brand" href="/">PROJEKTOR</a></header><RecipientSetupView model={useRecipientSetupController()}/><p><a href="/password/setup/owner">所有者の初回設定へ</a></p></main>;}
export function PasswordSetup({legacy=false}:{legacy?:boolean}){return legacy?<LegacySetup/>:<ContextSetup/>;}

/** Separate top-level navigation allows interactive owner admission before scoped API calls. */
export function OwnerPasswordSetup(){return <main className="login-shell"><header className="app-header"><a className="brand" href="/">PROJEKTOR</a></header><OwnerSetupView model={useOwnerSetupController()}/><p><a href="/password/setup">通常のパスワード設定へ</a></p></main>;}
