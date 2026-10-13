// @module verification
// @role browser-fixture
// Launch only: the release owner must have frozen the exact built artifacts first.
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../',import.meta.url)));
await import('./server.mjs');
