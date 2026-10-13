// @module administration
// @role composition
import {usePasswordSetupController} from './password-setup-controller';
import {useOwnerSetupController} from './owner-setup-controller';
import {PasswordSetupView} from './password-setup-view';
import {useRecipientSetupController} from './recipient-setup-controller';
import {RecipientSetupView} from './recipient-setup-view';
import {OwnerSetupView} from './owner-setup-view';
function LegacySetup(){return <PasswordSetupView model={usePasswordSetupController()} owner={useOwnerSetupController()}/>;}
function ContextSetup(){return <main className="login-shell"><header className="app-header"><a className="brand" href="/">PROJEKTOR</a></header><RecipientSetupView model={useRecipientSetupController()}/><OwnerSetupView model={useOwnerSetupController()}/></main>;}
export function PasswordSetup({legacy=false}:{legacy?:boolean}){return legacy?<LegacySetup/>:<ContextSetup/>;}
