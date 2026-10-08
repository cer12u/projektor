import {createRoot} from 'react-dom/client';
import {App,Boundary} from './App.tsx';
import {createProductPorts} from './product-ports.ts';
import './style.css';
// Explicit product service adapter. Missing or denied endpoints fail closed.
// No fixture issuer, global config injection or legacy endpoint fallback.
createRoot(document.getElementById('root')!).render(<Boundary><App ports={createProductPorts()}/></Boundary>);
