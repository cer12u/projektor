// @module adapter.agent-file-credentials
// @role adapter
/** Optional filesystem facade only. Web-compatible clients receive injected loaders.
 * Existing explicit private-path checks are reused; no store or credential is created. */
import {privateJsonProvider} from "./private-json-file";
import type {CredentialEnvelope} from "../../modules/identity/credential-contracts";
export function privateFileProvider(privateRoot:string,path:string):()=>Promise<CredentialEnvelope>{
 const read=privateJsonProvider(privateRoot,path);return async()=>await read() as CredentialEnvelope;
}
/** Caller must separately authorize the selected store and real credential use. */
export const accessServiceFileProvider=privateJsonProvider;
