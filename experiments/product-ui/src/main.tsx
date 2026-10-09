import {createRoot} from 'react-dom/client';
import {App,Boundary} from './App.tsx';
import {SetupView} from './AuthView.tsx';
import {createProductPorts} from './product-ports.ts';
import './style.css';
// Explicit product service adapter. Missing or denied endpoints fail closed.
// No fixture issuer, global config injection or legacy endpoint fallback.
const ports=createProductPorts();
createRoot(document.getElementById('root')!).render(<Boundary>{window.location.pathname==='/setup'?<SetupView auth={ports.auth} onLogin={()=>window.location.replace('/')}/>:<App ports={ports}/>}</Boundary>);
