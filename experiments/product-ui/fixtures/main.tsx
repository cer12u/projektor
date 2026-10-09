/** TEST ENTRY ONLY. Same product adapter, visibly labeled synthetic fixture.
 * The test harness supplies /v1/bootstrap under the owner's exact wire contract.
 * No provider or key issuer is bundled in either UI entrypoint. */
import {createRoot} from 'react-dom/client';
import {App,Boundary} from '../src/App.tsx';
import {createProductPorts} from '../src/product-ports.ts';
import '../src/style.css';
const ports=createProductPorts({appAuth:false});
ports.evidence='contract-fixture';
createRoot(document.getElementById('root')!).render(<Boundary><App ports={ports}/></Boundary>);
