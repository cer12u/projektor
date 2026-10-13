// @module tooling.build
// @role cleanup
// Only the owned generated Worker directory is removed. Source WASM is untouched.
import {rm} from 'node:fs/promises';
await rm(new URL('../../dist/worker/',import.meta.url),{recursive:true,force:true});
