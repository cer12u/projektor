// @module composition
// @role web-composition
import {createRoot} from 'react-dom/client';
import {App} from './app-shell';
import {PasswordSetup,OwnerPasswordSetup} from './administration/index';
import {BrowserSession} from './session/index';
import './style.css';
const root=document.getElementById('root');
if(root)createRoot(root).render(location.pathname==='/password/setup/owner'?<OwnerPasswordSetup/>:location.pathname==='/password/setup/legacy'?<PasswordSetup legacy/>:location.pathname==='/password/setup'?<PasswordSetup/>:location.pathname==='/agent/session'?<BrowserSession/>:<App/>);
