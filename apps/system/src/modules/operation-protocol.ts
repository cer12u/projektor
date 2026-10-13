// @module persistence
// @role wire-protocol
/** Correlates a preparation acknowledgment to its captured JSON request.
 * This is transport correlation only, never authority or durable recovery proof.
 * The sender must JSON-snapshot the value before awaiting and send that snapshot.
 * The receiver hashes the parsed object using the same JSON serialization. */
import type {OperationPreparation} from "./prepared-operations";
export async function operationRequestHash(value:OperationPreparation):Promise<string>{
 const bytes=new TextEncoder().encode(JSON.stringify(value));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
